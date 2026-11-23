import { callProviderChat } from './providers.js';
import { checkUrl, blockedMessage } from './guardrails.js';

const DEFAULT_MAX_STEPS = 12;
const MAX_PARSE_RETRIES = 2; // extra attempts after the first, before giving up

const SYSTEM_PROMPT = `You control a web browser tab. Each turn you get the page's title, URL, and a numbered list of visible interactive elements. Reply with ONE JSON object only, no prose, matching this schema:
{"type":"click"|"type"|"scroll"|"navigate"|"wait"|"finish","targetId"?:number,"text"?:string,"direction"?:"up"|"down","url"?:string,"summary"?:string,"reason"?:string,"data"?:object[]}
Rules:
- "type" requires targetId (element to focus) and text.
- "click" requires targetId.
- "navigate" requires a full url.
- Include a short "reason" (under 12 words) explaining the step in plain language.
- Use "finish" with a short "summary" once the task is done or impossible.
- If the task asks you to collect, list, or extract info (e.g. products, search results, contact details, prices), include a "data" array in the "finish" action: one flat object per item, using the SAME keys in every object (e.g. [{"name":"...","price":"..."},{"name":"...","price":"..."}]). Keep the fields to what the task actually asked for — e.g. "find the contact info" means name/email/phone, NOT the submit button's label, a newsletter signup box, or footer links, even if those are visible on the same page. This lets the result be exported as a spreadsheet. Omit "data" for tasks that aren't about collecting info.
- Never invent a targetId that isn't in the element list.`;

const RETRY_NUDGE = 'Your last reply was not a single valid JSON object matching the schema. Reply again with ONLY the JSON object — no prose, no markdown code fences, no explanation before or after it.';
// Used instead of RETRY_NUDGE when the reply wasn't malformed/truncated
// JSON but a wall of reasoning prose that never got to the JSON at all
// (reasoning models like Nemotron/DeepSeek/o-series occasionally do this
// even when told not to) — a generic "reply wasn't valid JSON" nudge reads,
// to a reasoning model, as "explain more clearly", which just produces more
// prose. This one says explicitly: stop analyzing, answer now.
const REASONING_NUDGE = 'Stop reasoning/explaining — your last reply was analysis text, not the action. Skip straight to the answer: reply with ONLY the JSON object now, nothing before or after it.';

/** True when `raw` looks like it never got anywhere near the JSON object at
 *  all (a reasoning model's chain-of-thought, cut off by the token limit)
 *  rather than JSON that started but got truncated. Used only to pick the
 *  more effective of the two retry nudges above — parseAction's own
 *  recovery attempts (salvage / closeTruncatedJson) still run regardless. */
function looksLikeReasoningProse(raw) {
  const text = String(raw || '').trim();
  if (!text) return false;
  const firstBrace = text.indexOf('{');
  // JSON opens within the first few characters (maybe a stray "```json\n"
  // fence before it) → treat as truncated JSON, not prose, even if long.
  if (firstBrace !== -1 && firstBrace < 15) return false;
  // Long text with no '{' at all, or a '{' only after a long prose runway,
  // is a reasoning model still mid-thought when it got cut off.
  return text.length > 120 && (firstBrace === -1 || firstBrace > 120);
}

function formatSnapshot(snapshot) {
  const lines = snapshot.elements.map((e) => `${e.id}: [${e.role}] ${e.label}`.trim());
  return `URL: ${snapshot.url}\nTitle: ${snapshot.title}\nElements:\n${lines.join('\n') || '(none found)'}`;
}

/**
 * Runs the agent loop against one tab.
 * `onStep(stepInfo)` fires after each committed step for live UI updates.
 * `requestApproval(stepInfo)` — if provided and `approvalMode` is true, is
 * awaited before any non-"finish" action executes; should resolve to a
 * boolean. Rejecting stops the run cleanly instead of throwing.
 * `blockedSites` — user-added domains (on top of the built-in guardrails in
 * lib/guardrails.js) the agent must refuse to navigate into mid-run.
 * `timeoutMs` / `maxTokens` tune each provider call for speed vs. budget
 * (see Fast mode in Settings) — passed straight through to
 * lib/providers.js's callProviderChat.
 * `onNote(text)` — optional; fires when the provider call transparently
 * switched to a different saved API key mid-run (see lib/providers.js).
 * Resolves to `{ done, summary, steps, data?, cancelled?, failed? }` —
 * `data`, when present, is the flat-object array the model chose to
 * extract for a "collect this info" style task (see SYSTEM_PROMPT), meant
 * for the PDF/Excel export buttons in the side panel.
 */
export async function runAgent({
  tabId,
  goal,
  providerId,
  providerConfig,
  maxSteps = DEFAULT_MAX_STEPS,
  stepDelay = 0,
  approvalMode = false,
  blockedSites = [],
  timeoutMs,
  maxTokens,
  onStep,
  onNote,
  requestApproval,
  highlight,
}) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Task: ${goal}` },
  ];

  for (let step = 0; step < maxSteps; step++) {
    const snapshot = await sendToTab(tabId, { kind: 'pilot-snapshot' });
    if (!snapshot?.ok) throw new Error(snapshot?.error || 'Could not read the page');

    messages.push({ role: 'user', content: formatSnapshot(snapshot.data) });

    const stepNum = step + 1;
    const { action, failed } = await getNextAction(providerId, providerConfig, messages, {
      timeoutMs,
      maxTokens,
      onRotate: onNote,
    });

    if (failed) {
      // The model never produced valid JSON, even after retries — this is a
      // genuine failure, not a normal "task done" finish, so it must not be
      // shown to the user the same way. Surfacing it as a fake "done" is
      // exactly what made runs look like they silently gave up after step 1.
      onStep?.({ step: stepNum, action: { type: 'error', reason: action.summary }, url: snapshot.data.url, status: 'error' });
      return { done: false, summary: action.summary, steps: stepNum, failed: true };
    }

    messages.push({ role: 'assistant', content: JSON.stringify(action) });

    if (action.type !== 'finish' && approvalMode && requestApproval) {
      onStep?.({ step: stepNum, action, url: snapshot.data.url, status: 'pending' });
      if (action.targetId != null) await highlight?.(tabId, action.targetId);
      const approved = await requestApproval({ step: stepNum, action });
      if (!approved) {
        onStep?.({ step: stepNum, action, url: snapshot.data.url, status: 'rejected' });
        return { done: false, cancelled: true, summary: `Stopped before step ${stepNum} — action rejected.` };
      }
    }

    if (action.type === 'finish') {
      onStep?.({ step: stepNum, action, url: snapshot.data.url, status: 'done' });
      return { done: true, summary: action.summary || 'Done.', steps: stepNum, data: normalizeData(action.data) };
    }

    if (action.type === 'navigate') {
      const guard = checkUrl(action.url, blockedSites);
      if (guard.blocked) {
        const note = blockedMessage(guard);
        onStep?.({ step: stepNum, action: { ...action, reason: note }, url: snapshot.data.url, status: 'blocked' });
        messages.push({ role: 'user', content: `${note} Choose a different step, or finish.` });
        continue;
      }
      onStep?.({ step: stepNum, action, url: snapshot.data.url, status: 'done' });
      await chrome.tabs.update(tabId, { url: action.url });
      await waitForLoad(tabId);
      continue;
    }

    onStep?.({ step: stepNum, action, url: snapshot.data.url, status: 'done' });

    if (action.type === 'wait') {
      await sleep(800);
      continue;
    }

    const result = await sendToTab(tabId, { kind: 'pilot-action', action });
    if (!result?.ok) {
      messages.push({ role: 'user', content: `Action failed: ${result?.error || 'unknown error'}` });
    }
    if (stepDelay) await sleep(stepDelay);
  }

  return { done: false, summary: `Stopped after ${maxSteps} steps without finishing.`, steps: maxSteps };
}

/**
 * Calls the provider and parses its reply, retrying with a corrective
 * nudge when the reply isn't valid JSON (or is empty/truncated — the most
 * common intermittent failure with small local models and low token
 * budgets). Only gives up after `MAX_PARSE_RETRIES` extra attempts.
 * Mutates `messages` with the retry nudges so the model sees its own bad
 * reply and the correction, matching normal conversation history.
 * `callOpts` (timeoutMs/maxTokens/onRotate) passes straight through to
 * lib/providers.js's callProviderChat on every attempt.
 */
async function getNextAction(providerId, providerConfig, messages, callOpts) {
  let lastRaw = '';
  for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt++) {
    // A reply that got cut off mid-object (see closeTruncatedJson in
    // parseAction) often means the budget was just slightly too small for
    // that particular step — give each retry more room. But if the LAST
    // attempt's problem was a reasoning model filling the whole budget with
    // chain-of-thought and never reaching the JSON (see
    // looksLikeReasoningProse), a bigger budget just buys it more room to
    // keep thinking — hold the budget steady and rely on REASONING_NUDGE
    // (below) plus OpenRouter's reasoning.effort cap (lib/providers.js)
    // instead.
    const wasReasoningProse = looksLikeReasoningProse(lastRaw);
    const attemptOpts = (attempt === 0 || wasReasoningProse)
      ? callOpts
      : { ...callOpts, maxTokens: Math.round((callOpts.maxTokens || 500) * (1 + attempt * 0.5)) };
    const raw = await callProviderChat(providerId, providerConfig, messages, attemptOpts);
    lastRaw = raw;
    const action = parseAction(raw);
    if (action) return { action, failed: false };

    if (attempt < MAX_PARSE_RETRIES) {
      // Reasoning models tend to keep reasoning even after seeing their own
      // truncated output, so echoing the full 300-char prose blob back just
      // gives them more of their own thinking to continue from — a short
      // marker is enough context without inviting a continuation.
      const isProse = looksLikeReasoningProse(raw);
      messages.push({ role: 'assistant', content: isProse ? String(raw || '').slice(0, 80) : String(raw || '').slice(0, 300) });
      messages.push({ role: 'user', content: isProse ? REASONING_NUDGE : RETRY_NUDGE });
    }
  }

  const preview = String(lastRaw || '').trim().slice(0, 160);
  const summary = preview
    ? `The model kept replying with invalid JSON after ${MAX_PARSE_RETRIES + 1} tries — last reply: "${preview}${lastRaw.length > 160 ? '…' : ''}"`
    : `The model returned an empty reply ${MAX_PARSE_RETRIES + 1} times in a row — check the provider/model in Settings.`;
  return { action: { summary }, failed: true };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Defensively cleans the model's optional `data` array before it's returned
 *  to the UI (and eventually SheetJS/jsPDF) — this is untrusted model
 *  output, not a schema-checked API response. Drops anything that isn't a
 *  flat object, caps row/column counts, and stringifies/truncates values so
 *  one odd reply can't produce a huge or nested payload. Returns `undefined`
 *  (rather than an empty array) when there's nothing usable, so callers can
 *  treat "no data" and "data" the same way with a single truthiness check. */
function normalizeData(data) {
  if (!Array.isArray(data)) return undefined;
  const rows = data
    .filter((row) => row && typeof row === 'object' && !Array.isArray(row))
    .slice(0, 500)
    .map((row) => {
      const clean = {};
      for (const [key, value] of Object.entries(row).slice(0, 30)) {
        const safeKey = String(key).slice(0, 60) || 'value';
        if (value == null) { clean[safeKey] = ''; continue; }
        clean[safeKey] = typeof value === 'object' ? JSON.stringify(value).slice(0, 300) : String(value).slice(0, 500);
      }
      return clean;
    });
  return rows.length ? rows : undefined;
}

/**
 * Closes off a JSON string/object/array that got cut short mid-generation —
 * e.g. the model's reply stops at `{"type":"click","targetId":27` with no
 * closing brace (a real failure seen with small local models: the provider
 * hit its own stop condition before finishing the object, not a case of
 * stray prose around otherwise-complete JSON, which `parseAction`'s regex
 * salvage already handles). Walks the text once, tracking open strings and
 * open `{`/`[`, and appends whatever closing characters are still owed.
 * Never throws; returns the repaired string for the caller to re-parse. */
function closeTruncatedJson(text) {
  let inString = false;
  let escaped = false;
  const stack = [];
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let repaired = text;
  if (inString) repaired += '"'; // close a value/key that was cut off mid-string
  while (stack.length) repaired += stack.pop();
  return repaired;
}

/** Returns a parsed action object, or null if `raw` isn't usable JSON. */
function parseAction(raw) {
  const cleaned = String(raw || '').trim().replace(/^```(?:json)?\s*|```$/g, '').trim();
  if (!cleaned) return null;
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== 'object' || !parsed.type) return null;
    return parsed;
  } catch (e) {
    // Small local models (and some cloud models) occasionally wrap JSON in
    // stray prose — try to salvage the first {...} block before giving up.
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (parsed && typeof parsed === 'object' && parsed.type) return parsed;
      } catch {}
    }
    // Reply looked like it never got a closing brace at all (the object
    // starts but the text just stops) — try repairing it before giving up.
    // This is what recovers a reply like `{"type":"click","targetId":27`.
    const openBrace = cleaned.indexOf('{');
    if (openBrace !== -1) {
      try {
        const parsed = JSON.parse(closeTruncatedJson(cleaned.slice(openBrace)));
        if (parsed && typeof parsed === 'object' && parsed.type) return parsed;
      } catch {}
    }
    return null;
  }
}

function sendToTabOnce(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response);
    });
  });
}

/**
 * Tabs that were already open before this extension was last loaded/reloaded
 * never got content.js injected (Chrome only auto-injects on new
 * navigations after install). That produces the same "Could not establish
 * connection. Receiving end does not exist." error as a genuinely
 * restricted page. Since we already hold the `scripting` permission, try
 * injecting content.js ourselves and retry once before giving up — this is
 * the single most common cause of that error during normal use/dev testing.
 */
async function sendToTab(tabId, message) {
  const first = await sendToTabOnce(tabId, message);
  if (first?.ok !== false) return first;
  if (!/Receiving end does not exist|Could not establish connection/i.test(first.error || '')) {
    return first; // a different failure — no point retrying
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (e) {
    // Injection itself failed — genuinely restricted page (chrome://, the
    // Web Store, etc.) or the tab no longer exists. Surface the original
    // error rather than this one; it's more informative upstream.
    return first;
  }
  return sendToTabOnce(tabId, message);
}

function waitForLoad(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { cleanup(); resolve(); }, 8000);
    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') { cleanup(); resolve(); }
    }
    function cleanup() {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}
