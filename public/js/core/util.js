'use strict';

// Small helpers shared everywhere: colors, Lucide icons, text areas,
// URL normalization, image sizes and the toast message.

import { COLORS, dom } from './state.js';

export const colorVar = c => `var(--c-${COLORS.includes(c) ? c : 'slate'})`;

export function lucideEl(name) {
  const i = document.createElement('i');
  i.setAttribute('data-lucide', name);
  return i;
}

// `lucide` is a global provided by the CDN <script>. If it failed to load we
// silently skip icon rendering rather than throwing.
export function refreshIcons(root) {
  if (typeof lucide !== 'undefined' && lucide.createIcons) {
    lucide.createIcons(root ? { nodes: [root] } : undefined);
  }
}

// Text index under a screen point inside a textarea/input, for placing the
// caret where the user clicked. A hidden, unscaled copy of the field is laid
// out with the same font and width and each character is measured; `scale`
// is the canvas zoom applied to the real field.
const MIRROR_PROPS = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
  'textTransform', 'textIndent', 'wordSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxSizing', 'tabSize'];
export function caretIndexAt(field, clientX, clientY, scale = 1) {
  const text = field.value || '';
  if (!text) return 0;
  const r = field.getBoundingClientRect();
  const cs = getComputedStyle(field);
  const mirror = document.createElement('div');
  for (const p of MIRROR_PROPS) mirror.style[p] = cs[p];
  Object.assign(mirror.style, {
    position: 'fixed', left: '0', top: '0', visibility: 'hidden', pointerEvents: 'none',
    width: (r.width / scale) + 'px', whiteSpace: field.tagName === 'INPUT' ? 'pre' : 'pre-wrap',
    overflowWrap: 'break-word', wordBreak: cs.wordBreak, borderStyle: 'solid'
  });
  const node = document.createTextNode(text);
  mirror.appendChild(node);
  document.body.appendChild(mirror);
  try {
    const base = mirror.getBoundingClientRect();
    const x = (clientX - r.left) / scale + base.left + field.scrollLeft;
    const y = (clientY - r.top) / scale + base.top + field.scrollTop;
    const range = document.createRange();
    let best = text.length, bestScore = Infinity;
    for (let i = 0; i < text.length; i++) {
      range.setStart(node, i); range.setEnd(node, i + 1);
      const c = range.getBoundingClientRect();
      if (!c.height) continue;
      // rows first, then the closest character edge within the row
      const rowDist = y < c.top ? c.top - y : y > c.bottom ? y - c.bottom : 0;
      const before = x < c.left + c.width / 2;
      const colDist = Math.abs(x - (before ? c.left : c.right));
      const score = rowDist * 1000 + colDist;
      if (score < bestScore) { bestScore = score; best = before ? i : i + 1; }
    }
    return best;
  } finally {
    mirror.remove();
  }
}

export function autoGrow(t) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }
// Cards are what the user places and moves; group frames and lines only
// decorate or relate them.
export function isCard(it) { return it.type !== 'group' && it.type !== 'line'; }
export function isLocked(it) { return !!(it.data && it.data.locked); }
export function rid() { return Math.random().toString(36).slice(2, 10); }
export function normalizeUrl(u) { if (!u) return '#'; return /^https?:\/\//.test(u) ? u : 'https://' + u; }

export function imageSize(src) {
  return new Promise(r => {
    const i = new Image();
    i.onload = () => r({ w: i.naturalWidth, h: i.naturalHeight });
    i.onerror = () => r({ w: 1, h: 1 });
    i.src = src;
  });
}

let toastTimer;
export function toast(msg) {
  dom.toastEl.textContent = msg;
  dom.toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toastEl.classList.remove('show'), 2200);
}
