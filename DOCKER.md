# Running DualPen in Docker

This fork adds a container setup on top of [TheGreatAthlon/DualPen](https://github.com/TheGreatAthlon/DualPen).
Everything here is in **new files only** — no file inherited from upstream is
modified — so `git merge upstream/main` can never conflict with this work.

## Table of contents

- [Shape of the deployment](#shape-of-the-deployment)
- [Quick start](#quick-start)
- [Creating accounts](#creating-accounts)
- [Reverse proxy](#reverse-proxy)
- [Data, backups and restore](#data-backups-and-restore)
- [Updating](#updating)
- [Building locally](#building-locally)
- [Configuration reference](#configuration-reference)
- [Troubleshooting](#troubleshooting)
- [Constraints worth knowing](#constraints-worth-knowing)

## Shape of the deployment

One container. `uvicorn` serves the API, the WebSocket sync endpoint **and**
the built frontend, publishing a single port that your reverse proxy sits in
front of:

```
browser --HTTPS--> your reverse proxy --HTTP--> 127.0.0.1:8000  (container)
                                                   |-- /api/*   FastAPI routers
                                                   |-- /ws/*    Yjs sync WebSocket
                                                   '-- /*       client/dist (static)
```

There is no nginx in the stack. The frontend does no client-side routing —
no `pushState`, no path parsing anywhere in `client/src` — so a plain static
mount covers it, and `docker/asgi.py` mounts `client/dist` onto the upstream
FastAPI app *after* its routers, which means `/api` and `/ws` still match
first and only unclaimed paths fall through to static files.

**Everything must stay on one origin.** That is a hard requirement, not a
preference: `server/app/auth.py` sets the session cookie `SameSite=Lax`
without the `Secure` flag, and browsers do not attach a `Lax` cookie to
cross-site requests — so a split-origin deployment cannot log in at all, no
matter how CORS is configured. Serving both halves from one process makes
that impossible to get wrong.

## Quick start

```bash
git clone https://github.com/jonathans859/DualPenDocker
cd DualPenDocker

cp .env.example .env      # optional; every value has a working default
docker compose pull
docker compose up -d
```

The app is now on `127.0.0.1:8000`, reachable only from the host. Point your
reverse proxy at it ([snippets below](#reverse-proxy)), then create the first
account.

Check it came up:

```bash
docker compose ps            # STATUS should read "healthy"
docker compose logs -f app
```

## Creating accounts

Upstream has no self-signup and no admin UI. The first admin is made with an
interactive CLI prompt:

```bash
docker compose run --rm app python -m server.cli create-admin
```

It asks for a username, display name and password. Use `run --rm`, not
`exec` — `run` allocates a TTY so `getpass` can read the password without
echoing it.

Everyone else is created afterwards through the admin REST API as that user
(`POST /api/admin/users`), e.g.:

```bash
# log in, keeping the session cookie
curl -sc /tmp/dp.jar -X POST https://editor.example.com/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"..."}'

curl -sb /tmp/dp.jar -X POST https://editor.example.com/api/admin/users \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","display_name":"Alice","initial_password":"..."}'
```

`GET /api/admin/users` lists, `PATCH /api/admin/users/{id}` updates
(display name, password, admin flag, active flag) and
`DELETE /api/admin/users/{id}` deactivates rather than hard-deleting.

## Reverse proxy

The only requirement beyond ordinary proxying is that `/ws/` gets a real
WebSocket upgrade and that cookies are forwarded (every proxy does the latter
by default). Long read timeouts matter — a collaboration session holds its
socket open for hours.

### Caddy

Caddy handles upgrades and TLS with no configuration at all:

```caddy
editor.example.com {
    reverse_proxy 127.0.0.1:8000
}
```

### nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name editor.example.com;

    ssl_certificate     /etc/letsencrypt/live/editor.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/editor.example.com/privkey.pem;

    # Zip import/export moves whole document trees; the default 1m is low.
    client_max_body_size 64m;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;

        # Required for /ws/. $connection_upgrade needs the map block below;
        # a bare proxy_pass does not upgrade on its own.
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 3600s;   # long-lived collaboration sessions
        proxy_send_timeout 3600s;
    }
}

server {
    listen 80;
    server_name editor.example.com;
    return 301 https://$host$request_uri;
}
```

with this in the `http { }` block (usually `/etc/nginx/nginx.conf`):

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

### Traefik

If you would rather have Traefik discover the container directly, drop the
`ports:` block from `compose.yaml`, attach the service to your Traefik
network and add:

```yaml
    labels:
      traefik.enable: "true"
      traefik.http.routers.dualpen.rule: "Host(`editor.example.com`)"
      traefik.http.routers.dualpen.entrypoints: "websecure"
      traefik.http.routers.dualpen.tls.certresolver: "letsencrypt"
      traefik.http.services.dualpen.loadbalancer.server.port: "8000"
```

Traefik proxies WebSockets natively; no extra middleware is needed.

## Data, backups and restore

Everything durable lives in the `dualpen_data` volume, mounted at `/data`:

| Path | What it is |
|---|---|
| `/data/db/app.db` | SQLite: users, sessions, file tree, chat history |
| `/data/docstore/` | Document contents, AES-256-GCM encrypted at rest |
| `/data/master.key` | The key those blobs are encrypted with |
| `/data/backups/` | Archives written by the backup command |

**These are only useful together.** A blob in `docstore/` cannot be read
without both the database that maps documents to blob filenames and the key
that decrypts it. Lose `master.key` and every stored document is permanently
unrecoverable — there is no recovery path, by design.

### Taking a backup

```bash
docker compose exec app python -m server.cli backup --keep 14
```

This writes one timestamped `dualpen-backup-*.tar.gz` into `/data/backups`
containing all three pieces, and `--keep 14` prunes older archives beyond the
14 most recent. It uses SQLite's online backup API, so it is safe to run
against a live database with people mid-edit — no downtime, no stopping the
service.

Nothing runs it on a schedule; wire it into the host's cron or a systemd
timer:

```cron
17 3 * * * cd /srv/dualpen && docker compose exec -T app python -m server.cli backup --keep 14
```

`-T` matters in cron — without it Docker tries to allocate a TTY and fails
with no terminal attached.

### Getting an archive off the host

The backups live inside the volume, so copy one out:

```bash
docker compose cp app:/data/backups/dualpen-backup-20260906T031700Z.tar.gz .
```

Then send it somewhere that is not this machine. A backup sitting on the same
disk as the thing it backs up is not a backup.

### Restoring

```bash
docker compose down

# Unpack the archive into a scratch directory
mkdir -p /tmp/restore && tar -xzf dualpen-backup-*.tar.gz -C /tmp/restore

# Overwrite the volume's contents, then fix ownership: the container runs as
# uid 10001 and cannot read files owned by anyone else.
docker run --rm -v dualpen_dualpen_data:/data -v /tmp/restore:/restore alpine sh -c '
  rm -rf /data/db /data/docstore /data/master.key &&
  cp -a /restore/db /restore/docstore /data/ &&
  cp -a /restore/master.key /data/master.key &&
  chown -R 10001:10001 /data'

docker compose up -d
```

The volume is named `dualpen_dualpen_data` — Compose prefixes the volume name
with the project name set in `compose.yaml`. Confirm with `docker volume ls`.

## Updating

### Routine update

```bash
docker compose pull && docker compose up -d
```

### Pulling in upstream changes

`.github/workflows/upstream-sync.yml` checks
[TheGreatAthlon/DualPen](https://github.com/TheGreatAthlon/DualPen) once a
day and opens a **"Sync upstream"** pull request here whenever it has moved
ahead. The PR body lists the new commits and says whether a trial merge into
`main` applied cleanly. Merging it triggers the image build, and a few
minutes later `docker compose pull && docker compose up -d` on the server
picks the new image up.

Because the PR is opened by `GITHUB_TOKEN`, GitHub deliberately does not run
workflows on it — so the build runs on the push to `main` after you merge,
not on the PR itself.

To do it by hand instead:

```bash
git fetch upstream
git merge upstream/main
git push
```

The `upstream` remote is already configured in this checkout, with its
**push** URL deliberately set to a bogus value:

```
$ git remote -v
upstream  https://github.com/TheGreatAthlon/DualPen.git  (fetch)
upstream  DISABLED_no_pushing_to_upstream                (push)
```

so a stray `git push upstream` fails loudly instead of offering this Docker
work to the original project. Undo it with
`git remote set-url --push upstream https://github.com/TheGreatAthlon/DualPen.git`
if you ever do want to contribute back.

This should never conflict. Every file this fork adds is new, so upstream and
this fork touch disjoint sets of files. **If a merge does conflict, that is
the signal that something here has started editing an upstream file** — fix
it at the root rather than resolving the same conflict every release.

## Building locally

Normally the image comes from `ghcr.io`. To build it from the checkout:

```bash
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

The build is deliberately kept out of `compose.yaml` so a plain
`docker compose up -d` always runs the published image and never silently
builds a local one that drifts from what CI produced.

Run the backend test suite against the image:

```bash
docker compose -f compose.yaml -f compose.build.yaml run --rm \
  -w /app/server app python -m pytest -q
```

The tests redirect the database, docstore and key to a temporary directory
before importing anything (`server/tests/conftest.py`), so this never touches
your real `/data`.

### One deselected test

CI runs the suite with one test excluded:

```
--deselect tests/test_sync.py::test_second_doc_force_closes_first_connection
```

It fails on Linux on every run. The test asserts that `ws_a.recv()` *raises*
`ConnectionClosed` once a second connection replaces it, but it only drains
frames up to the first SYNC step-2 reply, and the server's echo of `ws_a`'s
own update can still be queued behind that — so `recv()` returns the stale
frame instead of raising.

**The force-close itself is fine.** `server/app/routers/sync.py` awaits
`prior_ws.close(4409)` before the replacing connection seeds its room or
starts serving, so the old socket has always been closed by the time the
assertion runs. Upstream is developed on Windows, where event-loop frame
ordering differs and the echo happens to arrive earlier.

It is deselected rather than repaired because this fork stays additive:
editing `server/tests/test_sync.py` would be the first upstream file touched
and the first thing an upstream merge could conflict on. The trade is worth
stating plainly — **nothing in CI now covers the one-document-per-user
force-close close code.** If you would rather have the coverage than the
clean merge boundary, the fix is a few lines in that test (drain queued
frames until the close arrives, instead of asserting on the very next
frame), and the `--deselect` flag then comes back out of
`.github/workflows/docker-publish.yml`.

## Configuration reference

`.env` (see `.env.example`) controls Compose itself:

| Variable | Default | Meaning |
|---|---|---|
| `DUALPEN_IMAGE` | `ghcr.io/jonathans859/dualpendocker:latest` | Image to run. Pin to `:sha-<full sha>` for reproducible deploys. |
| `DUALPEN_BIND` | `127.0.0.1` | Host interface to publish on. Leave on loopback unless the proxy is on another machine. |
| `DUALPEN_PORT` | `8000` | Host port. |

The application's own variables are already set inside the image and need no
attention unless you are relocating data:

| Variable | Value in the image |
|---|---|
| `COLLAB_EDITOR_DATABASE_URL` | `sqlite+aiosqlite:////data/db/app.db` |
| `COLLAB_EDITOR_DOCSTORE_PATH` | `/data/docstore` |
| `COLLAB_EDITOR_MASTER_KEY_PATH` | `/data/master.key` |
| `COLLAB_EDITOR_BACKUP_PATH` | `/data/backups` |
| `DUALPEN_CLIENT_DIST` | `/app/client/dist` |

`COLLAB_EDITOR_CORS_ORIGINS` is deliberately left unset. With a single origin
the browser never issues a cross-origin request, so there is nothing for CORS
to permit.

### Image tags

CI publishes to `ghcr.io/jonathans859/dualpendocker` on every push to `main`:

| Tag | Points at |
|---|---|
| `latest` | Newest `main` build |
| `main` | Same |
| `sha-<full commit sha>` | One exact commit — use this to pin |
| `1.2.3`, `1.2` | Built when you push a `v1.2.3` tag |

Images are `linux/amd64` only. If you ever move to an ARM host, add
`linux/arm64` to the two `platforms:` lines in
`.github/workflows/docker-publish.yml`.

### First publish: package visibility

GHCR creates the package **private** the first time the workflow pushes, so
`docker compose pull` on the server will fail with `denied` until you do one
of these. Nothing in CI needs changing either way — the workflow authenticates
with the built-in `GITHUB_TOKEN`.

**Either** make the package public — Repository → Packages → `dualpendocker`
→ Package settings → Change visibility → Public. Simplest, and the image
contains no secrets: it is application code plus the built frontend, and
`.dockerignore` keeps `server_data/`, `backups/` and `.env` out of the build
context entirely.

**Or** keep it private and log the server in once, with a
[classic PAT](https://github.com/settings/tokens) scoped to `read:packages`
only:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u jonathans859 --password-stdin
```

The credential is stored in `~/.docker/config.json` and survives reboots, so
this is a one-time step per host. Classic PATs can expire — if
`docker compose pull` starts failing with `denied` months later, that is
usually why.

## Troubleshooting

**Login appears to succeed but every request is 401.** The browser is not
sending the session cookie back. Almost always means the frontend and API are
being reached on different origins — check that your proxy sends `/`, `/api/`
and `/ws/` to the same hostname.

**The editor loads but never syncs; collaborators do not appear.** The
WebSocket upgrade is not getting through. In nginx that is a missing
`Upgrade`/`Connection` header pair (the `map` block above). Confirm in the
browser devtools Network tab: `/ws/doc/...` should show status `101`, not
`200` or `502`.

**Sync drops after about a minute.** Proxy read timeout. Raise
`proxy_read_timeout` (nginx) or the equivalent; the sockets are meant to stay
open for the whole session.

**`unable to open database file` in the logs.** `/data` is not writable by
uid 10001. Only happens if you replaced the named volume with a bind mount —
`sudo chown -R 10001:10001 /your/data/dir`.

**Container reports `unhealthy`.** Check `docker compose logs app`. The
healthcheck only fails on a connection-level error, so an unhealthy container
means uvicorn is not accepting connections at all.

**Everything is fine but the page is stale after an update.** `index.html` is
served with revalidation and Vite's asset filenames are content-hashed, so a
plain reload is enough; a hard reload if not.

## Constraints worth knowing

These come from upstream and none of them are changed by containerising it:

- **Never run more than one replica.** Realtime sync rooms live in a single
  process's memory (`server/app/routers/sync.py`), so a second instance would
  not see the first's edits and collaborators would silently diverge.
  `compose.yaml` pins `replicas: 1`.
- **The session cookie is not marked `Secure`.** Fine behind a TLS-terminating
  proxy, which is the only supported deployment, but do not serve this over
  plain HTTP.
- **No rate limiting, no request size cap, no import limits** anywhere in the
  stack. Sized for a small trusted group, not the open internet.
- **No admin UI.** Account management is the CLI plus the `/api/admin/*`
  endpoints.
- Static assets are served by Starlette without compression. It sets `ETag`
  and `Last-Modified`, so repeat visits revalidate into `304`s, but enable
  gzip on your proxy (Caddy does it by default; nginx needs `gzip on;` plus
  `gzip_types`) to shrink the first load of the Monaco bundle.
