'use strict';

// A small, safe Markdown subset for note bodies. Everything is HTML-escaped
// first, so card text can never inject markup. Supported:
//   # / ## / ### headings, - or * bullets, 1. numbered lists,
//   - [ ] / - [x] checklists, > quotes, **bold**, *italic* or _italic_,
//   ~~strike~~, `code`, [label](https://url) and bare https:// links.

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function safeUrl(url) {
  const u = url.trim();
  if (/^https?:\/\//i.test(u) || /^mailto:/i.test(u)) return u;
  if (/^www\./i.test(u)) return 'https://' + u;
  return null;
}

function inline(text) {
  let s = esc(text);
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const href = safeUrl(url.replace(/&amp;/g, '&'));
    return href ? `<a href="${esc(href)}" target="_blank" rel="noopener" data-nodrag>${label}</a>` : m;
  });
  s = s.replace(/(^|[\s(])((?:https?:\/\/|www\.)[^\s<]+[^\s<.,;:!?)])/g, (m, pre, url) => {
    const href = safeUrl(url.replace(/&amp;/g, '&'));
    return href ? `${pre}<a href="${esc(href)}" target="_blank" rel="noopener" data-nodrag>${url}</a>` : m;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s(])_([^_\s][^_]*)_/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

export function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let list = null;        // 'ul' | 'ol'
  let para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushPara(); closeList(); continue; }
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      flushPara(); closeList();
      const level = m[1].length + 2;   // h3-h5 inside a card
      out.push(`<h${level}>${inline(m[2])}</h${level}>`);
      continue;
    }
    if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); closeList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if ((m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/))) {
      flushPara();
      if (list !== 'ul') { closeList(); out.push('<ul class="md-check">'); list = 'ul'; }
      const done = m[1].toLowerCase() === 'x';
      out.push(`<li class="${done ? 'done' : ''}"><span class="md-box">${done ? '✓' : ''}</span>${inline(m[2])}</li>`);
      continue;
    }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      flushPara();
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara();
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(m[1])}</li>`);
      continue;
    }
    closeList();
    para.push(line);
  }
  flushPara(); closeList();
  return out.join('');
}

// Plain text wraps or prefixes the textarea selection (used by the note
// formatting bar and Ctrl+B / Ctrl+I).
export function applyFormat(textarea, kind) {
  const { selectionStart: a, selectionEnd: b, value } = textarea;
  const selected = value.slice(a, b);
  const wrap = (left, right = left, placeholder = 'text') => {
    const inner = selected || placeholder;
    textarea.setRangeText(left + inner + right, a, b, 'end');
    if (!selected) textarea.setSelectionRange(a + left.length, a + left.length + inner.length);
  };
  const prefix = (marker) => {
    const start = value.lastIndexOf('\n', a - 1) + 1;
    const end = value.indexOf('\n', b);
    const block = value.slice(start, end < 0 ? value.length : end);
    const lines = block.split('\n');
    const all = lines.every(l => l.startsWith(marker));
    const next = lines.map(l => all ? l.slice(marker.length) : marker + l).join('\n');
    textarea.setRangeText(next, start, end < 0 ? value.length : end, 'end');
  };
  if (kind === 'bold') wrap('**');
  else if (kind === 'italic') wrap('*');
  else if (kind === 'strike') wrap('~~');
  else if (kind === 'heading') prefix('## ');
  else if (kind === 'list') prefix('- ');
  else if (kind === 'check') prefix('- [ ] ');
  else if (kind === 'link') wrap('[', '](https://)', 'label');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.focus();
}
