import { runAgent } from './lib/agent.js';
import { getSettings, addHistoryEntry, effectiveTimeoutMs, effectiveMaxTokens } from './lib/storage.js';
import { checkUrl, blockedMessage, isRestrictedUrl } from './lib/guardrails.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  setupContextMenus();
});

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'pilot-open-page',
      title: 'Open Pilot for this page',
      contexts: ['page', 'action'],
    });
    chrome.contextMenus.create({
      id: 'pilot-ask-selection',
      title: 'Ask Pilot about “%s”',
      contexts: ['selection'],
    });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  // sidePanel.open() must be the first thing called, synchronously, off the
  // click — any `await` before it (even a fast storage write) can lose the
  // user-gesture token on some Chrome versions and silently no-op.
  chrome.sidePanel.open({ tabId: tab.id, windowId: tab.windowId }).catch(() => {});

  let pendingGoal = '';
  if (info.menuItemId === 'pilot-ask-selection' && info.selectionText) {
    pendingGoal = `Regarding the selected text "${info.selectionText.slice(0, 200)}": `;
  }
  chrome.storage.session.set({ pilotPendingGoal: pendingGoal }).catch(() => {
    // storage.session unavailable (older Chrome) — panel still opens, just
    // won't be pre-filled.
  });
});

// The (command, tab) signature (Chrome 96+) gives the active tab directly —
// avoids an `await chrome.tabs.query(...)` before sidePanel.open(), which
// would risk losing the user-gesture context from the keyboard shortcut.
chrome.commands?.onCommand.addListener((command, tab) => {
  if (command !== 'open-pilot' || !tab?.id) return;
  chrome.sidePanel.open({ tabId: tab.id, windowId: tab.windowId }).catch(() => {});
});

let activeRun = null; // { tabId, cancelled, resolveApproval }

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.kind === 'pilot-run') {
    handleRun(msg.goal, sendResponse);
    return true; // async
  }
  if (msg?.kind === 'pilot-stop') {
    if (activeRun) {
      activeRun.cancelled = true;
      activeRun.resolveApproval?.(false);
    }
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.kind === 'pilot-decision') {
    if (activeRun?.resolveApproval) {
      activeRun.resolveApproval(!!msg.approved);
      activeRun.resolveApproval = null;
    }
    sendResponse({ ok: true });
    return true;
  }
});

async function handleRun(goal, sendResponse) {
  const startedAt = Date.now();
  let tabId = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab');
    tabId = tab.id;

    // Chrome never allows content scripts on chrome://, chrome-extension://,
    // etc. — messaging one of these always fails with the confusing "Could
    // not establish connection" error. Catch it here with a message that
    // actually says what to do instead.
    if (isRestrictedUrl(tab.url)) {
      throw new Error('Pilot can\'t act on this page — switch to a normal website tab (not a browser or extension page like Settings/New Tab) and try again.');
    }

    const settings = await getSettings();
    const providerId = settings.activeProvider;
    const providerConfig = settings.providers?.[providerId];
    const hasCloudKey = providerId !== 'ollama' && (providerConfig?.apiKeys?.length > 0);
    if (!providerConfig || (providerId !== 'ollama' && !hasCloudKey)) {
      throw new Error('No provider configured. Open Settings and set one up first.');
    }

    // Safety guardrail: refuse outright on banking/crypto/adult/piracy sites
    // and on anything the user's added to their own blocklist, regardless of
    // approval mode — the same "hard block" pattern Claude in Chrome and
    // Comet use, since a prompt-injected page is the main real-world risk
    // for an agent that's logged into a sensitive site.
    const guard = checkUrl(tab.url, settings.blockedSites);
    if (guard.blocked) throw new Error(blockedMessage(guard));

    activeRun = { tabId: tab.id, cancelled: false, resolveApproval: null };
    setBadge(tabId, '…', '#1a73e8');

    const result = await runAgent({
      tabId: tab.id,
      goal,
      providerId,
      providerConfig,
      maxSteps: settings.maxSteps,
      stepDelay: settings.stepDelay,
      approvalMode: settings.approvalMode,
      blockedSites: settings.blockedSites,
      timeoutMs: effectiveTimeoutMs(settings),
      maxTokens: effectiveMaxTokens(settings),
      onStep: (stepInfo) => {
        chrome.runtime.sendMessage({ kind: 'pilot-step', ...stepInfo }).catch(() => {});
        if (stepInfo.step) setBadge(tabId, String(stepInfo.step), stepInfo.status === 'error' ? '#d93025' : '#1a73e8');
        if (activeRun?.cancelled) throw new Error('__cancelled__');
      },
      onNote: (text) => {
        chrome.runtime.sendMessage({ kind: 'pilot-note', text }).catch(() => {});
      },
      requestApproval: () => new Promise((resolve) => {
        if (!activeRun) { resolve(false); return; }
        activeRun.resolveApproval = resolve;
      }),
      highlight: (tid, targetId) => new Promise((resolve) => {
        chrome.tabs.sendMessage(tid, { kind: 'pilot-highlight', targetId }, () => resolve());
      }),
    });

    const cancelled = !!result.cancelled;
    const ok = !result.failed && !cancelled;
    if (cancelled) {
      setBadge(tabId, '', '#5f6368');
    } else {
      setBadge(tabId, ok ? '✓' : '!', ok ? '#188038' : '#d93025', true);
    }

    await addHistoryEntry({
      goal,
      ok,
      cancelled,
      summary: result.summary,
      steps: result.steps || 0,
      startedAt,
      finishedAt: Date.now(),
    });

    sendResponse({ ok, cancelled, result, elapsedMs: Date.now() - startedAt });
  } catch (e) {
    const cancelled = e?.message === '__cancelled__';
    const errorMsg = cancelled ? 'Stopped by you.' : (e?.message || String(e));
    if (tabId != null) setBadge(tabId, cancelled ? '' : '!', '#d93025', !cancelled);
    await addHistoryEntry({
      goal,
      ok: false,
      cancelled,
      summary: errorMsg,
      steps: 0,
      startedAt,
      finishedAt: Date.now(),
    });
    sendResponse({ ok: false, cancelled, error: errorMsg, elapsedMs: Date.now() - startedAt });
  } finally {
    activeRun = null;
  }
}

/** Small toolbar-icon badge (like a mini native Chrome extension counter) so
 *  run progress/outcome is visible even with the side panel out of focus.
 *  Clears itself a few seconds after a run finishes. */
function setBadge(tabId, text, color, autoclear = false) {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  if (autoclear) {
    setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 4000);
  }
}
