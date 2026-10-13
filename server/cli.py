import argparse
import asyncio
import getpass
import os
import sys
from pathlib import Path

from server import backup_service
from server.app.schemas import PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH
from server.app.db import AsyncSessionLocal, init_db
from server.app.user_service import create_user, UsernameTakenError


def _check_password(password: str) -> None:
    if not password.strip():
        print("Error: password cannot be blank", file=sys.stderr)
        sys.exit(1)
    if not PASSWORD_MIN_LENGTH <= len(password) <= PASSWORD_MAX_LENGTH:
        print(
            f"Error: password must be {PASSWORD_MIN_LENGTH}-{PASSWORD_MAX_LENGTH} characters",
            file=sys.stderr,
        )
        sys.exit(1)


async def create_admin(username: str, display_name: str, password: str) -> None:
    username = username.strip()
    display_name = display_name.strip() or username
    if not username or len(username) > 64 or len(display_name) > 100:
        print("Error: username must be 1-64 characters and display name at most 100", file=sys.stderr)
        sys.exit(1)
    _check_password(password)
    await init_db()
    async with AsyncSessionLocal() as db:
        try:
            await create_user(db, username=username, display_name=display_name, password=password, is_admin=True)
        except UsernameTakenError as e:
            print(f"Error: {e}", file=sys.stderr)
            sys.exit(1)
    print(f"Admin user '{username}' created.")


def _prompt_create_admin() -> None:
    username = input("Username: ").strip()
    display_name = input("Display name: ").strip()
    password = getpass.getpass("Password: ")
    confirm = getpass.getpass("Confirm password: ")
    if password != confirm:
        print("Error: passwords do not match", file=sys.stderr)
        sys.exit(1)
    asyncio.run(create_admin(username, display_name, password))


def _noninteractive_create_admin(
    username: str | None, display_name: str | None, password_stdin: bool
) -> None:
    username = (username or os.environ.get("COLLAB_EDITOR_ADMIN_USERNAME", "")).strip()
    if password_stdin:
        password = sys.stdin.readline().rstrip("\r\n")
    else:
        password = os.environ.get("COLLAB_EDITOR_ADMIN_PASSWORD", "")
    if not username:
        print("Error: username is required", file=sys.stderr)
        sys.exit(1)
    if not password.strip():
        print("Error: password is required (use --password-stdin or COLLAB_EDITOR_ADMIN_PASSWORD)", file=sys.stderr)
        sys.exit(1)
    asyncio.run(create_admin(username, (display_name or "").strip() or username, password))


def _run_backup(dest: str | None, keep: int | None) -> None:
    dest_dir = Path(dest) if dest else None
    if dest_dir is None:
        env_dest = os.environ.get("COLLAB_EDITOR_BACKUP_PATH")
        dest_dir = Path(env_dest) if env_dest else None
    archive_path = backup_service.run_backup(dest_dir, keep)
    print(f"Backup written to {archive_path}")


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m server.cli")
    subparsers = parser.add_subparsers(dest="command", required=True)
    create_admin_parser = subparsers.add_parser(
        "create-admin",
        help="Create an admin user (interactive by default; non-interactive with "
        "--username/--password-stdin or COLLAB_EDITOR_ADMIN_USERNAME/COLLAB_EDITOR_ADMIN_PASSWORD). "
        "Flags take precedence over environment variables. Password must be 8-256 characters.",
    )
    create_admin_parser.add_argument("--username", help="Admin username (non-interactive mode)")
    create_admin_parser.add_argument("--display-name", help="Display name (default: the username)")
    create_admin_parser.add_argument(
        "--password-stdin", action="store_true", help="Read the password from the first line of stdin"
    )

    backup_parser = subparsers.add_parser(
        "backup", help="Back up the database, document store, and encryption key into one archive"
    )
    backup_parser.add_argument(
        "--dest",
        help="Directory to write the backup archive into "
        "(default: $COLLAB_EDITOR_BACKUP_PATH, or <repo>/backups)",
    )
    backup_parser.add_argument(
        "--keep",
        type=int,
        help="Delete older archives in the destination directory beyond this count",
    )

    args = parser.parse_args()
    if args.command == "create-admin":
        if (
            args.username
            or args.password_stdin
            or os.environ.get("COLLAB_EDITOR_ADMIN_USERNAME")
            or os.environ.get("COLLAB_EDITOR_ADMIN_PASSWORD")
        ):
            _noninteractive_create_admin(args.username, args.display_name, args.password_stdin)
        else:
            _prompt_create_admin()
    elif args.command == "backup":
        _run_backup(args.dest, args.keep)


if __name__ == "__main__":
    main()
