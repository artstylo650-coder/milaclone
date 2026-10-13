'use strict';

import { state } from '../core/state.js';

// Comfy-style groups own cards by geometry. Prefer the smallest containing
// frame so nested/overlapping groups behave predictably.
export function groupAtRect(x, y, w = 1, h = 1, excludeId = null) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  return state.view.items
    .filter(item => item.type === 'group' && item.id !== excludeId)
    .filter(group => cx >= group.x && cx <= group.x + (group.w || 320) &&
      cy >= group.y && cy <= group.y + (group.h || 220))
    .sort((a, b) => (a.w || 320) * (a.h || 220) - (b.w || 320) * (b.h || 220))[0] || null;
}
