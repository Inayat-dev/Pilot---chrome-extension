import { getSettings, updatePrefs, clearHistory } from '../lib/storage.js';
import { getProvider } from '../lib/providers.js';
import { escapeHtml, describeAction, formatElapsed, detectExportIntent } from './format.js';
import { exportRunAsPdf, exportRunAsExcel } from './export.js';

const log = document.getElementById('log');
const emptyState = document.getElementById('emptyState');
const goalInput = document.getElementById('goalInput');
const runBtn = document.getElementById('runBtn');
const stopBtn = document.getElementById('stopBtn');
const copyBtn = document.getElementById('copyBtn');
const stepHint = document.getElementById('stepHint');
const providerDot = document.getElementById('providerDot');
const providerLabel = document.getElementById('providerLabel');
const settingsBtn = document.getElementById('settingsBtn');
const themeBtn = document.getElementById('themeBtn');
const approvalCheckbox = document.getElementById('approvalCheckbox');
const tabRunBtn = document.getElementById('tabRunBtn');
const tabHistoryBtn = document.getElementById('tabHistoryBtn');
const historyPanel = document.getElementById('historyPanel');
const historyList = document.getElementById('historyList');
const historyEmpty = document.getElementById('historyEmpty');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');
const toastStack = document.getElementById('toastStack');

settingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

let running = false;
let transcript = [];
let activeTab = 'run';

async function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

async function init() {
  const settings = await getSettings();
  applyTheme(settings.theme);
  approvalCheckbox.checked = !!settings.approvalMode;
  refreshProviderStatus();
  renderHistory(settings.history);
  await loadPendingGoal();
}

/** Picks up a goal stashed by the right-click context menu (background.js),
 *  so "Ask Pilot about…" actually lands in the composer instead of doing
 *  nothing until the panel happens to be reopened. */
async function loadPendingGoal() {
  try {
    const { pilotPendingGoal } = await chrome.storage.session.get('pilotPendingGoal');
    if (pilotPendingGoal) {
      goalInput.value = pilotPendingGoal;
      goalInput.focus();
      goalInput.setSelectionRange(goalInput.value.length, goalInput.value.length);
      await chrome.storage.session.remove('pilotPendingGoal');
    }
  } catch {
    // chrome.storage.session not available — nothing to prefill.
  }
}

// Keep the panel in sync when Settings changes providers/prefs, or when a
// run elsewhere updates history — previously this only ever happened once,
// on load, so picking a new provider in Settings didn't show up here until
// the side panel was closed and reopened.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.pilotSettings) return;
  const next = changes.pilotSettings.newValue || {};
  refreshProviderStatus();
  applyTheme(next.theme || 'light');
  approvalCheckbox.checked = !!next.approvalMode;
  if (activeTab === 'history') renderHistory(next.history);
});

themeBtn.addEventListener('click', async () => {
  const settings = await getSettings();
  const next = settings.theme === 'light' ? 'dark' : 'light';
  await updatePrefs({ theme: next });
  applyTheme(next);
});

approvalCheckbox.addEventListener('change', async () => {
  await updatePrefs({ approvalMode: approvalCheckbox.checked });
  showToast(approvalCheckbox.checked ? 'Pilot will ask before each step.' : 'Confirm-steps turned off.');
});

tabRunBtn.addEventListener('click', () => switchTab('run'));
tabHistoryBtn.addEventListener('click', () => switchTab('history'));

function switchTab(which) {
  activeTab = which;
  const isRun = which === 'run';
  tabRunBtn.classList.toggle('active', isRun);
  tabHistoryBtn.classList.toggle('active', !isRun);
  tabRunBtn.setAttribute('aria-selected', String(isRun));
  tabHistoryBtn.setAttribute('aria-selected', String(!isRun));
  log.hidden = !isRun;
  historyPanel.hidden = isRun;
  if (!isRun) getSettings().then((s) => renderHistory(s.history));
}

clearHistoryBtn.addEventListener('click', async () => {
  await clearHistory();
  renderHistory([]);
  showToast('History cleared.');
});

function renderHistory(history) {
  historyList.querySelectorAll('.history-item').forEach((el) => el.remove());
  historyEmpty.hidden = !!(history && history.length);
  for (const entry of history || []) {
    const el = document.createElement('div');
    el.className = 'history-item';
    const statusClass = entry.cancelled ? 'cancelled' : entry.ok ? 'ok' : 'err';
    const when = entry.startedAt ? new Date(entry.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    el.innerHTML = `
      <div class="history-item-head">
        <span class="history-status ${statusClass}"></span>
        <span class="history-goal">${escapeHtml(entry.goal || '')}</span>
        <span class="history-time">${escapeHtml(when)}</span>
      </div>
      <div class="history-summary">${escapeHtml(entry.summary || '')}</div>
      <div class="history-meta">${entry.steps || 0} step${entry.steps === 1 ? '' : 's'}</div>
    `;
    historyList.appendChild(el);
  }
}

async function refreshProviderStatus() {
  const settings = await getSettings();
  const providerId = settings.activeProvider;
  const meta = getProvider(providerId);
  const config = settings.providers?.[providerId];
  const hasKeys = providerId === 'ollama' || (config?.apiKeys?.length > 0);
  const configured = meta && config && hasKeys && config.model;

  providerDot.className = 'dot ' + (running ? 'busy' : configured ? 'ready' : 'error');

  let label = 'No provider configured — open Settings';
  if (configured) {
    label = `${meta.name} · ${config.model}`;
    // Multiple keys saved — show which one is currently active so a
    // mid-run switch (see the "note" lines in the log) is easy to place.
    if (providerId !== 'ollama' && config.apiKeys.length > 1) {
      const idx = Math.max(0, config.apiKeys.findIndex((k) => k.id === config.activeKeyId));
      label = `${meta.name} · key ${idx + 1}/${config.apiKeys.length} · ${config.model}`;
    }
  }
  providerLabel.textContent = label;
}

function addStep({ step, action, status }) {
  emptyState.remove();
  copyBtn.hidden = false;
  transcript.push({ step, action, status });

  let el = log.querySelector(`[data-step="${step}"]`);
  if (!el) {
    el = document.createElement('div');
    el.className = 'step';
    el.dataset.step = String(step);
    log.appendChild(el);
  }
  el.dataset.status = status || 'done';
  const detail = describeAction(action);
  const reason = action.reason ? `<div class="step-reason">${escapeHtml(action.reason)}</div>` : '';
  const approveRow = status === 'pending'
    ? `<div class="step-approve-row">
         <button class="btn btn-approve" data-decide="approve">Approve</button>
         <button class="btn btn-reject" data-decide="reject">Reject</button>
       </div>`
    : '';
  const statusTag = { pending: ' · waiting for you', blocked: ' · blocked for safety' }[status] || '';
  el.innerHTML = `
    <span class="step-num">${String(step).padStart(2, '0')}</span>
    <div class="step-body">
      <div class="step-action">${escapeHtml(action.type)}${statusTag}</div>
      <div class="step-detail">${escapeHtml(detail)}</div>
      ${reason}
      ${approveRow}
    </div>`;

  if (status === 'pending') {
    el.querySelector('[data-decide="approve"]').addEventListener('click', () => {
      chrome.runtime.sendMessage({ kind: 'pilot-decision', approved: true });
    });
    el.querySelector('[data-decide="reject"]').addEventListener('click', () => {
      chrome.runtime.sendMessage({ kind: 'pilot-decision', approved: false });
    });
  }

  log.scrollTop = log.scrollHeight;
  stepHint.textContent = status === 'pending' ? `step ${step} · needs approval` : `step ${step}`;
}

/** A one-line system note (e.g. "switched to backup key") — appended as its
 *  own small strip rather than folded into a numbered step, since it isn't
 *  an agent action and can land between steps or before the very first one. */
function addNote(text) {
  emptyState.remove();
  const el = document.createElement('div');
  el.className = 'log-note';
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function addResultBanner(ok, text) {
  emptyState.remove();
  const el = document.createElement('div');
  el.className = `result-banner ${ok ? 'ok' : 'err'}`;
  el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

/**
 * Richer completion card shown once a run finishes: an icon+title, step
 * count and elapsed time, and the model's summary. The result stays
 * chat-only UNLESS the goal itself asked for a file — "...and store in
 * pdf" / "...save as excel" (see detectExportIntent in format.js). The
 * format(s) named in the goal download automatically, so asking for it is
 * enough — no extra click needed. If the run also produced structured data
 * (a "get me X" task, not a general browsing task), the *other* format's
 * button is shown too — a table of extracted contact info is just as
 * useful as an Excel file as it is a PDF regardless of which word the goal
 * happened to use — but that one stays a manual click rather than an
 * unrequested download. `run` matches the shape documented at the top of
 * export.js.
 */
function addFinishBanner(run) {
  emptyState.remove();
  const tone = run.cancelled ? 'stopped' : run.ok ? 'ok' : 'err';
  const icon = run.cancelled ? '■' : run.ok ? '✓' : '!';
  const title = run.cancelled ? 'Stopped' : run.ok ? 'Task complete' : 'Could not finish';

  const metaBits = [];
  if (run.steps) metaBits.push(`${run.steps} step${run.steps === 1 ? '' : 's'}`);
  const elapsed = formatElapsed(run.elapsedMs);
  if (elapsed) metaBits.push(elapsed);

  const hasData = Array.isArray(run.data) && run.data.length > 0;
  const hasTranscript = Array.isArray(run.transcript) && run.transcript.length > 0;
  const hasContent = hasData || hasTranscript;
  const intent = detectExportIntent(run.goal);
  // Auto-download only the format(s) the goal actually named — no surprise
  // downloads of a format nobody asked for.
  const autoPdf = hasContent && intent.pdf;
  const autoExcel = hasContent && intent.excel;
  // But once the goal asked for *a* file and the run produced structured
  // data, offer both formats as buttons rather than hiding the other one —
  // "...save in pdf" and "...save in excel" are asking for the same
  // underlying result (get me this info), and a table of extracted data is
  // just as much an Excel file as a PDF regardless of which word was used.
  const requestedExport = intent.pdf || intent.excel;
  const wantsPdf = requestedExport && hasContent && (intent.pdf || hasData);
  const wantsExcel = requestedExport && hasContent && (intent.excel || hasData);

  const el = document.createElement('div');
  el.className = `result-banner ${tone}`;
  el.innerHTML = `
    <div class="result-head">
      <span class="result-icon">${icon}</span>
      <span class="result-title">${escapeHtml(title)}</span>
      ${metaBits.length ? `<span class="result-meta">${escapeHtml(metaBits.join(' · '))}</span>` : ''}
    </div>
    ${run.summary ? `<div class="result-summary">${escapeHtml(run.summary)}</div>` : ''}
    ${hasData ? `<div class="result-data-note">${run.data.length} row${run.data.length === 1 ? '' : 's'} of data collected.</div>` : ''}
    ${(wantsPdf || wantsExcel) ? `
      <div class="result-actions">
        ${wantsPdf ? '<button type="button" class="btn btn-ghost result-export-pdf">Download PDF</button>' : ''}
        ${wantsExcel ? '<button type="button" class="btn btn-ghost result-export-excel">Download Excel</button>' : ''}
      </div>` : ''}
  `;

  if (wantsPdf) {
    el.querySelector('.result-export-pdf').addEventListener('click', () => {
      try { exportRunAsPdf(run); } catch (e) { showToast(`Could not create PDF — ${e.message || e}`); }
    });
  }
  if (wantsExcel) {
    el.querySelector('.result-export-excel').addEventListener('click', () => {
      try { exportRunAsExcel(run); } catch (e) { showToast(`Could not create Excel file — ${e.message || e}`); }
    });
  }

  log.appendChild(el);
  log.scrollTop = log.scrollHeight;

  // The goal asked for a file, so create it right away instead of making
  // the user click Download too — "get all info about this video and
  // store in pdf" means the pdf should exist once the run is done. If the
  // run also produced data and a second format button is being offered
  // (see wantsPdf/wantsExcel above), that one stays a manual click — only
  // download the format(s) actually named in the goal automatically.
  if (autoPdf) {
    try { exportRunAsPdf(run); } catch (e) { showToast(`Could not create PDF — ${e.message || e}`); }
  }
  if (autoExcel) {
    try { exportRunAsExcel(run); } catch (e) { showToast(`Could not create Excel file — ${e.message || e}`); }
  }
}

function showToast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  toastStack.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function setRunning(next) {
  running = next;
  runBtn.hidden = next;
  stopBtn.hidden = !next;
  goalInput.disabled = next;
  refreshProviderStatus();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.kind === 'pilot-step') addStep(msg);
  if (msg?.kind === 'pilot-note') addNote(msg.text);
});

function resetLog() {
  log.innerHTML = '';
  log.appendChild(emptyState);
  copyBtn.hidden = true;
}

runBtn.addEventListener('click', async () => {
  const goal = goalInput.value.trim();
  if (!goal) return;

  // Every previous run's steps stayed in the DOM here, keyed by step number
  // — so a second run's "step 1" found and silently overwrote the first
  // run's "step 1" element instead of starting fresh, while any of its
  // later steps lingered on screen too. Clearing before each run fixes it;
  // past runs are still reviewable in the History tab.
  resetLog();
  transcript = [];

  const settings = await getSettings();
  const providerId = settings.activeProvider;
  const config = settings.providers?.[providerId];
  const hasKeys = providerId === 'ollama' || (config?.apiKeys?.length > 0);
  if (!config || !hasKeys) {
    addResultBanner(false, 'No provider configured. Click the gear icon to set one up.');
    return;
  }

  setRunning(true);
  stepHint.textContent = 'starting…';

  chrome.runtime.sendMessage({ kind: 'pilot-run', goal }, (response) => {
    setRunning(false);
    if (chrome.runtime.lastError) {
      addResultBanner(false, chrome.runtime.lastError.message);
      return;
    }
    addFinishBanner({
      goal,
      ok: !!response?.ok,
      cancelled: !!response?.cancelled,
      summary: response?.result?.summary || response?.error || (response?.ok ? 'Done.' : 'Something went wrong.'),
      steps: response?.result?.steps || transcript.length || 0,
      elapsedMs: response?.elapsedMs,
      data: response?.result?.data,
      transcript: [...transcript],
      finishedAt: Date.now(),
    });
    stepHint.textContent = '';
  });
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ kind: 'pilot-stop' });
});

copyBtn.addEventListener('click', async () => {
  const lines = transcript.map((t) => `${t.step}. ${t.action.type} — ${describeAction(t.action)}`);
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    showToast('Transcript copied.');
  } catch {
    showToast('Could not copy — clipboard permission denied.');
  }
});

goalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    runBtn.click();
  }
});

init();
