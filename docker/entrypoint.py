"""Create the runtime data directories, then hand off to the real command.

server/app/db.py only creates the SQLite directory when DATABASE_URL still
points at the upstream default under <repo>/server_data; once it is pointed
at /data (as the image does) nothing creates /data/db, and SQLite will not
create a missing parent directory itself. The docstore and backup helpers do
mkdir their own directories, but doing it here too means `docker compose run
--rm app python -m server.cli create-admin` works on a first run against an
empty bind mount, not just against a named volume seeded from the image.

Kept in Python rather than shell so there is no shebang line for a CRLF
checkout on a Windows host to break.
"""

import os
import sys
from pathlib import Path

_SQLITE_PREFIX = "sqlite+aiosqlite:///"


def _data_dirs():
    url = os.environ.get("COLLAB_EDITOR_DATABASE_URL", "")
    if url.startswith(_SQLITE_PREFIX):
        # Strip the scheme, not the leading slash of the absolute path:
        # "sqlite+aiosqlite:////data/db/app.db" -> "/data/db/app.db".
        yield Path(url[len(_SQLITE_PREFIX):]).parent

    docstore = os.environ.get("COLLAB_EDITOR_DOCSTORE_PATH")
    if docstore:
        yield Path(docstore)

    backups = os.environ.get("COLLAB_EDITOR_BACKUP_PATH")
    if backups:
        yield Path(backups)

    key_path = os.environ.get("COLLAB_EDITOR_MASTER_KEY_PATH")
    if key_path:
        yield Path(key_path).parent


def main() -> None:
    for directory in _data_dirs():
        try:
            directory.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            # Almost always a bind mount owned by the wrong uid. Say so
            # plainly instead of letting SQLite fail with "unable to open
            # database file" several frames later.
            print(
                f"dualpen: cannot create {directory}: {exc}\n"
                f"dualpen: if /data is a bind mount, chown it to uid 10001 "
                f"(the 'dualpen' user inside the image).",
                file=sys.stderr,
            )
            raise SystemExit(1)

    if len(sys.argv) < 2:
        print("dualpen: no command given", file=sys.stderr)
        raise SystemExit(2)

    # exec so the real process becomes PID 1 and receives SIGTERM directly -
    # otherwise `docker compose stop` would wait out the full timeout and
    # kill uvicorn instead of letting it close WebSockets cleanly.
    os.execvp(sys.argv[1], sys.argv[1:])


if __name__ == "__main__":
    main()
