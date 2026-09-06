# syntax=docker/dockerfile:1

# DualPen as a single container: uvicorn serves /api, /ws and the built
# frontend from one port, so the browser always sees a single origin. That
# is not just convenience - the session cookie is set SameSite=Lax without
# the Secure flag (server/app/auth.py), and a browser will not attach a Lax
# cookie to a cross-site request, so a genuinely split-origin deployment
# cannot log in at all. Keeping one origin also means the frontend needs no
# build-time configuration and the backend needs no CORS entries.


# --- Stage 1: build the frontend -------------------------------------------
FROM node:22-alpine AS client

WORKDIR /build/client

# Manifests first: `npm ci` then re-runs only when dependencies actually
# change, not on every source edit.
COPY client/package.json client/package-lock.json ./
RUN npm ci

COPY client/ ./

# `npm run build` is `tsc && vite build`, so this step is also the frontend
# typecheck - a type error fails the image build rather than shipping.
RUN npm run build


# --- Stage 2: build the Python environment ---------------------------------
# Separate from the runtime stage so the compiler toolchain needed by any
# dependency without a prebuilt wheel (argon2-cffi, cffi) never reaches the
# published image.
FROM python:3.13-slim AS deps

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential libffi-dev \
 && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /tmp/build

# The test dependencies (pytest, httpx) come along with the runtime ones in
# upstream's single requirements.txt. Kept rather than trimmed: it is what
# lets CI run the real test suite inside the exact image it publishes.
COPY server/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --disable-pip-version-check -r requirements.txt


# --- Stage 3: runtime ------------------------------------------------------
FROM python:3.13-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/opt/venv/bin:$PATH" \
    PYTHONPATH=/app

# Upstream defaults put every piece of durable state in <repo>/server_data,
# which inside a container means the image layer - it would be discarded on
# the next `docker compose pull`. Point all four at /data, the one volume.
ENV COLLAB_EDITOR_DATABASE_URL=sqlite+aiosqlite:////data/db/app.db \
    COLLAB_EDITOR_DOCSTORE_PATH=/data/docstore \
    COLLAB_EDITOR_MASTER_KEY_PATH=/data/master.key \
    COLLAB_EDITOR_BACKUP_PATH=/data/backups \
    DUALPEN_CLIENT_DIST=/app/client/dist

WORKDIR /app

COPY --from=deps /opt/venv /opt/venv

COPY server/ ./server/
COPY docker/ ./docker/
COPY --from=client /build/client/dist ./client/dist

# A fixed uid keeps ownership predictable if /data is ever bind-mounted.
# /data is created here rather than only by the entrypoint so that Docker
# seeds a fresh named volume from it, inheriting this ownership - a volume
# mounted onto a path that does not exist in the image is created root-owned
# and the unprivileged process could not write to it.
# The home directory is created deliberately: Docker sets HOME from the passwd
# entry, and a HOME that does not exist turns any library reaching for a cache
# directory into a confusing permission error.
RUN useradd --system --uid 10001 --user-group --create-home --home-dir /home/dualpen dualpen \
 && mkdir -p /data/db /data/docstore /data/backups \
 && chown -R dualpen:dualpen /data

USER dualpen

EXPOSE 8000

VOLUME ["/data"]

# Deliberately a liveness check, not a correctness check: any HTTP response
# counts, so a missing frontend build does not mark a perfectly serving API
# unhealthy. See docker/healthcheck.py.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "/app/docker/healthcheck.py"]

# A Python entrypoint rather than a shell script on purpose: it is exec'd
# directly by the runtime, so there is no shebang line for a CRLF checkout on
# a Windows host to corrupt.
ENTRYPOINT ["python", "/app/docker/entrypoint.py"]
CMD ["uvicorn", "docker.asgi:app", "--host", "0.0.0.0", "--port", "8000"]
