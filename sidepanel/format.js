// Small, dependency-free helpers shared between sidepanel.js (live UI) and
// export.js (PDF/Excel generation) — kept separate so neither file has to
// import the other.

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function describeAction(action) {
  switch (action?.type) {
    case 'click': return `element #${action.targetId}`;
    case 'type': return `"${action.text}" into #${action.targetId}`;
    case 'scroll': return action.direction || 'down';
    case 'navigate': return action.url || '';
    case 'wait': return 'waiting for the page';
    case 'finish': return action.summary || 'done';
    case 'error': return action.reason || 'The model did not return a usable response.';
    case 'note': return action.summary || '';
    default: return '';
  }
}

/** "8s" / "2m 5s" — durable across re-runs, unlike a raw millisecond count. */
export function formatElapsed(ms) {
  if (!ms || ms < 0) return '';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

const PDF_REQUEST_RE = /\bpdf\b/i;
const EXCEL_REQUEST_RE = /\b(excel|xlsx|xls|spreadsheet)\b/i;

/** Looks at the user's own goal text for an explicit request to save the
 *  result as a file, e.g. "...and store in pdf" or "get all user info and
 *  store in excel file". The result stays chat-only unless the goal itself
 *  asks for a file — this is what decides whether export buttons appear at
 *  all and whether a download fires automatically once the run finishes. */
export function detectExportIntent(goal) {
  const text = String(goal || '');
  return {
    pdf: PDF_REQUEST_RE.test(text),
    excel: EXCEL_REQUEST_RE.test(text),
  };
}

/** A safe, readable filename base from the run's goal, e.g.
 *  "find-pricing-plans-2026-08-16.xlsx". */
export function filenameFor(run, ext) {
  const base = (run?.goal || 'pilot-run')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'pilot-run';
  const date = new Date(run?.finishedAt || Date.now()).toISOString().slice(0, 10);
  return `${base}-${date}.${ext}`;
}

/** Strips a trailing "...and save/store it in pdf/excel" clause from a goal
 *  so it reads as a title for the content itself rather than an instruction
 *  about exporting it, e.g. "get all contact us info of bigmommy.site and
 *  save in pdf" -> "Get all contact us info of bigmommy.site". Used only
 *  for display (the export-intent detection above still looks at the full
 *  original text) — falls back to the untouched goal if the pattern isn't
 *  found, so it's never worse than showing the raw goal. */
export function cleanGoalTitle(goal) {
  const text = String(goal || '').trim();
  if (!text) return '';
  const stripped = text
    .replace(/[,;]?\s*(and\s+)?(then\s+)?(save|store|download|export)\b[^.]*?\b(pdf|excel|xlsx|xls|spreadsheet)\b[^.]*$/i, '')
    .trim();
  const result = stripped || text;
  return result.charAt(0).toUpperCase() + result.slice(1);
}

/** "contact_fields" -> "Contact Fields", "footerLinks" -> "Footer Links" —
 *  turns a model-chosen data key into a readable label for the key-value
 *  view of a single extracted item. */
export function prettifyKey(key) {
  const words = String(key || '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || String(key || '');
}
