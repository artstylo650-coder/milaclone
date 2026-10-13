'use strict';

const { db, stmt, id, rowToItem, itemsForCanvas } = require('./db');

// Transfers are atomic. Cut keeps identities; copy remaps the full subtree.
module.exports = db.transaction(({ ids, canvasId, x, y, move = false }) => {
  const bad = message => { const error = new Error(message); error.status = 400; throw error; };
  if (!Array.isArray(ids) || !ids.length || ids.length > 2000 || !stmt.getCanvas.get(canvasId)) bad('Seleção ou destino inválido');
  const selected = [...new Set(ids)].map(key => {
    const row = stmt.getItem.get(key);
    if (!row) bad('Um item selecionado não existe mais');
    return rowToItem(row);
  });
  const sourceId = selected[0].canvasId;
  if (selected.some(it => it.canvasId !== sourceId)) bad('A seleção precisa estar num único board');
  const source = itemsForCanvas(sourceId);
  const chosen = new Set(selected.map(it => it.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const it of source) {
      if (!chosen.has(it.id) && (chosen.has(it.parentItemId) || chosen.has(it.data.groupId))) {
        chosen.add(it.id); changed = true;
      }
    }
  }
  // lines travel only when both of their cards do
  for (const it of source) {
    if (it.type === 'line' && chosen.has(it.data.from) && chosen.has(it.data.to)) chosen.add(it.id);
  }
  // a line whose cards stay behind has nothing to connect at the destination
  for (const key of [...chosen]) {
    const it = source.find(row => row.id === key);
    if (it && it.type === 'line' && !(chosen.has(it.data.from) && chosen.has(it.data.to))) chosen.delete(key);
  }
  const items = source.filter(it => chosen.has(it.id));
  if (!items.length) bad('Selecione cards para copiar');
  const roots = items.filter(it => !chosen.has(it.parentItemId));
  // A card taken out of a column stores its row order in y, not a position:
  // place it where its column sits instead.
  const byId = new Map(source.map(it => [it.id, it]));
  const origin = new Map(roots.map(it => {
    const column = it.parentItemId && byId.get(it.parentItemId);
    return [it.id, column ? { x: column.x, y: column.y } : { x: it.x, y: it.y }];
  }));
  const placed = roots.filter(it => it.type !== 'line');
  const left = Math.min(...placed.map(it => origin.get(it.id).x));
  const top = Math.min(...placed.map(it => origin.get(it.id).y));
  const dx = (Number.isFinite(x) ? x : left + 24) - left;
  const dy = (Number.isFinite(y) ? y : top + 24) - top;
  const canvases = new Map();
  const allItems = [...items];
  function collect(rows) {
    for (const it of rows) {
      if (it.type !== 'board' || !it.data.childCanvasId) continue;
      const childId = it.data.childCanvasId;
      if (childId === sourceId || canvases.has(childId)) bad('Estrutura de boards circular inválida');
      const child = stmt.getCanvas.get(childId);
      if (!child) bad('Um board interno está faltando');
      canvases.set(childId, child);
      const children = itemsForCanvas(childId);
      allItems.push(...children);
      collect(children);
    }
  }
  collect(items);
  if (canvases.has(canvasId)) bad('Não é possível colar um board dentro dele mesmo');
  if (move) {
    for (const it of items) {
      const root = !chosen.has(it.parentItemId);
      const data = { ...it.data, groupId: chosen.has(it.data.groupId) ? it.data.groupId : null };
      stmt.updateItem.run({ ...it, canvasId, parentItemId: root ? null : it.parentItemId,
        x: root ? Math.round(origin.get(it.id).x + dx) : it.x,
        y: root ? Math.round(origin.get(it.id).y + dy) : it.y,
        data: JSON.stringify(data) });
      if (it.type === 'board') db.prepare('UPDATE canvases SET parentCanvasId = ? WHERE id = ?').run(canvasId, it.data.childCanvasId);
    }
    // a line left behind with one end on another board connects nothing
    for (const it of source) {
      if (it.type === 'line' && !chosen.has(it.id) && (chosen.has(it.data.from) || chosen.has(it.data.to)) && canvasId !== sourceId) {
        stmt.deleteItem.run(it.id);
      }
    }
    return { ids: items.map(it => it.id) };
  }
  const itemIds = new Map(allItems.map(it => [it.id, id('i_')]));
  const canvasIds = new Map([...canvases.keys()].map(key => [key, id('c_')]));
  for (const child of canvases.values()) {
    stmt.insertCanvas.run({ ...child, id: canvasIds.get(child.id),
      parentCanvasId: canvasIds.get(child.parentCanvasId) || canvasId,
      title: child.parentCanvasId === sourceId ? child.title + ' copy' : child.title,
      createdAt: Date.now() });
  }
  let z = (stmt.maxZ.get().m || 0) + 1;
  for (const it of allItems) {
    const topLevel = it.canvasId === sourceId && !chosen.has(it.parentItemId);
    const data = { ...it.data, groupId: itemIds.get(it.data.groupId) || null };
    delete data.locked;
    if (data.childCanvasId) data.childCanvasId = canvasIds.get(data.childCanvasId);
    if (it.type === 'line') { data.from = itemIds.get(data.from); data.to = itemIds.get(data.to); }
    if (Array.isArray(data.connections)) data.connections = data.connections
      .filter(c => itemIds.has(c.targetId)).map(c => ({ ...c, targetId: itemIds.get(c.targetId) }));
    stmt.insertItem.run({ ...it, id: itemIds.get(it.id),
      canvasId: canvasIds.get(it.canvasId) || canvasId,
      parentItemId: itemIds.get(it.parentItemId) || null,
      x: topLevel ? Math.round(origin.get(it.id).x + dx) : it.x,
      y: topLevel ? Math.round(origin.get(it.id).y + dy) : it.y,
      z: it.type === 'group' ? 0 : z++, data: JSON.stringify(data), createdAt: Date.now() });
  }
  return { ids: items.map(it => itemIds.get(it.id)) };
});
