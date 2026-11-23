import { PROVIDERS, listOllamaModels, testProviderConnection, describeKeyStatus } from '../lib/providers.js';
import {
  getSettings, saveSettings, updateProvider, setActiveProvider, updatePrefs,
  addProviderKey, removeProviderKey, updateProviderKeyLabel, resetProviderKeyStatus,
} from '../lib/storage.js';

const list = document.getElementById('providerList');
const cloudTpl = document.getElementById('cloudCardTpl');
const ollamaTpl = document.getElementById('ollamaCardTpl');

const approvalCheckbox = document.getElementById('approvalCheckbox');
const maxStepsInput = document.getElementById('maxStepsInput');
const stepDelayInput = document.getElementById('stepDelayInput');
const fastModeCheckbox = document.getElementById('fastModeCheckbox');
const requestTimeoutInput = document.getElementById('requestTimeoutInput');
const themeSegmented = document.getElementById('themeSegmented');
const blockedSitesInput = document.getElementById('blockedSitesInput');
const blockedSitesSaveBtn = document.getElementById('blockedSitesSaveBtn');
const blockedSitesStatus = document.getElementById('blockedSitesStatus');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const importFileInput = document.getElementById('importFileInput');
const backupStatus = document.getElementById('backupStatus');

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function maskKey(key) {
  const k = key || '';
  if (k.length <= 8) return '•'.repeat(Math.max(4, k.length));
  return `${k.slice(0, 4)}${'•'.repeat(6)}${k.slice(-4)}`;
}

async function renderBehavior() {
  const settings = await getSettings();
  document.documentElement.setAttribute('data-theme', settings.theme);
  approvalCheckbox.checked = !!settings.approvalMode;
  maxStepsInput.value = settings.maxSteps;
  stepDelayInput.value = settings.stepDelay;
  fastModeCheckbox.checked = !!settings.fastMode;
  requestTimeoutInput.value = Math.round((settings.requestTimeoutMs || 25000) / 1000);
  themeSegmented.querySelectorAll('.segment').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.theme === settings.theme);
  });
  blockedSitesInput.value = (settings.blockedSites || []).join('\n');
}

blockedSitesSaveBtn.addEventListener('click', async () => {
  const sites = blockedSitesInput.value
    .split('\n')
    .map((s) => s.trim().replace(/^https?:\/\//i, '').split('/')[0])
    .filter(Boolean);
  await updatePrefs({ blockedSites: sites });
  blockedSitesInput.value = sites.join('\n');
  blockedSitesStatus.hidden = false;
  blockedSitesStatus.className = 'status-line ok';
  blockedSitesStatus.textContent = sites.length ? `Saved — ${sites.length} site(s) blocked.` : 'Saved — no custom sites blocked.';
  setTimeout(() => { blockedSitesStatus.hidden = true; }, 2500);
});

approvalCheckbox.addEventListener('change', async () => {
  await updatePrefs({ approvalMode: approvalCheckbox.checked });
});

maxStepsInput.addEventListener('change', async () => {
  const val = Math.min(50, Math.max(1, parseInt(maxStepsInput.value, 10) || 12));
  maxStepsInput.value = val;
  await updatePrefs({ maxSteps: val });
});

stepDelayInput.addEventListener('change', async () => {
  const val = Math.min(5000, Math.max(0, parseInt(stepDelayInput.value, 10) || 0));
  stepDelayInput.value = val;
  await updatePrefs({ stepDelay: val });
});

fastModeCheckbox.addEventListener('change', async () => {
  await updatePrefs({ fastMode: fastModeCheckbox.checked });
});

requestTimeoutInput.addEventListener('change', async () => {
  const secs = Math.min(60, Math.max(5, parseInt(requestTimeoutInput.value, 10) || 25));
  requestTimeoutInput.value = secs;
  await updatePrefs({ requestTimeoutMs: secs * 1000 });
});

themeSegmented.addEventListener('click', async (e) => {
  const btn = e.target.closest('.segment');
  if (!btn) return;
  const theme = btn.dataset.theme;
  document.documentElement.setAttribute('data-theme', theme);
  themeSegmented.querySelectorAll('.segment').forEach((b) => b.classList.toggle('active', b === btn));
  await updatePrefs({ theme });
});

exportBtn.addEventListener('click', async () => {
  const settings = await getSettings();
  const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pilot-settings-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

importBtn.addEventListener('click', () => importFileInput.click());

importFileInput.addEventListener('change', async () => {
  const file = importFileInput.files?.[0];
  importFileInput.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Not a valid settings file.');
    await saveSettings({ ...(await getSettings()), ...parsed });
    backupStatus.hidden = false;
    backupStatus.className = 'status-line ok';
    backupStatus.textContent = 'Settings imported.';
    await renderBehavior();
    await render();
  } catch (e) {
    backupStatus.hidden = false;
    backupStatus.className = 'status-line err';
    backupStatus.textContent = `Could not import — ${e.message}`;
  }
  setTimeout(() => { backupStatus.hidden = true; }, 3500);
});

async function render() {
  const settings = await getSettings();
  list.innerHTML = '';

  for (const meta of PROVIDERS) {
    const config = settings.providers?.[meta.id] || (meta.onDevice ? {} : { apiKeys: [], activeKeyId: null });
    const isActive = settings.activeProvider === meta.id;
    const node = meta.onDevice ? buildOllamaCard(meta, config, isActive) : buildCloudCard(meta, config, isActive);
    list.appendChild(node);
  }
}

function buildKeyRow(providerId, entry, idx, isActive) {
  const row = document.createElement('div');
  row.className = 'key-row' + (isActive ? ' key-row-active' : '');
  const status = describeKeyStatus(entry);
  row.innerHTML = `
    <span class="key-status-dot ${status.tone}" title="${escapeHtml(status.label)}"></span>
    <input type="text" class="keyLabelInput" value="${escapeHtml(entry.label || '')}" placeholder="Key ${idx + 1}" autocomplete="off" spellcheck="false" />
    <span class="key-masked" title="${escapeHtml(status.label)}">${escapeHtml(maskKey(entry.key))}</span>
    <span class="key-status-text ${status.tone}">${escapeHtml(status.label)}</span>
    <button type="button" class="key-test-btn">Test</button>
    <button type="button" class="key-remove-btn">Remove</button>
  `;

  const labelInput = row.querySelector('.keyLabelInput');
  labelInput.addEventListener('change', async () => {
    await updateProviderKeyLabel(providerId, entry.id, labelInput.value);
  });

  const testBtn = row.querySelector('.key-test-btn');
  const statusText = row.querySelector('.key-status-text');
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testBtn.textContent = '…';
    const res = await testProviderConnection(providerId, { apiKey: entry.key });
    testBtn.disabled = false;
    testBtn.textContent = 'Test';
    statusText.textContent = res.message;
    statusText.className = `key-status-text ${res.ok ? 'ok' : 'err'}`;
  });

  row.querySelector('.key-remove-btn').addEventListener('click', async () => {
    await removeProviderKey(providerId, entry.id);
    render();
  });

  return row;
}

function buildCloudCard(meta, config, isActive) {
  const node = cloudTpl.content.cloneNode(true);
  const card = node.querySelector('.card');
  node.querySelector('.dot').classList.toggle('active', isActive);
  node.querySelector('.card-title').textContent = meta.name;
  node.querySelector('.docs-link').href = meta.docsUrl;

  const apiKeys = config.apiKeys || [];
  const keyListEl = node.querySelector('.key-list');
  if (!apiKeys.length) {
    const empty = document.createElement('p');
    empty.className = 'key-empty';
    empty.textContent = 'No keys yet — add one below.';
    keyListEl.appendChild(empty);
  } else {
    apiKeys.forEach((entry, idx) => {
      keyListEl.appendChild(buildKeyRow(meta.id, entry, idx, entry.id === config.activeKeyId && apiKeys.length > 1));
    });
  }

  const newKeyInput = node.querySelector('.newKeyInput');
  const newKeyLabelInput = node.querySelector('.newKeyLabelInput');
  node.querySelector('.addKeyBtn').addEventListener('click', async () => {
    const val = newKeyInput.value.trim();
    if (!val) return;
    await addProviderKey(meta.id, val, newKeyLabelInput.value);
    render();
  });

  const modelInput = node.querySelector('.modelInput');
  const statusLine = node.querySelector('.status-line');
  modelInput.value = config.model || meta.defaultModel;
  modelInput.placeholder = meta.defaultModel;

  const useBtn = node.querySelector('.useBtn');
  useBtn.textContent = isActive ? 'In use' : 'Use this provider';
  useBtn.classList.toggle('active', isActive);
  useBtn.addEventListener('click', async () => {
    if (!apiKeys.length) {
      statusLine.hidden = false;
      statusLine.className = 'status-line err';
      statusLine.textContent = 'Add at least one API key first.';
      return;
    }
    await updateProvider(meta.id, { model: modelInput.value.trim() || meta.defaultModel });
    await setActiveProvider(meta.id);
    render();
  });

  node.querySelector('.testAllBtn').addEventListener('click', async () => {
    if (!apiKeys.length) return;
    statusLine.hidden = false;
    statusLine.className = 'status-line';
    statusLine.textContent = 'Testing all keys…';
    let okCount = 0;
    for (const entry of apiKeys) {
      const res = await testProviderConnection(meta.id, { apiKey: entry.key });
      if (res.ok) okCount++;
    }
    statusLine.className = `status-line ${okCount ? 'ok' : 'err'}`;
    statusLine.textContent = `${okCount}/${apiKeys.length} key(s) verified.`;
  });

  node.querySelector('.resetKeysBtn').addEventListener('click', async () => {
    await resetProviderKeyStatus(meta.id);
    statusLine.hidden = false;
    statusLine.className = 'status-line ok';
    statusLine.textContent = 'Key status reset — Pilot will try every key fresh.';
    render();
  });

  node.querySelector('.saveBtn').addEventListener('click', async () => {
    await updateProvider(meta.id, { model: modelInput.value.trim() || meta.defaultModel });
    flash(card);
  });

  return node;
}

function buildOllamaCard(meta, config, isActive) {
  const node = ollamaTpl.content.cloneNode(true);
  const card = node.querySelector('.card');
  node.querySelector('.dot').classList.toggle('active', isActive);

  const baseUrlInput = node.querySelector('.baseUrlInput');
  const modelSelect = node.querySelector('.modelSelect');
  const statusLine = node.querySelector('.status-line');
  baseUrlInput.value = config.baseUrl || meta.defaultBaseUrl;

  const currentModel = config.model || meta.defaultModel;
  addOption(modelSelect, currentModel, true);

  const useBtn = node.querySelector('.useBtn');
  useBtn.textContent = isActive ? 'In use' : 'Use this provider';
  useBtn.classList.toggle('active', isActive);
  useBtn.addEventListener('click', async () => {
    await updateProvider(meta.id, {
      baseUrl: baseUrlInput.value.trim() || meta.defaultBaseUrl,
      model: modelSelect.value || meta.defaultModel,
    });
    await setActiveProvider(meta.id);
    render();
  });

  node.querySelector('.testBtn').addEventListener('click', async () => {
    statusLine.hidden = false;
    statusLine.className = 'status-line';
    statusLine.textContent = 'Checking…';
    try {
      const models = await listOllamaModels(baseUrlInput.value.trim() || meta.defaultBaseUrl);
      statusLine.className = 'status-line ok';
      statusLine.textContent = models.length
        ? `Connected — ${models.length} model(s) pulled.`
        : 'Connected, but no models pulled yet. Run "ollama pull llama3.2:1b".';
      modelSelect.innerHTML = '';
      if (models.length === 0) {
        addOption(modelSelect, currentModel, true);
      } else {
        for (const name of models) addOption(modelSelect, name, name === currentModel);
      }
    } catch (e) {
      statusLine.className = 'status-line err';
      statusLine.textContent = `Can't connect — is "ollama serve" running? (${e.message})`;
    }
  });

  node.querySelector('.saveBtn').addEventListener('click', async () => {
    await updateProvider(meta.id, {
      baseUrl: baseUrlInput.value.trim() || meta.defaultBaseUrl,
      model: modelSelect.value || meta.defaultModel,
    });
    flash(card);
  });

  return node;
}

function addOption(select, value, selected) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = value;
  opt.selected = selected;
  select.appendChild(opt);
}

function flash(card) {
  card.style.borderColor = 'var(--teal)';
  setTimeout(() => { card.style.borderColor = ''; }, 700);
}

renderBehavior();
render();
