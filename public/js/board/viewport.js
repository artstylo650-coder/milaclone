'use strict';

import { state, dom } from '../core/state.js';
import { requestMinimap } from './minimap.js';

// Camera / pan / zoom for the infinite canvas, plus screen<->world mapping.

let camFrame = 0;
let saveTimer = 0;

function paintCam() {
  camFrame = 0;
  dom.world.style.transform = `translate(${state.cam.x}px, ${state.cam.y}px) scale(${state.cam.scale})`;
  dom.zoomLvl.textContent = Math.round(state.cam.scale * 100) + '%';
  requestMinimap();
}

export function applyCam() {
  // Pointer and wheel events can arrive faster than the screen can paint.
  // Coalesce them into one visual update per animation frame and keep the
  // synchronous localStorage write off the hot interaction path.
  if (!camFrame) camFrame = requestAnimationFrame(paintCam);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCam, 180);
}

export function screenToWorld(clientX, clientY) {
  const r = dom.stage.getBoundingClientRect();
  return { x: (clientX - r.left - state.cam.x) / state.cam.scale, y: (clientY - r.top - state.cam.y) / state.cam.scale };
}

export function viewportCenterWorld() {
  const r = dom.stage.getBoundingClientRect();
  return screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
}

// Pan (keeping the zoom, but at least 60%) so a world point sits mid-screen.
export function centerOn(wx, wy) {
  const r = dom.stage.getBoundingClientRect();
  state.cam.scale = Math.max(state.cam.scale, 0.6);
  state.cam.x = r.width / 2 - wx * state.cam.scale;
  state.cam.y = r.height / 2 - wy * state.cam.scale;
  applyCam();
}

export function saveCam() {
  if (state.view.canvas) localStorage.setItem('cam:' + state.view.canvas.id, JSON.stringify(state.cam));
}

window.addEventListener('pagehide', () => {
  if (camFrame) { cancelAnimationFrame(camFrame); paintCam(); }
  clearTimeout(saveTimer);
  saveCam();
});

export function loadCam(id) {
  try { const c = JSON.parse(localStorage.getItem('cam:' + id)); if (c && c.scale) return c; } catch (e) {}
  return { x: 80, y: 60, scale: 1 };
}

export function zoomBy(factor) {
  const r = dom.stage.getBoundingClientRect();
  const px = r.width / 2, py = r.height / 2;
  const wx = (px - state.cam.x) / state.cam.scale, wy = (py - state.cam.y) / state.cam.scale;
  state.cam.scale = Math.max(0.2, Math.min(2.5, state.cam.scale * factor));
  state.cam.x = px - wx * state.cam.scale; state.cam.y = py - wy * state.cam.scale; applyCam();
}

// Fit every top-level card into the visible stage, like a node editor's
// "zoom to fit" command. DOM sizes are used because text cards can auto-grow.
export function fitToItems(padding = 72) {
  const items = [...dom.world.children].filter(el => el.classList.contains('item'));
  if (!items.length) {
    state.cam = { x: 80, y: 60, scale: 1 };
    applyCam();
    return;
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const itemById = new Map(state.view.items.map(item => [item.id, item]));
  for (const el of items) {
    const item = itemById.get(el.dataset.id);
    if (!item) continue;
    minX = Math.min(minX, item.x || 0);
    minY = Math.min(minY, item.y || 0);
    maxX = Math.max(maxX, (item.x || 0) + el.offsetWidth);
    maxY = Math.max(maxY, (item.y || 0) + el.offsetHeight);
  }
  if (!Number.isFinite(minX)) return;

  const rect = dom.stage.getBoundingClientRect();
  const availableW = Math.max(1, rect.width - padding * 2);
  const availableH = Math.max(1, rect.height - padding * 2);
  const contentW = Math.max(1, maxX - minX);
  const contentH = Math.max(1, maxY - minY);
  const scale = Math.max(0.2, Math.min(2.5, 1, availableW / contentW, availableH / contentH));
  state.cam.scale = scale;
  state.cam.x = (rect.width - contentW * scale) / 2 - minX * scale;
  state.cam.y = (rect.height - contentH * scale) / 2 - minY * scale;
  applyCam();
}

// Two-finger pinch zoom for touch screens. Keeps the world point under the
// initial pinch midpoint anchored to the moving midpoint, so it also pans.
function initPinch() {
  const pts = new Map();
  let start = null;
  dom.stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      state.pinching = true;
      state.pan = null; dom.stage.classList.remove('panning');
      const [a, b] = [...pts.values()];
      start = { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, cam: { ...state.cam } };
    }
  });
  document.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!state.pinching || pts.size !== 2 || !start) return;
    const [a, b] = [...pts.values()];
    const r = dom.stage.getBoundingClientRect();
    const scale = Math.max(0.2, Math.min(2.5, start.cam.scale * (Math.hypot(a.x - b.x, a.y - b.y) / start.dist)));
    const wx = (start.cx - r.left - start.cam.x) / start.cam.scale;
    const wy = (start.cy - r.top - start.cam.y) / start.cam.scale;
    state.cam.scale = scale;
    state.cam.x = (a.x + b.x) / 2 - r.left - wx * scale;
    state.cam.y = (a.y + b.y) / 2 - r.top - wy * scale;
    applyCam();
  });
  const drop = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) { state.pinching = false; start = null; }
  };
  document.addEventListener('pointerup', drop);
  document.addEventListener('pointercancel', drop);
}

// Wire up the zoom controls and wheel handler. Called once at boot.
export function initViewport() {
  document.getElementById('zoomIn').onclick = () => zoomBy(1.2);
  document.getElementById('zoomOut').onclick = () => zoomBy(1 / 1.2);
  document.getElementById('zoomReset').onclick = () => fitToItems();

  dom.stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const r = dom.stage.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const wx = (px - state.cam.x) / state.cam.scale, wy = (py - state.cam.y) / state.cam.scale;
      const factor = Math.exp(-e.deltaY * 0.0015);
      state.cam.scale = Math.max(0.2, Math.min(2.5, state.cam.scale * factor));
      state.cam.x = px - wx * state.cam.scale; state.cam.y = py - wy * state.cam.scale;
    } else {
      state.cam.x -= e.deltaX; state.cam.y -= e.deltaY;
    }
    applyCam();
  }, { passive: false });

  initPinch();
}
