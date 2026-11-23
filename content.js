// Pilot content script — runs in every page (not iframes).
// Two jobs: (1) build a compact, indexed snapshot of interactive elements so
// the model has something small enough to reason over, (2) execute a single
// action (click / type / scroll) against an indexed element.
//
// Kept dependency-free and small on purpose: this file ships to every page
// load, and the agent's per-step latency depends on snapshot size — a huge
// serialized DOM is the #1 way to make a local model unusable.

(() => {
  const MAX_ELEMENTS = 120;   // hard cap — keeps the prompt small for local models
  const MAX_TEXT_LEN = 80;

  const INTERACTIVE_SELECTOR = [
    'a[href]', 'button', 'input', 'textarea', 'select',
    '[role="button"]', '[role="link"]', '[role="tab"]',
    '[role="menuitem"]', '[contenteditable="true"]', 'summary',
  ].join(',');

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
  }

  function labelFor(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const text = (el.innerText || el.value || el.placeholder || '').trim();
    if (text) return text.slice(0, MAX_TEXT_LEN);
    const title = el.getAttribute('title');
    if (title) return title.trim().slice(0, MAX_TEXT_LEN);
    return '';
  }

  function roleFor(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'input') return `input[${el.type || 'text'}]`;
    if (tag === 'textarea') return 'textarea';
    if (tag === 'select') return 'select';
    return el.getAttribute('role') || tag;
  }

  function buildSnapshot() {
    const nodes = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));
    const elements = [];
    let idx = 0;
    for (const el of nodes) {
      if (elements.length >= MAX_ELEMENTS) break;
      if (!isVisible(el)) continue;
      const label = labelFor(el);
      if (!label && roleFor(el) === 'link') continue; // skip icon-only links w/ no label
      el.setAttribute('data-pilot-id', String(idx));
      elements.push({ id: idx, role: roleFor(el), label });
      idx++;
    }
    return {
      url: location.href,
      title: document.title,
      elements,
    };
  }

  function clearIds() {
    document.querySelectorAll('[data-pilot-id]').forEach((el) => el.removeAttribute('data-pilot-id'));
  }

  function findById(id) {
    return document.querySelector(`[data-pilot-id="${CSS.escape(String(id))}"]`);
  }

  /** Visible synthetic mouse pointer so it's obvious, at a glance, that Pilot
   *  (not you) is driving — real OS cursor control isn't something a page
   *  script is allowed to do, but an on-page pointer that visibly glides to
   *  each target before acting gives the same "I can see what it's about to
   *  do" feedback, including during Confirm-steps approval. */
  let cursorEl = null;
  let cursorReady = false;
  function ensureCursor() {
    if (cursorEl) return cursorEl;
    cursorEl = document.createElement('div');
    cursorEl.id = 'pilot-cursor';
    cursorEl.innerHTML = `
      <svg width="26" height="26" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M5 3 L5 19.5 L9.5 15.5 L12.8 22 L15.6 20.6 L12.3 14.2 L18.5 14.2 Z" fill="#1a73e8" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/>
      </svg>
      <span class="pilot-cursor-tag">Pilot</span>
    `;
    document.documentElement.appendChild(cursorEl);
    return cursorEl;
  }

  function injectCursorStyle() {
    if (document.getElementById('pilot-cursor-style')) return;
    const style = document.createElement('style');
    style.id = 'pilot-cursor-style';
    style.textContent = `
      #pilot-cursor {
        position: fixed; left: 0; top: 0; z-index: 2147483647;
        pointer-events: none; opacity: 0;
        transform: translate(-4px, -2px);
        transition: transform 0.32s cubic-bezier(.3,.8,.3,1), opacity 0.15s ease;
        filter: drop-shadow(0 1px 2px rgba(0,0,0,0.35));
      }
      #pilot-cursor.pilot-cursor-visible { opacity: 1; }
      #pilot-cursor .pilot-cursor-tag {
        position: absolute; left: 20px; top: 14px;
        background: #1a73e8; color: #fff; font: 600 10px/1 -apple-system,Segoe UI,Roboto,sans-serif;
        padding: 2px 6px; border-radius: 3px; white-space: nowrap;
      }
      .pilot-click-ripple {
        position: fixed; z-index: 2147483646; pointer-events: none;
        width: 28px; height: 28px; margin: -14px 0 0 -14px;
        border: 2px solid #1a73e8; border-radius: 50%;
        animation: pilot-ripple 0.45s ease-out forwards;
      }
      @keyframes pilot-ripple {
        from { transform: scale(0.3); opacity: 0.8; }
        to { transform: scale(1.6); opacity: 0; }
      }
    `;
    document.documentElement.appendChild(style);
  }
  injectCursorStyle();

  /** Glides the on-page cursor to (x, y) — viewport coordinates, matching
   *  getBoundingClientRect since the cursor is position:fixed. Resolves once
   *  the CSS transition finishes (or after a fallback timeout, in case the
   *  page's own styles somehow interfere with transitionend firing). */
  function moveCursorTo(x, y) {
    const el = ensureCursor();
    return new Promise((resolve) => {
      const finish = () => { el.removeEventListener('transitionend', finish); resolve(); };
      if (!cursorReady) {
        // First move of the run: snap to the start position with no
        // animation, then fade in — otherwise it visibly flies in from the
        // page's top-left corner on the very first step.
        el.style.transition = 'none';
        el.style.transform = `translate(${x - 4}px, ${y - 2}px)`;
        void el.offsetWidth; // force reflow so the next transform change animates
        el.style.transition = '';
        cursorReady = true;
      }
      el.classList.add('pilot-cursor-visible');
      el.addEventListener('transitionend', finish);
      requestAnimationFrame(() => {
        el.style.transform = `translate(${x - 4}px, ${y - 2}px)`;
      });
      setTimeout(finish, 450); // fallback in case transitionend never fires
    });
  }

  function clickRippleAt(x, y) {
    const ripple = document.createElement('div');
    ripple.className = 'pilot-click-ripple';
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    document.documentElement.appendChild(ripple);
    setTimeout(() => ripple.remove(), 500);
  }

  function centerOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  async function performAction(action) {
    try {
      switch (action.type) {
        case 'click': {
          const el = findById(action.targetId);
          if (!el) return { ok: false, error: `No element with id ${action.targetId}` };
          el.scrollIntoView({ block: 'center' });
          const { x, y } = centerOf(el);
          await moveCursorTo(x, y);
          clickRippleAt(x, y);
          el.click();
          return { ok: true };
        }
        case 'type': {
          const el = findById(action.targetId);
          if (!el) return { ok: false, error: `No element with id ${action.targetId}` };
          el.scrollIntoView({ block: 'center' });
          const { x, y } = centerOf(el);
          await moveCursorTo(x, y);
          clickRippleAt(x, y);
          el.focus();
          if ('value' in el) {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
              || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
            setter?.call(el, action.text ?? '');
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            el.textContent = action.text ?? '';
          }
          return { ok: true };
        }
        case 'scroll': {
          window.scrollBy({ top: action.direction === 'up' ? -600 : 600, behavior: 'smooth' });
          return { ok: true };
        }
        default:
          return { ok: false, error: `Unknown action type: ${action.type}` };
      }
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  let highlightEl = null;
  /** Used in Confirm-steps mode: outlines the target element AND glides the
   *  cursor to it before the Approve/Reject buttons appear, so the decision
   *  is based on seeing exactly where Pilot is about to click — not just an
   *  outline that could be anywhere on a busy page. */
  async function highlightById(id) {
    clearHighlight();
    const el = findById(id);
    if (!el) return { ok: false, error: `No element with id ${id}` };
    el.scrollIntoView({ block: 'center' });
    el.setAttribute('data-pilot-highlight', '');
    highlightEl = el;
    const { x, y } = centerOf(el);
    await moveCursorTo(x, y);
    return { ok: true };
  }
  function clearHighlight() {
    if (highlightEl) highlightEl.removeAttribute('data-pilot-highlight');
    highlightEl = null;
  }

  function injectHighlightStyle() {
    if (document.getElementById('pilot-highlight-style')) return;
    const style = document.createElement('style');
    style.id = 'pilot-highlight-style';
    style.textContent = `
      [data-pilot-highlight] {
        outline: 2px solid #e8a33d !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 4px rgba(232, 163, 61, 0.25) !important;
        border-radius: 3px !important;
        transition: outline-color 0.15s ease !important;
      }
    `;
    document.documentElement.appendChild(style);
  }
  injectHighlightStyle();

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.kind === 'pilot-snapshot') {
      clearIds();
      clearHighlight();
      sendResponse({ ok: true, data: buildSnapshot() });
      return true;
    }
    if (msg?.kind === 'pilot-action') {
      clearHighlight();
      performAction(msg.action).then(sendResponse);
      return true;
    }
    if (msg?.kind === 'pilot-highlight') {
      highlightById(msg.targetId).then(sendResponse);
      return true;
    }
  });
})();
