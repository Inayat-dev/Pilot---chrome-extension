// Safety guardrails — same idea as the site restrictions in Claude in Chrome
// and Comet: certain high-risk categories are hard-blocked no matter what
// the user's approval settings are, because a prompt-injected page is the
// #1 real-world attack against browser agents (a hidden instruction on the
// page tries to get the agent to act against the user, e.g. on a logged-in
// banking or crypto tab). This list is intentionally NOT stored in
// chrome.storage and can't be edited from the UI — only extended, via the
// user's own "Blocked sites" list in Settings.

const BUILT_IN_BLOCKED = {
  banking: [
    'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citibank.com', 'citi.com',
    'usbank.com', 'capitalone.com', 'hsbc.com', 'barclays.com', 'santander.com',
    'paypal.com', 'venmo.com', 'schwab.com', 'fidelity.com', 'vanguard.com',
    'etrade.com', 'robinhood.com', 'americanexpress.com', 'discover.com',
    'ally.com', 'sofi.com', 'hdfcbank.com', 'icicibank.com', 'sbi.co.in', 'axisbank.com',
  ],
  crypto: [
    'coinbase.com', 'binance.com', 'kraken.com', 'crypto.com', 'kucoin.com',
    'okx.com', 'gemini.com', 'bitfinex.com', 'metamask.io',
  ],
  piracy: [
    'thepiratebay.org', '1337x.to', 'yts.mx', 'fmovies.to', 'putlocker.vip', 'soap2day.to',
  ],
};

// Adult content is matched by keyword rather than a domain list — that
// category is too large to enumerate and keyword matching on the hostname
// is the same approach Chrome's own SafeSearch-style filters use.
const ADULT_KEYWORDS = ['porn', 'xvideos', 'xnxx', 'xxx', 'pornhub', 'onlyfans', 'redtube'];

const CATEGORY_LABEL = {
  banking: 'banking or financial-services',
  crypto: 'crypto-exchange or wallet',
  piracy: 'piracy',
  adult: 'adult-content',
};

function normalizeHost(hostname) {
  return String(hostname || '').toLowerCase().trim().replace(/^www\./, '');
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Returns the built-in category a hostname falls into, or null. */
export function classifyHost(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return null;
  for (const [category, domains] of Object.entries(BUILT_IN_BLOCKED)) {
    if (domains.some((d) => hostMatches(host, d))) return category;
  }
  if (ADULT_KEYWORDS.some((k) => host.includes(k))) return 'adult';
  return null;
}

/** Returns true if `hostname` matches an entry in the user's own blocklist. */
export function isUserBlocked(hostname, userBlocklist) {
  const host = normalizeHost(hostname);
  if (!host) return false;
  return (userBlocklist || []).some((entry) => {
    const d = normalizeHost(entry);
    return d && hostMatches(host, d);
  });
}

export function categoryLabel(category) {
  return CATEGORY_LABEL[category] || 'restricted';
}

/**
 * Checks whether Pilot should refuse to act on `url`.
 * Returns { blocked: false } or { blocked: true, reason: 'category'|'custom', category?, hostname }.
 */
export function checkUrl(url, userBlocklist) {
  let hostname = '';
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { blocked: false };
  }
  const category = classifyHost(hostname);
  if (category) return { blocked: true, reason: 'category', category, hostname };
  if (isUserBlocked(hostname, userBlocklist)) return { blocked: true, reason: 'custom', hostname };
  return { blocked: false };
}

/**
 * Chrome never allows content scripts on these pages, no matter what a
 * manifest's `matches` pattern says — so Pilot can never message a tab on
 * one of them. Checking this up front turns Chrome's cryptic "Could not
 * establish connection. Receiving end does not exist." into a message that
 * actually tells the user what to do.
 */
export function isRestrictedUrl(url) {
  if (!url) return true; // empty/undefined tab.url — treat as not-yet-scriptable
  return /^(chrome|edge|about|chrome-extension|moz-extension|devtools):/i.test(url)
    || /^https:\/\/chrome\.google\.com\/webstore/i.test(url)
    || /^https:\/\/microsoftedge\.microsoft\.com\/addons/i.test(url);
}

/** Human-readable refusal message for a blocked check result. */
export function blockedMessage(guard) {
  if (!guard?.blocked) return '';
  if (guard.reason === 'category') {
    return `Pilot doesn't act on ${categoryLabel(guard.category)} sites like ${guard.hostname} — that's a built-in safety guardrail, not a bug.`;
  }
  return `${guard.hostname} is on your blocked-sites list (Settings → Safety). Remove it there if this was a mistake.`;
}
