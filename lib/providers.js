// Provider registry — mirrors the mobile app's provider list, plus Ollama
// as the local-model option (Ollama runs as a background process on the
// user's machine, unlike the phone's in-app GGUF runtime).

import { recordKeyOutcome } from './storage.js';

export const PROVIDERS = [
  { id: 'openai', name: 'GPT (OpenAI)', color: '#10a37f', defaultModel: 'gpt-4o-mini', docsUrl: 'https://platform.openai.com/docs' },
  { id: 'anthropic', name: 'Claude (Anthropic)', color: '#d97757', defaultModel: 'claude-haiku-4-5-20251001', docsUrl: 'https://docs.claude.com' },
  { id: 'google', name: 'Gemini (Google)', color: '#4285f4', defaultModel: 'gemini-2.0-flash', docsUrl: 'https://ai.google.dev/docs', free: true },
  { id: 'openrouter', name: 'OpenRouter (free models)', color: '#8b5cf6', defaultModel: 'nvidia/nemotron-3-ultra-550b-a55b:free', docsUrl: 'https://openrouter.ai/docs', free: true },
  // Local, via Ollama running on this machine (https://ollama.com). No key,
  // no per-token cost, nothing leaves the device. `model` is whatever's
  // pulled locally (`ollama pull llama3.2:1b`, etc).
  {
    id: 'ollama', name: 'Ollama (local)', color: '#0f766e', defaultModel: 'llama3.2:1b',
    docsUrl: 'https://ollama.com', free: true, onDevice: true,
    defaultBaseUrl: 'http://localhost:11434',
  },
];

const DEFAULT_TIMEOUT_MS = 25000;
// Middle-ground cooldown for a key that hit a rate limit / quota error: long
// enough not to hammer a genuinely-exhausted free-tier key every step, short
// enough that a per-minute limit clears itself within the same session.
// "Reset key status" in Settings clears it early once a daily quota resets.
const QUOTA_COOLDOWN_MS = 20 * 60 * 1000;
const TIMEOUT_COOLDOWN_MS = 2 * 60 * 1000;

export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id);
}

function withTimeoutSignal(run, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  return run(controller.signal).finally(() => clearTimeout(timer));
}

/** fetch + JSON parse with an abortable timeout. Throws an Error carrying
 *  `.status` (HTTP code) or `.code` ('timeout' | 'network') so callers can
 *  classify the failure without re-parsing message text. */
async function httpJson(url, init, timeoutMs) {
  let res;
  try {
    res = await withTimeoutSignal((signal) => fetch(url, { ...init, signal }), timeoutMs);
  } catch (e) {
    const err = new Error(
      e?.name === 'AbortError'
        ? `Request timed out after ${Math.round((timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)}s`
        : (e?.message || String(e)),
    );
    err.code = e?.name === 'AbortError' ? 'timeout' : 'network';
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Request failed (${res.status}): ${body.slice(0, 200)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return res.json();
}

/** Sorts one error into 'timeout' | 'auth' | 'quota' | 'other' so the caller
 *  knows whether to mark a key invalid, put it on cooldown, or just move on
 *  without penalizing it (a plain network blip isn't the key's fault). */
function classifyKeyError(err) {
  if (err?.code === 'timeout') return 'timeout';
  if (err?.status === 401 || err?.status === 403) return 'auth';
  if (err?.status === 429) return 'quota';
  const msg = `${err?.message || ''} ${err?.body || ''}`.toLowerCase();
  if (/quota|rate.?limit|resource_exhausted|too many requests/.test(msg)) return 'quota';
  if (/invalid[^a-z]*(api.?key|x-api-key)|api key not valid|incorrect api key|unauthorized/.test(msg)) return 'auth';
  return 'other';
}

function describeFailureKind(kind) {
  if (kind === 'quota') return 'rate-limited or out of quota';
  if (kind === 'auth') return 'rejected (invalid key)';
  if (kind === 'timeout') return 'too slow to respond';
  return 'unavailable';
}

/** `extraBody` lets callers merge provider-specific request fields (used for
 *  OpenRouter's `reasoning` control below) without touching the base
 *  OpenAI-compatible shape every other caller relies on. */
async function callOpenAICompatible(url, apiKey, model, messages, timeoutMs, maxTokens, extraBody) {
  const data = await httpJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: maxTokens, ...extraBody }),
  }, timeoutMs);
  return data?.choices?.[0]?.message?.content ?? '';
}

async function callAnthropic(apiKey, model, messages, timeoutMs, maxTokens) {
  const systemText = messages.find((m) => m.role === 'system')?.content;
  const rest = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
  const system = systemText ? [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }] : undefined;
  const data = await httpJson('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: rest }),
  }, timeoutMs);
  return (data?.content ?? []).map((b) => b.text ?? '').join('');
}

async function callGemini(apiKey, model, messages, timeoutMs, maxTokens) {
  const system = messages.find((m) => m.role === 'system')?.content;
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const data = await httpJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens },
    }),
  }, timeoutMs);
  return (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
}

/** Ollama's OpenAI-compatible endpoint. `format: 'json'` constrains output so
 *  small local models (1-3B) don't wander into prose instead of valid JSON —
 *  the single biggest cause of "local model doesn't work" reports.
 *  `num_predict` was previously hardcoded to 500, silently ignoring both
 *  Fast mode's smaller budget and any caller-supplied value — this made the
 *  Settings token budget a no-op for Ollama specifically (cloud providers
 *  were unaffected). Now it honors `maxTokens` like every other provider. */
async function callOllama(baseUrl, model, messages, timeoutMs, maxTokens) {
  const url = `${baseUrl.replace(/\/$/, '')}/api/chat`;
  let data;
  try {
    data = await httpJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        format: 'json',
        options: { temperature: 0.2, num_predict: maxTokens || 500 },
      }),
    }, timeoutMs);
  } catch (e) {
    if (e.code === 'timeout') {
      throw new Error(`Ollama didn't reply within ${Math.round((timeoutMs || DEFAULT_TIMEOUT_MS) / 1000)}s — the model may be too large for this machine. Try a smaller one, e.g. "ollama pull qwen2.5:1.5b".`);
    }
    if (e.code === 'network') {
      throw new Error(`Can't reach Ollama at ${baseUrl}. Is it running? Start it with "ollama serve", and make sure the model is pulled ("ollama pull ${model}").`);
    }
    if (e.status === 404) throw new Error(`Model "${model}" isn't pulled yet. Run: ollama pull ${model}`);
    throw new Error(`Ollama request failed${e.status ? ` (${e.status})` : ''}: ${(e.body || e.message || '').slice(0, 200)}`);
  }
  return data?.message?.content ?? '';
}

function callByProvider(providerId, apiKey, model, messages, timeoutMs, maxTokens) {
  switch (providerId) {
    case 'openai':
      return callOpenAICompatible('https://api.openai.com/v1/chat/completions', apiKey, model, messages, timeoutMs, maxTokens);
    case 'openrouter':
      return callOpenRouterWithReasoningFallback(apiKey, model, messages, timeoutMs, maxTokens);
    case 'anthropic':
      return callAnthropic(apiKey, model, messages, timeoutMs, maxTokens);
    case 'google':
      return callGemini(apiKey, model, messages, timeoutMs, maxTokens);
    default:
      throw new Error('Unknown provider');
  }
}

/** OpenRouter call with reasoning suppressed as hard as each model allows.
 *  `effort: "none"` fully disables reasoning on models that support
 *  disabling it at all — a stronger fix than the old `effort: "low"`, which
 *  still let large frontier-reasoning models (e.g. Nemotron Ultra, Pilot's
 *  default free OpenRouter model) spend most of a step's reply budget on
 *  chain-of-thought before ever reaching the JSON action, since "low" caps
 *  reasoning down rather than turning it off. `exclude: true` additionally
 *  keeps any reasoning text that does happen out of the `content` field
 *  Pilot parses, for models where reasoning can't be fully disabled but can
 *  at least be hidden from the response.
 *  A small number of models make reasoning mandatory and reject a request
 *  that tries to disable it outright (400, "reasoning is mandatory for this
 *  endpoint and cannot be disabled") — for those, retry once with
 *  `effort: "low"` instead of failing the call, since a capped-but-present
 *  reasoning budget is still better than no reply at all; whatever prose
 *  still leaks through is handled by parseAction's salvage logic and
 *  agent.js's REASONING_NUDGE retry (lib/agent.js). */
async function callOpenRouterWithReasoningFallback(apiKey, model, messages, timeoutMs, maxTokens) {
  const url = 'https://openrouter.ai/api/v1/chat/completions';
  try {
    return await callOpenAICompatible(url, apiKey, model, messages, timeoutMs, maxTokens, {
      reasoning: { effort: 'none', exclude: true },
    });
  } catch (e) {
    const msg = `${e?.message || ''} ${e?.body || ''}`.toLowerCase();
    const reasoningMandatory = e?.status === 400 && /reasoning/.test(msg) && /(mandatory|cannot be disabled|required)/.test(msg);
    if (!reasoningMandatory) throw e;
    return callOpenAICompatible(url, apiKey, model, messages, timeoutMs, maxTokens, {
      reasoning: { effort: 'low', exclude: true },
    });
  }
}

/** Orders a provider's keys for one attempt: the current "sticky" active key
 *  stays first as long as it's still healthy; keys on cooldown sort behind
 *  healthy ones (soonest-to-recover first); keys marked 'invalid' are tried
 *  only if literally nothing else is left, so a bad key doesn't get retried
 *  every single step but a genuine error still surfaces instead of vanishing. */
function orderKeysForAttempt(apiKeys, activeKeyId) {
  const now = Date.now();
  const usable = apiKeys.filter((k) => k.status !== 'invalid');
  const pool = usable.length ? usable : apiKeys;
  const ranked = [...pool].sort((a, b) => {
    const aCooling = !!(a.cooldownUntil && a.cooldownUntil > now);
    const bCooling = !!(b.cooldownUntil && b.cooldownUntil > now);
    if (aCooling !== bCooling) return aCooling ? 1 : -1;
    if (aCooling && bCooling) return a.cooldownUntil - b.cooldownUntil;
    return 0;
  });
  const activeIdx = ranked.findIndex((k) => k.id === activeKeyId);
  if (activeIdx > 0) {
    const active = ranked[activeIdx];
    const activeHealthy = !(active.cooldownUntil && active.cooldownUntil > now);
    if (activeHealthy) {
      ranked.splice(activeIdx, 1);
      ranked.unshift(active);
    }
  }
  return ranked;
}

function keyLabel(entry, idx) {
  return entry.label || `key ${idx + 1}`;
}

/**
 * Sends a chat completion request. `config` is this provider's saved
 * settings — for cloud providers, `config.apiKeys` may hold several keys.
 * This tries the sticky "active" key first and, on a quota / rate-limit /
 * auth / timeout failure, automatically rotates to the next healthy key —
 * so a run doesn't die (or a "fast" run doesn't sit there timing out) the
 * moment one free-tier key runs dry. Rotation state (which key is active,
 * each key's health/cooldown) is persisted via lib/storage.js so the *next*
 * call — even in a later run — starts from a known-good key instead of
 * re-hitting an exhausted one and burning another timeout on it.
 *
 * `opts.timeoutMs` / `opts.maxTokens` tune speed vs. budget (see Fast mode
 * in Settings). `opts.onRotate(note)` fires once, synchronously, right
 * before returning, if the call succeeded on a key other than the one that
 * was active — callers can surface that note in the UI for transparency.
 */
export async function callProviderChat(providerId, config, messages, opts = {}) {
  const meta = getProvider(providerId);
  const model = config?.model || meta?.defaultModel;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxTokens = opts.maxTokens || 500;

  if (providerId === 'ollama') {
    return callOllama(config?.baseUrl || 'http://localhost:11434', model, messages, timeoutMs, maxTokens);
  }

  const apiKeys = config?.apiKeys || [];
  if (!apiKeys.length) throw new Error('No API key configured for this provider — add one in Settings.');

  const order = orderKeysForAttempt(apiKeys, config.activeKeyId);
  const previousActiveId = config.activeKeyId;
  let lastKind = null;

  for (const entry of order) {
    const idxInFull = apiKeys.findIndex((k) => k.id === entry.id);
    try {
      const text = await callByProvider(providerId, entry.key, model, messages, timeoutMs, maxTokens);
      // Fire the persistence + rotation note without blocking the return —
      // the caller already has its answer; don't make it wait on storage.
      recordKeyOutcome(providerId, entry.id, { status: 'ok', lastUsed: Date.now(), lastError: '', cooldownUntil: null }, entry.id).catch(() => {});
      if (entry.id !== previousActiveId && apiKeys.length > 1) {
        const reason = lastKind ? describeFailureKind(lastKind) : 'unavailable';
        opts.onRotate?.(`Switched to ${keyLabel(entry, idxInFull)} for ${meta?.name || providerId} — previous key was ${reason}.`);
      }
      return text;
    } catch (e) {
      const kind = classifyKeyError(e);
      lastKind = kind;
      const patch = { lastError: e.message, lastUsed: Date.now() };
      if (kind === 'auth') patch.status = 'invalid';
      else if (kind === 'quota') { patch.status = 'exhausted'; patch.cooldownUntil = Date.now() + QUOTA_COOLDOWN_MS; }
      else if (kind === 'timeout') { patch.status = 'exhausted'; patch.cooldownUntil = Date.now() + TIMEOUT_COOLDOWN_MS; }
      else patch.status = 'ok'; // transient/network hiccup — don't penalize the key for it
      recordKeyOutcome(providerId, entry.id, patch, null).catch(() => {});
      if (order.length === 1) throw e;
      // otherwise: fall through and try the next key
    }
  }

  throw new Error(
    apiKeys.length > 1
      ? `All ${apiKeys.length} API keys for ${meta?.name || providerId} failed (${describeFailureKind(lastKind)}). Add another key or check Settings.`
      : 'Request failed.',
  );
}

/** Verifies a cloud provider's API key with a lightweight, no-cost request.
 *  Returns { ok, message }. Never throws — callers just render the message. */
export async function testProviderConnection(providerId, config, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const apiKey = (config?.apiKey || '').trim();
  if (!apiKey) return { ok: false, message: 'Enter an API key first.' };
  try {
    switch (providerId) {
      case 'openai':
        await httpJson('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${apiKey}` } }, timeoutMs);
        return { ok: true, message: 'Key verified.' };
      case 'openrouter':
        await httpJson('https://openrouter.ai/api/v1/auth/key', { headers: { Authorization: `Bearer ${apiKey}` } }, timeoutMs);
        return { ok: true, message: 'Key verified.' };
      case 'anthropic':
        await httpJson('https://api.anthropic.com/v1/models', {
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
        }, timeoutMs);
        return { ok: true, message: 'Key verified.' };
      case 'google':
        await httpJson(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {}, timeoutMs);
        return { ok: true, message: 'Key verified.' };
      default:
        return { ok: false, message: 'This provider has no connection test.' };
    }
  } catch (e) {
    if (e.code === 'timeout') return { ok: false, message: `Timed out after ${Math.round(timeoutMs / 1000)}s.` };
    if (e.status) return { ok: false, message: keyErrorMessage(e.status) };
    return { ok: false, message: `Network error — ${e?.message || String(e)}` };
  }
}

function keyErrorMessage(status) {
  if (status === 401 || status === 403) return 'Key rejected — check it was copied correctly.';
  if (status === 429) return 'Key looks valid, but rate-limited right now.';
  return `Request failed (${status}).`;
}

/** Lists locally-pulled Ollama models, for the picker in Options. */
export async function listOllamaModels(baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const url = `${(baseUrl || 'http://localhost:11434').replace(/\/$/, '')}/api/tags`;
  let data;
  try {
    data = await httpJson(url, {}, timeoutMs);
  } catch (e) {
    if (e.code === 'timeout') throw new Error(`Ollama didn't respond within ${Math.round(timeoutMs / 1000)}s.`);
    throw new Error(e.status ? `Ollama returned ${e.status}` : (e.message || String(e)));
  }
  return (data?.models ?? []).map((m) => m.name);
}

/** Human-readable status for one key row in Settings. Pure/no side effects —
 *  just reads the fields lib/storage.js already tracks. */
export function describeKeyStatus(entry) {
  if (!entry) return { label: 'Unknown', tone: 'muted' };
  const now = Date.now();
  if (entry.status === 'invalid') return { label: 'Invalid key', tone: 'err' };
  if (entry.cooldownUntil && entry.cooldownUntil > now) {
    const mins = Math.max(1, Math.ceil((entry.cooldownUntil - now) / 60000));
    return { label: `Cooling down (~${mins}m)`, tone: 'warn' };
  }
  if (entry.status === 'exhausted') return { label: 'Recently exhausted', tone: 'warn' };
  if (!entry.lastUsed) return { label: 'Not used yet', tone: 'muted' };
  return { label: 'Ready', tone: 'ok' };
}
