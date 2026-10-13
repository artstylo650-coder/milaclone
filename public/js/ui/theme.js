'use strict';

// Appearance: color theme (light, dark, sepia, graphite or following the
// system) and the font pair. Choices live in localStorage and are applied as
// <html data-theme> / <html data-font>; an inline script in index.html applies
// them before the first paint so the page never flashes the wrong colors.

import { openPanel, closePanel } from './panel.js';
import { requestMinimap } from '../board/minimap.js';

export const THEMES = [
  { id: 'auto', label: 'Automático', hint: 'Segue o sistema', swatch: ['#efeff1', '#16171b'] },
  { id: 'light', label: 'Claro', swatch: ['#efeff1', '#ffffff', '#2f6df0'] },
  { id: 'dark', label: 'Escuro', swatch: ['#16171b', '#212227', '#6b9bff'] },
  { id: 'sepia', label: 'Sépia', swatch: ['#ece4d6', '#fffaf1', '#b05c25'] },
  { id: 'graphite', label: 'Grafite', swatch: ['#1a2029', '#232b36', '#3fc6b8'] }
];

export const FONTS = [
  { id: 'classic', label: 'Clássica', sample: 'Fraunces + Figtree', title: '"Fraunces Variable"', body: '"Figtree Variable"' },
  { id: 'modern', label: 'Moderna', sample: 'Inter', title: '"Inter Variable"', body: '"Inter Variable"' },
  { id: 'editorial', label: 'Editorial', sample: 'Source Serif + DM Sans', title: '"Source Serif 4 Variable"', body: '"DM Sans Variable"' },
  { id: 'rounded', label: 'Arredondada', sample: 'Nunito', title: '"Nunito Variable"', body: '"Nunito Variable"' }
];

const read = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch (_) { return fallback; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch (_) {} };

export const currentTheme = () => read('theme', 'auto');
export const currentFont = () => read('fontPair', 'classic');

const systemDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function applyAppearance() {
  let theme = currentTheme();
  if (theme === 'auto') theme = systemDark && systemDark.matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.font = currentFont();
  requestMinimap();
}

export function setTheme(id) { write('theme', id); applyAppearance(); }
export function setFont(id) { write('fontPair', id); applyAppearance(); }

function choice(cls, active, onPick, build) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls + (active ? ' on' : '');
  b.setAttribute('aria-pressed', String(active));
  build(b);
  b.onclick = () => { onPick(); openAppearance(); };
  return b;
}

export function openAppearance() {
  const wrap = document.createElement('div');
  wrap.className = 'appearance';
  const h1 = document.createElement('h3'); h1.textContent = 'Tema';
  const themes = document.createElement('div'); themes.className = 'theme-grid';
  for (const t of THEMES) {
    themes.appendChild(choice('theme-card', currentTheme() === t.id, () => setTheme(t.id), (b) => {
      const preview = document.createElement('span');
      preview.className = 'theme-preview';
      preview.style.background = t.id === 'auto' ? `linear-gradient(135deg, ${t.swatch[0]} 50%, ${t.swatch[1]} 50%)` : t.swatch[0];
      if (t.id !== 'auto') {
        const card = document.createElement('i'); card.style.background = t.swatch[1];
        const dot = document.createElement('b'); dot.style.background = t.swatch[2];
        card.appendChild(dot); preview.appendChild(card);
      }
      const name = document.createElement('span'); name.className = 'theme-name'; name.textContent = t.label;
      b.append(preview, name);
      if (t.hint) b.title = t.hint;
    }));
  }
  const h2 = document.createElement('h3'); h2.textContent = 'Fontes';
  const fonts = document.createElement('div'); fonts.className = 'font-grid';
  for (const f of FONTS) {
    fonts.appendChild(choice('font-card', currentFont() === f.id, () => setFont(f.id), (b) => {
      const aa = document.createElement('span'); aa.className = 'font-aa'; aa.textContent = 'Aa'; aa.style.fontFamily = f.title;
      const name = document.createElement('strong'); name.textContent = f.label; name.style.fontFamily = f.body;
      const sample = document.createElement('span'); sample.textContent = f.sample; sample.style.fontFamily = f.body;
      b.append(aa, name, sample);
    }));
  }
  wrap.append(h1, themes, h2, fonts);
  openPanel({ title: 'Aparência', body: wrap, wide: true, actions: [{ label: 'Pronto', primary: true, fn: closePanel }] });
}

export function initTheme() {
  applyAppearance();
  if (systemDark) systemDark.addEventListener('change', () => { if (currentTheme() === 'auto') applyAppearance(); });
}
