// Thin wrapper around chrome.storage.local.
// Note: extension storage is sandboxed per-extension but NOT OS-keystore-level
// encrypted like a mobile secure store. Good enough for personal API keys on
// a device only you use; don't treat it as a secrets vault.

const DEFAULT_SETTINGS = {
  activeProvider: 'ollama',
  providers: {},
  theme: 'light',          // 'dark' | 'light' — matches Chrome's own default UI
  approvalMode: false,    // require explicit approval before each action
  maxSteps: 12,           // hard cap on agent steps per run
  stepDelay: 250,         // ms pause between executed actions (lets pages settle)
  history: [],            // recent runs, most recent first
  blockedSites: [],       // user-added domains Pilot will refuse to act on, on
                           // top of the built-in guardrails in lib/guardrails.js
  fastMode: false,         // smaller reply budget + shorter network timeout
  requestTimeoutMs: 25000, // per-request network timeout, all providers
};

const MAX_HISTORY = 25;
const FAST_TIMEOUT_MS = 12000;
const FAST_MAX_TOKENS = 300;
const NORMAL_MAX_TOKENS = 500;

let idCounter = 0;
function makeKeyId() {
  idCounter = (idCounter + 1) % 1e6;
  return `k_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function freshKeyEntry(key, label = '') {
  return {
    id: makeKeyId(),
    key: (key || '').trim(),
    label: (label || '').trim(),
    status: 'ok',      // 'ok' | 'exhausted' | 'invalid'
    addedAt: Date.now(),
    lastUsed: null,
    lastError: '',
    cooldownUntil: null,
  };
}

/** Normalizes a provider's stored config to the multi-key shape, migrating
 *  the old single `apiKey` string field transparently the first time it's
 *  read (existing users keep their key, it just becomes "key 1"). Ollama has
 *  no keys at all (local, `baseUrl` only) and is left untouched. */
function normalizeProviderConfig(config) {
  const c = config || {};
  if (Array.isArray(c.apiKeys)) return c;
  if (c.apiKey) {
    const { apiKey, ...rest } = c;
    const entry = freshKeyEntry(apiKey);
    return { ...rest, apiKeys: [entry], activeKeyId: entry.id };
  }
  return { ...c, apiKeys: c.apiKeys || [], activeKeyId: c.activeKeyId || null };
}

export async function getSettings() {
  const { pilotSettings } = await chrome.storage.local.get('pilotSettings');
  const settings = { ...DEFAULT_SETTINGS, ...(pilotSettings || {}) };
  const providers = {};
  for (const [id, config] of Object.entries(settings.providers || {})) {
    providers[id] = id === 'ollama' ? config : normalizeProviderConfig(config);
  }
  settings.providers = providers;
  return settings;
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ pilotSettings: settings });
}

export async function updateProvider(id, config) {
  const settings = await getSettings();
  settings.providers = settings.providers || {};
  settings.providers[id] = { ...(settings.providers[id] || {}), ...config };
  await saveSettings(settings);
  return settings;
}

export async function setActiveProvider(id) {
  const settings = await getSettings();
  settings.activeProvider = id;
  await saveSettings(settings);
  return settings;
}

/** Persist run behaviour prefs (theme / approvalMode / maxSteps / stepDelay /
 *  fastMode / requestTimeoutMs). */
export async function updatePrefs(prefs) {
  const settings = await getSettings();
  Object.assign(settings, prefs);
  await saveSettings(settings);
  return settings;
}

/** Prepend a finished run to history, capped at MAX_HISTORY entries. */
export async function addHistoryEntry(entry) {
  const settings = await getSettings();
  const history = [{ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ...entry }, ...(settings.history || [])];
  settings.history = history.slice(0, MAX_HISTORY);
  await saveSettings(settings);
  return settings.history;
}

export async function clearHistory() {
  const settings = await getSettings();
  settings.history = [];
  await saveSettings(settings);
  return settings;
}

/** Fast mode trades a bit of reliability for speed: a shorter per-request
 *  timeout (fails fast onto the next key/provider instead of hanging) and a
 *  smaller reply token budget (less for the model to generate = faster
 *  round-trip). Off by default because a smaller budget occasionally clips a
 *  "summary" field on slower models. */
export function effectiveTimeoutMs(settings) {
  const configured = settings?.requestTimeoutMs || DEFAULT_SETTINGS.requestTimeoutMs;
  return settings?.fastMode ? Math.min(configured, FAST_TIMEOUT_MS) : configured;
}

export function effectiveMaxTokens(settings) {
  return settings?.fastMode ? FAST_MAX_TOKENS : NORMAL_MAX_TOKENS;
}

/* ------------------- Multi-key management (cloud providers) ------------------- */
// A cloud provider's config looks like:
//   { apiKeys: [{ id, key, label, status, addedAt, lastUsed, lastError, cooldownUntil }],
//     activeKeyId, model }
// `activeKeyId` is the "sticky" key lib/providers.js tries first. It only
// moves off a key when that key actually fails — see callProviderChat.

/** Adds a new API key to a provider. Silently no-ops on an exact duplicate
 *  (same key string already saved) so pasting the same key twice is harmless. */
export async function addProviderKey(providerId, key, label = '') {
  const trimmed = (key || '').trim();
  if (!trimmed) return getSettings();
  const settings = await getSettings();
  const config = normalizeProviderConfig(settings.providers?.[providerId]);
  if (config.apiKeys.some((k) => k.key === trimmed)) return settings;
  const entry = freshKeyEntry(trimmed, label);
  config.apiKeys = [...config.apiKeys, entry];
  if (!config.activeKeyId) config.activeKeyId = entry.id;
  settings.providers[providerId] = config;
  await saveSettings(settings);
  return settings;
}

export async function removeProviderKey(providerId, keyId) {
  const settings = await getSettings();
  const config = normalizeProviderConfig(settings.providers?.[providerId]);
  config.apiKeys = config.apiKeys.filter((k) => k.id !== keyId);
  if (config.activeKeyId === keyId) config.activeKeyId = config.apiKeys[0]?.id || null;
  settings.providers[providerId] = config;
  await saveSettings(settings);
  return settings;
}

export async function updateProviderKeyLabel(providerId, keyId, label) {
  const settings = await getSettings();
  const config = normalizeProviderConfig(settings.providers?.[providerId]);
  const entry = config.apiKeys.find((k) => k.id === keyId);
  if (entry) entry.label = (label || '').trim();
  settings.providers[providerId] = config;
  await saveSettings(settings);
  return settings;
}

/** Resets every key's health status back to 'ok' and clears cooldowns — use
 *  after a daily free-tier quota is known to have reset, or to give a key
 *  marked "invalid" another chance once you've fixed it. */
export async function resetProviderKeyStatus(providerId) {
  const settings = await getSettings();
  const config = normalizeProviderConfig(settings.providers?.[providerId]);
  for (const k of config.apiKeys) {
    k.status = 'ok';
    k.cooldownUntil = null;
    k.lastError = '';
  }
  settings.providers[providerId] = config;
  await saveSettings(settings);
  return settings;
}

/** Called by lib/providers.js after every cloud API call to persist rotation
 *  state: which key is the "sticky active" one, and each key's health. Reads,
 *  patches, and writes settings in one go. Safe without extra locking because
 *  only one agent run executes at a time (see the single `activeRun` in
 *  background.js), so calls are never concurrent in practice. */
export async function recordKeyOutcome(providerId, keyId, patch, newActiveKeyId) {
  const settings = await getSettings();
  const config = normalizeProviderConfig(settings.providers?.[providerId]);
  const entry = config.apiKeys.find((k) => k.id === keyId);
  if (entry) Object.assign(entry, patch);
  if (newActiveKeyId) config.activeKeyId = newActiveKeyId;
  settings.providers[providerId] = config;
  await saveSettings(settings);
  return settings;
}
