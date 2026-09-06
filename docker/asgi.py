"""ASGI entrypoint that serves the built frontend from the backend itself.

This is deliberately additive: it imports the upstream FastAPI app unchanged
and only mounts a static directory onto it, so no file this fork inherits
from upstream is ever edited and `git merge upstream/main` stays
conflict-free.

Why a static mount is enough here: the frontend does no client-side routing
at all - there is no pushState, popstate or path parsing anywhere in
client/src, and the whole app lives at `/`. So the `try_files $uri
/index.html` SPA fallback in the upstream nginx example has nothing to fall
back for, and StaticFiles(html=True) covers it.

Ordering matters. Starlette matches routes in the order they were added, and
server/app/main.py has already added every /api and /ws route by the time
this module imports it, so the catch-all mount below is reached only for
paths none of them claimed.
"""

import os
from pathlib import Path

from fastapi.staticfiles import StaticFiles

from server.app.main import app

_DIST = Path(os.environ.get("DUALPEN_CLIENT_DIST", "/app/client/dist"))

# Tolerate a missing build rather than refusing to start: the API and the
# WebSocket sync are still fully usable, which makes a broken frontend build
# obvious without also taking down anyone mid-edit.
if _DIST.is_dir():
    app.mount("/", StaticFiles(directory=_DIST, html=True), name="frontend")

__all__ = ["app"]
