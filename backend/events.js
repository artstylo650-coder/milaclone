'use strict';

// Live updates between devices. Browsers keep a Server-Sent Events stream
// open (GET /api/events); whenever a request, an undo or a finished ComfyUI
// job changes a board, every other client hears which canvases changed and
// re-fetches the one it shows. The originating tab (X-Client-Id) skips its
// own echo. Last write still wins; this only removes the need to reload.

const clients = new Set();

function subscribe(req, res) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const client = { res, id: String(req.query.client || '') };
  clients.add(client);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(client); });
}

// canvasIds: array, or 'all' (e.g. after a backup restore)
function publish(canvasIds, fromClient = '') {
  if (canvasIds !== 'all' && !canvasIds.length) return;
  const payload = `data: ${JSON.stringify({ canvasIds, from: fromClient })}\n\n`;
  for (const c of clients) if (!fromClient || c.id !== fromClient) c.res.write(payload);
}

module.exports = { subscribe, publish, count: () => clients.size };
