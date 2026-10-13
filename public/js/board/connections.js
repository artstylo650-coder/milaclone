'use strict';

import { state, dom, elMap } from '../core/state.js';
import { api } from '../core/api.js';
import { colorVar, toast } from '../core/util.js';
import { screenToWorld } from './viewport.js';
import { select } from './editing.js';
import { showMenu, openPalette } from '../ui/menus.js';
import { openPanel, closePanel } from '../ui/panel.js';
import { createAt } from './create.js';
import { refreshItem } from './cards.js';
import { requestMinimap } from './minimap.js';

// The SVG layer under the cards. It draws two kinds of links:
// - lines: `line` items connecting any two cards (data.from / data.to), with an
//   optional label, arrowheads and dash style;
// - node links: output port -> input port wiring stored on `node` items.

const SVG_NS = 'http://www.w3.org/2000/svg';
let preview = null;
let frame = 0;

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function layer() {
  let svg = dom.world.querySelector(':scope > .connections-layer');
  if (!svg) {
    svg = svgEl('svg', { class: 'connections-layer', 'aria-hidden': 'true' });
    dom.world.prepend(svg);
  }
  return svg;
}

// Line labels sit in their own layer above the cards, so a short line
// between two close cards never hides its text under them.
function labelLayer() {
  let svg = dom.world.querySelector(':scope > .labels-layer');
  if (!svg) {
    svg = svgEl('svg', { class: 'labels-layer', 'aria-hidden': 'true' });
    dom.world.appendChild(svg);
  }
  return svg;
}

function pointFor(nodeId, kind, slot = 0) {
  const escaped = CSS.escape(nodeId);
  const port = dom.world.querySelector(`.node-port.${kind}[data-node-id="${escaped}"][data-slot="${slot}"]`);
  if (!port) return null;
  const r = port.getBoundingClientRect();
  return screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
}

function curve(a, b) {
  const bend = Math.max(48, Math.abs(b.x - a.x) * .45);
  return `M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`;
}

function addPath(svg, a, b, cls = '') {
  svg.appendChild(svgEl('path', { class: 'node-connection' + (cls ? ' ' + cls : ''), d: curve(a, b) }));
}

// World-space box of a rendered card (works for cards inside columns too).
// Layout offsets are used instead of getBoundingClientRect so the result does
// not depend on whether the camera transform has been painted yet.
function rectOf(id) {
  const el = elMap.get(id);
  if (!el || !el.isConnected || !el.classList.contains('item')) return null;
  let x = 0, y = 0;
  for (let node = el; node && node !== dom.world; node = node.offsetParent) {
    x += node.offsetLeft; y += node.offsetTop;
  }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

const centerOf = r => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

// Where the segment from the box centre towards `toward` leaves the box.
function edgePoint(r, toward, gap = 6) {
  const c = centerOf(r);
  const dx = toward.x - c.x, dy = toward.y - c.y;
  if (!dx && !dy) return c;
  const t = Math.min(dx ? (r.w / 2 + gap) / Math.abs(dx) : Infinity, dy ? (r.h / 2 + gap) / Math.abs(dy) : Infinity);
  return { x: c.x + dx * Math.min(t, 1), y: c.y + dy * Math.min(t, 1) };
}

function arrowHead(tip, from, size = 11) {
  const ang = Math.atan2(tip.y - from.y, tip.x - from.x);
  const p = a => `${tip.x - size * Math.cos(ang + a)} ${tip.y - size * Math.sin(ang + a)}`;
  return `M ${tip.x} ${tip.y} L ${p(.45)} L ${p(-.45)} Z`;
}

function drawLine(svg, line) {
  const ra = rectOf(line.data.from), rb = rectOf(line.data.to);
  if (!ra || !rb) return;
  const a = edgePoint(ra, centerOf(rb)), b = edgePoint(rb, centerOf(ra));
  const color = colorVar(line.color || 'slate');
  const g = svgEl('g', { class: 'line-link' + (state.selectedIds.has(line.id) ? ' selected' : ''), 'data-line-id': line.id });
  g.style.color = color;
  const d = `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  const hit = svgEl('path', { class: 'line-hit', d });
  const path = svgEl('path', { class: 'line-path' + (line.data.dashed ? ' dashed' : ''), d });
  g.append(hit, path);
  const arrow = line.data.arrow || 'end';
  if (arrow === 'end' || arrow === 'both') g.appendChild(svgEl('path', { class: 'line-head', d: arrowHead(b, a) }));
  if (arrow === 'both') g.appendChild(svgEl('path', { class: 'line-head', d: arrowHead(a, b) }));
  if (line.data.label) {
    const text = svgEl('text', { class: 'line-label', 'data-line-id': line.id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 6, 'text-anchor': 'middle' });
    text.textContent = line.data.label;
    if (state.selectedIds.has(line.id)) text.classList.add('selected');
    labelLayer().appendChild(text);
  }
  hit.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || state.spacePanning) return;
    e.stopPropagation();
    select(line.id, { toggle: e.shiftKey });
  });
  hit.addEventListener('dblclick', (e) => { e.stopPropagation(); editLineLabel(line); });
  hit.addEventListener('contextmenu', (e) => openLineCtx(e, line));
  svg.appendChild(g);
  elMap.set(line.id, g);
}

export function renderConnections() {
  requestMinimap();
  const svg = layer();
  svg.replaceChildren();
  labelLayer().replaceChildren();
  for (const item of state.view.items) {
    if (item.type === 'line') drawLine(svg, item);
    if (item.type !== 'node') continue;
    for (const connection of (item.data.connections || [])) {
      const a = pointFor(item.id, 'output', connection.output || 0);
      const b = pointFor(connection.targetId, 'input', connection.input || 0);
      if (a && b) addPath(svg, a, b);
    }
  }
  if (preview && preview.kind === 'node') addPath(svg, preview.from, preview.to, 'preview');
  if (preview && preview.kind === 'line') {
    const ra = rectOf(preview.sourceId);
    if (ra) {
      const tr = preview.targetId && rectOf(preview.targetId);
      const end = tr ? edgePoint(tr, centerOf(ra)) : preview.to;
      const start = edgePoint(ra, end);
      svg.appendChild(svgEl('path', { class: 'line-path preview', d: `M ${start.x} ${start.y} L ${end.x} ${end.y}` }));
    }
  }
}

export function queueConnections() {
  if (frame) return;
  frame = requestAnimationFrame(() => { frame = 0; renderConnections(); });
}

// ---- lines -----------------------------------------------------------------

async function updateLine(line, patch) {
  line.data = Object.assign({}, line.data, patch);
  renderConnections();
  await api.patch(line.id, { data: patch });
}

export async function createLine(fromId, toId) {
  const line = await api.create({
    canvasId: state.view.canvas.id, type: 'line', x: 0, y: 0, w: 0,
    data: { from: fromId, to: toId, arrow: 'end' }
  });
  if (line.error) { toast('Não foi possível ligar'); return null; }
  state.view.items.push(line);
  renderConnections();
  // a ComfyUI node shows how many photos feed it
  const target = state.view.items.find(it => it.id === toId);
  if (target && target.type === 'comfy') refreshItem(target);
  return line;
}

function cardUnder(clientX, clientY, sourceId) {
  const el = document.elementFromPoint(clientX, clientY)?.closest('.item');
  if (!el || el.dataset.id === sourceId || el.classList.contains('type-group')) return null;
  return el;
}

// Drag from a card's link handle: drop on another card to connect them, or on
// empty canvas to create a note there already connected.
export function startLinkDrag(e, source) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  const start = { x: e.clientX, y: e.clientY };
  preview = { kind: 'line', sourceId: source.id, to: screenToWorld(e.clientX, e.clientY), targetId: null };
  dom.stage.classList.add('linking');
  const clear = () => dom.world.querySelectorAll('.item.link-target').forEach(el => el.classList.remove('link-target'));
  const move = (ev) => {
    preview.to = screenToWorld(ev.clientX, ev.clientY);
    clear();
    const target = cardUnder(ev.clientX, ev.clientY, source.id);
    preview.targetId = target ? target.dataset.id : null;
    if (target) target.classList.add('link-target');
    queueConnections();
  };
  const up = async (ev) => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    dom.stage.classList.remove('linking');
    clear();
    const targetId = preview.targetId;
    const to = preview.to;
    preview = null;
    renderConnections();
    if (targetId) {
      const exists = state.view.items.some(it => it.type === 'line' &&
        ((it.data.from === source.id && it.data.to === targetId) || (it.data.from === targetId && it.data.to === source.id)));
      if (exists) { toast('Já estão ligados'); return; }
      const line = await createLine(source.id, targetId);
      if (line) select(line.id);
    } else if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 40 && !ev.target.closest('#rail, #topbar')) {
      chooseLinkedCard(source, to, ev.clientX, ev.clientY);
    }
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

// Dropping a link on empty canvas asks which card to create there, already
// connected to the source.
const LINKED_TYPES = [
  ['note', 'Nota', 'N'], ['todo', 'Lista de tarefas', 'T'], ['link', 'Link', 'L'],
  ['column', 'Coluna', 'C'], ['board', 'Board', 'B'], ['comment', 'Comentário', 'M'], ['comfy', 'Node ComfyUI', '']
];
function chooseLinkedCard(source, to, clientX, clientY) {
  showMenu(LINKED_TYPES.map(([type, label, hint]) => ({ label, hint, fn: async () => {
    const card = await createAt(type, to.x - 120, to.y - 30);
    if (card) await createLine(source.id, card.id);
  } })), clientX, clientY);
}

function editLineLabel(line) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = line.data.label || '';
  input.placeholder = 'ex.: inspirado em, substitui, etapa 2';
  input.maxLength = 120;
  const save = () => { updateLine(line, { label: input.value.trim() }); closePanel(); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  openPanel({ title: 'Texto da seta', body: input, actions: [{ label: 'Cancelar', fn: closePanel }, { label: 'Salvar', primary: true, fn: save }] });
  input.select();
}

function openLineCtx(e, line) {
  e.preventDefault(); e.stopPropagation();
  if (!state.selectedIds.has(line.id)) select(line.id);
  const arrow = line.data.arrow || 'end';
  const anchor = { getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }) };
  showMenu([
    { label: line.data.label ? 'Editar texto…' : 'Adicionar texto…', fn: () => editLineLabel(line) },
    { label: (arrow === 'end' ? '✓ ' : '') + 'Seta no fim', fn: () => updateLine(line, { arrow: 'end' }) },
    { label: (arrow === 'both' ? '✓ ' : '') + 'Setas nas duas pontas', fn: () => updateLine(line, { arrow: 'both' }) },
    { label: (arrow === 'none' ? '✓ ' : '') + 'Sem setas', fn: () => updateLine(line, { arrow: 'none' }) },
    { label: 'Inverter direção', fn: () => updateLine(line, { from: line.data.to, to: line.data.from }) },
    { label: line.data.dashed ? 'Linha contínua' : 'Linha tracejada', fn: () => updateLine(line, { dashed: !line.data.dashed }) },
    { label: 'Cor…', fn: () => openPalette(line, anchor, 'color') },
    { sep: true },
    { label: 'Excluir seta', hint: 'Delete', danger: true, fn: async () => {
      await api.remove(line.id);
      state.view.items = state.view.items.filter(it => it.id !== line.id);
      state.selectedIds.delete(line.id);
      renderConnections();
    } }
  ], e.clientX, e.clientY);
}

// ---- node ports ------------------------------------------------------------

export function startNodeConnection(e, source, port) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  const from = pointFor(source.id, 'output', Number(port.dataset.slot) || 0);
  if (!from) return;
  preview = { kind: 'node', from, to: from };
  renderConnections();

  const move = (ev) => {
    preview.to = screenToWorld(ev.clientX, ev.clientY);
    document.querySelectorAll('.node-port.input.connect-target').forEach(el => el.classList.remove('connect-target'));
    document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.node-port.input')?.classList.add('connect-target');
    queueConnections();
  };
  const up = async (ev) => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.node-port.input');
    document.querySelectorAll('.node-port.input.connect-target').forEach(el => el.classList.remove('connect-target'));
    preview = null;
    if (target && target.dataset.nodeId !== source.id) {
      const next = Array.isArray(source.data.connections) ? [...source.data.connections] : [];
      const connection = {
        targetId: target.dataset.nodeId,
        output: Number(port.dataset.slot) || 0,
        input: Number(target.dataset.slot) || 0
      };
      if (!next.some(c => c.targetId === connection.targetId && c.output === connection.output && c.input === connection.input)) {
        next.push(connection);
        source.data.connections = next;
        await api.patch(source.id, { data: { connections: next } });
      }
    }
    renderConnections();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}
