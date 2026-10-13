'use strict';

import { state, dom, elMap } from '../core/state.js';
import { api } from '../core/api.js';
import { rid } from '../core/util.js';
import { render } from './cards.js';
import { select, enterEdit } from './editing.js';
import { groupAtRect } from './groups.js';

// Default shapes for each card type and the toolbar "place a new card" flow.

export function defaultsFor(type) {
  switch (type) {
    case 'note':    return { w: 240, data: { title: '', body: '' } };
    case 'todo':    return { w: 240, data: { title: 'Tarefas', tasks: [{ id: rid(), text: '', done: false }] } };
    case 'link':    return { w: 240, color: 'blue', data: { url: '', title: '' } };
    case 'column':  return { w: 252, data: { title: 'Coluna' } };
    case 'board':   return { w: 152, data: { title: 'Board sem nome' } };
    case 'comment': return { w: 220, data: { body: '' } };
    case 'file':    return { w: 220, data: {} };
    case 'group':   return { w: 320, h: 220, data: { title: 'Grupo' } };
    case 'comfy':   return { w: 340, data: { title: 'ComfyUI', prompt: '', negative: '', runs: 1, workflowId: null } };
    case 'node':    return { w: 260, data: { title: 'Node', inputs: ['input'], outputs: ['output'], connections: [] } };
    default:        return { w: 240, data: {} };
  }
}

export async function createAt(type, wx, wy) {
  const d = defaultsFor(type);
  if (type !== 'group') {
    const group = groupAtRect(wx, wy, d.w, d.h || 100);
    if (group) d.data = Object.assign({}, d.data, { groupId: group.id });
  }
  const body = Object.assign({ canvasId: state.view.canvas.id, type, x: Math.round(wx), y: Math.round(wy) }, d);
  const it = await api.create(body);
  state.view.items.push(it);
  render();
  select(it.id);
  if (!['board', 'image', 'file', 'comfy'].includes(type)) {
    const el = elMap.get(it.id); enterEdit(el); el.querySelector('[data-edit]')?.focus();
  }
  dom.hint.style.display = 'none';
  return it;
}
