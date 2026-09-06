"""Container healthcheck: is the ASGI app accepting and routing requests?

Any HTTP response counts as healthy, including a 404 - that still proves
uvicorn is up and serving, and docker/asgi.py deliberately starts without the
frontend build rather than refusing to run. Only a connection-level failure
(refused, timed out, DNS) means the container is actually unhealthy.

Override the target with DUALPEN_HEALTHCHECK_URL if you change the port the
CMD binds to.
"""

import os
import sys
import urllib.error
import urllib.request

URL = os.environ.get("DUALPEN_HEALTHCHECK_URL", "http://127.0.0.1:8000/")

try:
    urllib.request.urlopen(URL, timeout=4)
except urllib.error.HTTPError:
    pass
except Exception as exc:  # URLError, socket.timeout, OSError
    print(f"dualpen healthcheck: {URL}: {exc}", file=sys.stderr)
    sys.exit(1)
