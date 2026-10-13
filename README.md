# Milaclone: a self-hosted Milanote-style canvas board

An infinite visual canvas for notes, to-do lists, links, images, columns, and
nested boards. Runs as a small Node.js app with **no frontend build step** —
clone, `npm install`, `node server.js`. Your data lives in a single SQLite file
on disk, so it's trivial to back up and fully yours.

## Features

- Infinite pan/zoom canvas with a dotted grid
- Cards: **Note**, **To-do**, **Link**, **Comment**, **Image**, **Upload** (files),
  **Column**, **Board** (nested sub-canvas with Lucide icons)
- Nested boards with clickable breadcrumb navigation (Home / … / …)
- Drag cards freely, drag them in and out of columns, resize, recolor
- Customizable board icons (Lucide) + 12-color palette
- Right-click menu: copy, cut, paste, duplicate, rename, lock position, trash
- Everything autosaves to SQLite under `data/`
- Per-board camera position remembered in your browser
- Lines/arrows between cards, with labels
- Undo/redo, a 30-day trash, daily automatic snapshots and full backup/restore
- Search across every board (`Ctrl+K`), tags and a board filter
- Full-size image viewer, Markdown note formatting, align/distribute, snap to grid, minimap
- Export a board or a selection as PNG or PDF
- Live updates between open devices
- ComfyUI node: generate images on a local ComfyUI or RunPod Serverless, using connected photos as inputs

## Requirements

- Node.js 20.9 or newer (`node --version` to check)
- No database server and no Python needed. The only native dependency is
  [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3), which ships
  prebuilt binaries for common platforms; on other platforms `npm install`
  compiles it, which needs a C++ toolchain (`build-essential` on Debian/Ubuntu).

## Run it

```bash
npm install
npm start
```

Then open <http://localhost:4321>.

To use a different port:

```bash
PORT=8080 node server.js
```

## Run it with Docker

Same shape as the `reflections` deployment: its own Compose project, resource
capped, bound to loopback only, published to the tailnet by a Tailscale
sidecar. Two services come up — `app` (the Node server) and `tailscale` (its
own tailnet node).

The sidecar needs an auth key, so create a `.env` next to `docker-compose.yml`
first (it's gitignored):

```bash
echo 'TS_AUTHKEY=tskey-auth-…' > .env
```

Generate the key at
[login.tailscale.com/admin/settings/keys](https://login.tailscale.com/admin/settings/keys).
A reusable key is easiest; the node's state lives in the `milaclone_ts_state`
volume, so it won't need to re-authenticate on restart. Then:

```bash
docker compose up -d --build
```

The app itself listens on `127.0.0.1:8182` only — not on the LAN, not directly
on the tailnet (`8181` is taken by `reflections`). The sidecar is what puts it
on the tailnet, over HTTPS, at <https://mila.your-tailnet.ts.net> — see
[Access over Tailscale](#access-over-tailscale) below. On iPhone, Share → Add
to Home Screen gives it an app icon that opens fullscreen.

Data lives in three named volumes, so `docker compose down` keeps it:

| Volume                | Mounted at              | Holds                     |
|-----------------------|-------------------------|---------------------------|
| `milaclone_data`      | `/data`                 | `board.db` (SQLite)       |
| `milaclone_uploads`   | `/app/public/uploads`   | uploaded images/files     |
| `milaclone_ts_state`  | `/var/lib/tailscale`    | the sidecar's node identity |

Back up the board with:

```bash
docker compose cp app:/data/board.db ./backup-$(date +%F).db
```

To ship a new version, see [Deploying to the server](#deploying-to-the-server).
`docker compose down -v` wipes the volumes and resets to a blank canvas — it
also drops the tailnet node identity, so the next start re-authenticates.

## Access over Tailscale

### With Docker: the Tailscale sidecar

The Compose stack runs a `tailscale` service alongside the app. It joins your
tailnet as **its own node** — not as a path on the host's node — so the board
gets a clean URL of its own with `/` as the root:

```
https://mila.your-tailnet.ts.net
```

That matters because the app serves absolute paths (`/style.css`, `/uploads/*`),
which break under a path-prefixed proxy.

How the pieces fit:

| Piece                    | Where                              | Does what                                        |
|--------------------------|------------------------------------|--------------------------------------------------|
| `TS_AUTHKEY`             | `.env` (gitignored)                | Authenticates the node on first start            |
| `TS_HOSTNAME=mila`       | `docker-compose.yml`               | Names the node → `mila.your-tailnet.ts.net`      |
| `tailscale/serve.json`   | mounted at `/config/serve.json`    | Terminates HTTPS, proxies `/` → `app:4321`       |
| `milaclone_ts_state`     | volume at `/var/lib/tailscale`     | Remembers the node so restarts don't re-auth     |

The Serve config uses `${TS_CERT_DOMAIN}`, which the container substitutes at
startup, so it works on any tailnet without editing. Tailscale provisions the
TLS certificate itself. To change the hostname, edit `TS_HOSTNAME` and run
`docker compose up -d` — the node is renamed on next start.

Checking and troubleshooting:

```bash
docker compose logs tailscale                      # auth + serve errors show here
docker compose exec tailscale tailscale status     # is the node up?
docker compose exec tailscale tailscale serve status  # is / proxied to app:4321?
```

If `docker compose up` fails immediately with `set TS_AUTHKEY in .env`, the
`.env` file is missing or empty. If the node appears on the tailnet but the URL
returns nothing, the Serve config didn't load — check that `tailscale/serve.json`
exists as a **file** (a missing file makes Docker create an empty directory in
its place) and is valid JSON.

Traffic reaches the app over the private Compose network, so the app's
`127.0.0.1:8182` binding stays loopback-only and is never exposed.

### Without Docker: `tailscale serve` on the host

Running `npm start` directly, the server binds to `0.0.0.0`, so once the box is
on your tailnet it's reachable at `http://my-server.your-tailnet.ts.net:4321`
(`tailscale ip -4` or the MagicDNS name). For a clean HTTPS URL instead of
`:4321`:

```bash
sudo tailscale serve --bg 4321
```

That proxies `https://my-server.your-tailnet.ts.net` to the app on the host's
own tailnet node. `tailscale serve status` shows the mapping and
`sudo tailscale serve --bg off` stops it. Don't combine this with the sidecar —
pick one or the other.

## Deploying to the server

The server runs from a git checkout, so deploying is: move the checkout to the
commit you want, then rebuild the image. Code is baked into the image at build
time, so `docker compose restart` alone will **not** pick up changes.

Deploy the latest `main`:

```bash
cd ~/milaclone                  # wherever the checkout lives
git fetch origin
git checkout main
git pull --ff-only
docker compose up -d --build
```

Deploy a feature branch instead (e.g. to try a PR on the real device):

```bash
git fetch origin
git switch -c magicDNS origin/magicDNS   # first time for that branch
# git switch magicDNS && git pull --ff-only   # every time after
docker compose up -d --build
```

If `git checkout` refuses because the working tree is dirty — usually an edit
made directly on the server — either keep it with `git stash` (then
`git stash pop` later) or discard it with `git checkout -- .`.

Verify it came up:

```bash
docker compose ps                    # app + tailscale both "running"
curl -s localhost:8182/api/health    # {"ok":true}
docker compose logs -f app           # ctrl-C to stop following
```

Roll back by pointing the same loop at the previous commit:

```bash
git checkout <previous-sha>          # `git log --oneline` to find it
docker compose up -d --build
```

Worth knowing:

- **Your data survives.** The named volumes aren't touched by a rebuild, so
  boards and uploads carry across deploys and rollbacks. Never use
  `docker compose down -v` to deploy — that deletes them.
- **Most rebuilds are fast.** `npm ci` is a cached layer keyed on
  `package.json` / `package-lock.json`; only dependency changes trigger the slow
  path where `better-sqlite3` recompiles.
- **Only `app` rebuilds.** The `tailscale` service runs a published image, so
  `--build` leaves it alone unless its own config changed.
- **Rebuild after editing `public/`.** The frontend has no build step, but it's
  copied into the image, so a browser refresh alone won't show server-side
  changes until you rebuild.
- **Live-editing on the server:** `docker compose watch` syncs `public/` into the
  running container and restarts the backend on `server.js` / `routes.js` /
  `db.js` edits. Good for poking at something, but changes live only in that
  container until you commit and rebuild.

## Run it as a service (auto-start on boot)

Create `/etc/systemd/system/canvas-board.service` (adjust the paths and user):

```ini
[Unit]
Description=Canvas Board
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
WorkingDirectory=/home/YOUR_USERNAME/canvas-board
ExecStart=/usr/bin/node server.js
Environment=PORT=4321
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now canvas-board
sudo systemctl status canvas-board
```

## Windows app (no .bat to start)

Double-click **`Instalar Milaclone.bat`** once. It checks Node.js (and git, for
updates), installs the dependencies, and:

- registers a scheduled task that starts the server **hidden every time you log
  on to Windows** (`scripts/windows/servidor.ps1` keeps it running and starts it
  again if it stops);
- creates a **Milaclone** shortcut in the Start menu and on the Desktop that opens
  the app in its own window (Edge or Chrome in `--app` mode: no tabs, no address
  bar, own taskbar icon).

It is also a **PWA**: in Chrome/Edge, menu → *Instalar Milaclone* gives the same
window with an icon of its own (use either the shortcut or the PWA).
`Desinstalar Milaclone.bat` removes the task and shortcuts; your boards, uploads
and backups (`data/`, `public/uploads/`) are never touched. Logs: `data/server.log`,
`server.out.log`, `server.err.log`.

### Versions and updates

The version lives in `package.json` (see `CHANGELOG.md`) and is shown in
**⋯ → Sobre o Milaclone**, which also checks the git repository for newer commits
(once a day in the background too). **Atualizar agora** takes a database snapshot
(`data/backups/board-…-before-update.db`), pulls, reinstalls dependencies only if
`package.json` changed, restarts the server and reloads the page. Updating is only
possible from this computer (never through the network or Tailscale), and is
refused while program files have uncommitted edits. `Atualizar Milaclone.bat` does
the same from the command line. Database changes between versions are numbered
migrations in `backend/migrate.js`: each runs once, inside a transaction, after a
snapshot.

To publish a new version: bump `version` in `package.json`, add it to
`CHANGELOG.md`, commit, `git tag vX.Y.Z`, `git push --follow-tags`; the app sees the
new commits on its next check.

## Your data & backups

- Board content: `data/board.db` (SQLite; WAL mode also writes
  `board.db-wal` and `board.db-shm` alongside it)
- Uploaded images/files and ComfyUI results: `public/uploads/`

**Automatic snapshots.** The server copies the database to `data/backups/`
when it starts (if the last copy is over a day old) and then once a day,
keeping the newest 14. Set `BACKUP_DIR` to a folder on another disk or a NAS
so a dead drive does not take the backups with it.

**Full backup.** *More (⋯) → Download backup* saves a `.tar.gz` with the
database and every upload. *Restore from backup…* replaces all boards with an
archive's content; the current data is snapshotted first
(`board-…-before-restore.db`).

**Trash.** Deleted cards and boards (with everything inside) stay in
*More → Trash* for 30 days and can be restored. `Ctrl+Z` also undoes recent
changes in the current tab.

To reset to a blank canvas, stop the server and delete `data/board.db` (it'll
be recreated on next start).

## Configuration

All optional, via environment variables:

| Variable                 | Default            | Purpose                                         |
|--------------------------|--------------------|-------------------------------------------------|
| `PORT`                   | `4321`             | Port to listen on                               |
| `HOST`                   | `0.0.0.0`          | Bind address                                    |
| `DATA_DIR`               | `./data`           | Where the SQLite DB is written                  |
| `UPLOAD_DIR`             | `public/uploads`   | Where uploads are stored (served at `/uploads`) |
| `BACKUP_DIR`             | `DATA_DIR/backups` | Automatic snapshots                             |
| `BACKUP_INTERVAL_HOURS`  | `24`               | Time between snapshots                          |
| `BACKUP_KEEP`            | `14`               | Snapshots kept                                  |
| `TRASH_DAYS`             | `30`               | How long deleted cards stay in the trash        |
| `COMFYUI_URL`            | `http://127.0.0.1:8188` | Local ComfyUI server                       |
| `TRANSLATE_API`          | MyMemory                | Translation server (MyMemory-compatible)   |
| `RUNPOD_ENDPOINT_ID`     | —                  | RunPod Serverless endpoint (worker-comfyui 5.x) |
| `RUNPOD_API_KEY`         | —                  | RunPod API key (stays on the server)            |

The ComfyUI values can also be set in the app (*More → ComfyUI settings…*);
environment variables win.

## ComfyUI and RunPod

Add a **ComfyUI** node from the left rail (or double-click the canvas and type
"comfy"). Then:

1. Open *ComfyUI settings* (gear on the node) and choose **Local ComfyUI**
   (address of your ComfyUI) or **RunPod Serverless** (endpoint ID + API key of
   an endpoint running [worker-comfyui](https://github.com/runpod-workers/worker-comfyui) 5.x).
2. In ComfyUI, open your workflow and use **Workflow → Export (API)**; import
   that JSON in the settings panel.
3. The card is its picture: the newest result, large, with a title row on top
   (name, enhance, download, ⋯). Select it and a bar appears underneath with the
   prompt, quick choices as chips — **proporção** (drawn, with sizes in MP),
   **qualidade** (Rascunho 25% / Prévia 50% / Quase 75% / Final), **imagens por
   foto** and **seed** (repeat the same result, or the same seed for the whole
   batch) — a **Mais ajustes** button and the round **Gerar** button (Ctrl+Enter
   also works). Pick the workflow and each image input, write a negative prompt
   and tweak the workflow fields you chose in **Mais ajustes**. While it runs a
   ring with the count (and the current step on a local ComfyUI) covers the
   image, with a Stop button, and the frame glows.
   The card adapts to the workflow: a **text-to-image** one has just the prompt; an
   **edit** one (photo + prompt) shows what goes in, labels itself *Edição*, shows
   the original faded until the first result and has a **compare** button (hold
   it to see the original over the result); an **upscaler** such as SeedVR2 has
   no prompt at all — the lead choice is the **resolution** (1080 … 4096 px, or a
   factor) and the button says **Aprimorar**.
4. Connect cards to the node with lines. Each *Load Image* of the workflow is an
   **image slot** on the card; every slot picks its source (a photo, a group or
   column, or *Em branco* for a blank image), or "Automática" to take the next
   connected card. A **group** feeds one job per photo, so a group of three
   photos makes three images; with two groups, photos are paired by position.
   A **note** connected to the node is the prompt (the English twin when the
   note has a translation); the prompt box adds text after it.
5. *Escolher campos* (the sliders button in **Mais ajustes**) lists every plain
   value in the workflow (steps, size, LoRA strength, sampler…) so you can put the
   ones you want to tweak there. With a local ComfyUI running, choices and limits
   come from ComfyUI itself; a node's width and height become a drawn picker.
6. Press **Gerar**. Results appear as image cards in a group **under** the
   source group or photo (next to the node when there is none, or under
   everything with a dashed line back when something is in the way); each new
   batch stacks below the previous one so you can pick the best. **Parar**
   cancels what is still queued or running.
7. **Qualidade** below Final reduces the workflow's size fields (width, height,
   resolution, megapixels… — you choose which under *Escolher campos → teste*)
   so a sequence can be tried quickly; set it back to Final for the real run.

**Long runs.** Jobs are never given up on while ComfyUI still has them (it runs
queued jobs one after another, so the third image of a slow model waits for the
first two); a job is only reported lost when ComfyUI no longer knows it. If one
was given up on anyway, *Recuperar imagens que não chegaram* on the card (and a
server restart) fetches the finished images again.

**Turning ComfyUI on.** In the settings, *Arquivo para ligar o ComfyUI* takes the
full path of your start file (for the portable build, `run_nvidia_gpu.bat`).
With it set, **Gerar** starts ComfyUI when it is off and waits until it answers,
and *Ligar agora* does it on demand. It only works from the computer running
both, and the file can only be set from there (never through the network or
Tailscale). On RunPod the equivalent is the endpoint's *cold start*, when a
worker boots for the first job (the card shows the batch as queued meanwhile).

### Enhancing (upscale)

Every image has an **enhance icon** (always visible on generated ones). It opens
the options: the *enhancer* (any one-image workflow, such as SeedVR2), its
fields, the test size and **which images** — this one, the selection, the whole
group, or every board image not enhanced yet (up to 64 per run). Shift-click the
icon, or use *Aprimorar com os últimos ajustes* in the right-click menu, to run
straight away. The same dialog opens from the right-click menu, the selection
bar and *⋯ → Aprimorador (upscale)…*.
Results are framed under the group the images are in (or beside it, or under
everything with a dashed line back when something is in the way — they never
cover other cards), marked *Aprimorada*, and the original gets a check. Workflows that end in a Preview node instead of Save
Image work too.

Prompt and negative prompt go into the text nodes feeding the sampler. On
RunPod each variation is its own job, so several workers can render in
parallel; input photos are resized to at most 2048 px to stay under RunPod's
10 MB request limit. Workflows must be exported with *Export (API)*; ones that
use subgraphs are flattened by that export.

## Tech stack

- **Backend:** [Express](https://expressjs.com/) with
  [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) for storage and
  [`multer`](https://github.com/expressjs/multer) for uploads
- **Frontend:** vanilla JavaScript, HTML, and CSS in `public/` — no bundler, no
  framework

## Development

```bash
npm test        # API + ComfyUI bridge tests (node --test)
npm run qa      # backend tests + all Chromium end-to-end tests (silent on success)
npm run test:e2e   # Playwright end-to-end tests
```

The Playwright tests drive a real browser, so run
`npx playwright install` once beforehand to fetch the browser binaries.

## Not included (yet)

Freehand drawing/sketch cards, comments threads, and merging of simultaneous
edits (changes reach other open devices live, but the last write wins).

## Keyboard shortcuts

- `N` note · `L` link · `T` to-do · `B` board · `C` column · `M` comment
- `Ctrl+K` or `/` search all boards and run commands · double-click empty canvas to add a card there
- `Ctrl+Z` undo · `Ctrl+Shift+Z` / `Ctrl+Y` redo
- `Ctrl+C` copy · `Ctrl+X` cut · `Ctrl+V` paste · `Ctrl+D` duplicate · `Ctrl+A` select all
- `Ctrl+G` group · `Ctrl+Shift+G` ungroup · `F` fit board to screen
- Arrow keys move the selection (`Shift` = 10 px); hold `Space` and drag to pan
- `Enter` edit the selected card · `Esc` leave the field, then deselect
- `Delete` / `Backspace` move the selection to the trash
- In a note: `Ctrl+B` bold, `Ctrl+I` italic (Markdown)
- In the image viewer: `←`/`→` previous/next, `+`/`-` zoom, `0` fit, `Esc` close

## License

[MIT](LICENSE)
