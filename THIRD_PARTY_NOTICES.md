# Third-party references

## Milaclone original

This project is an expanded version of Milaclone, originally created by
Ellington Shephard (`@ellshep`):

- Upstream repository: https://github.com/ellshep/milaclone
- Upstream license: MIT
- Original copyright: Copyright (c) 2026 ellshep

The upstream license and copyright notice are preserved in `LICENSE`. The
current version adds substantial features including ComfyUI and RunPod
integration, Windows installation, translation, themes, connections, history,
trash, backups and export tools.

## ComfyUI Frontend / LiteGraph interaction model

The canvas selection and visual-group behavior was adapted with reference to
the ComfyUI Frontend sources at commit
`91e07cf1443d69b31e3b331cf4c0df90c4ee698a`:

- `src/lib/litegraph/src/CanvasPointer.ts`
- `src/lib/litegraph/src/LGraphCanvas.ts`
- `src/lib/litegraph/src/LGraphGroup.ts`
- `src/lib/litegraph/src/canvas/SelectedItemsView.ts`

Upstream repository: https://github.com/Comfy-Org/ComfyUI_frontend

Upstream license: GNU General Public License v3.0. The Milaclone
implementation uses its own DOM and persistence architecture; keep this notice
and review GPL-3.0 obligations before distributing a build containing code
derived from the upstream implementation.
