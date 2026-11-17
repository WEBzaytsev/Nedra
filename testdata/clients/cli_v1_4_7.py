import binascii
import os
import stat
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, NoReturn
from urllib.parse import quote, urlparse

import httpx
import typer
from rich.console import Console
from rich.markup import escape
from rich.table import Table

from helpers import generate_totp

app = typer.Typer(
    name="ciphermoth",
    help="Manage your self-hosted ciphermoth vault from the terminal.",
    no_args_is_help=True,
    rich_markup_mode="rich",
)
pw_app = typer.Typer(
    help="List, reveal, add, edit and delete vault entries.",
    no_args_is_help=True,
    rich_markup_mode="rich",
)
app.add_typer(pw_app, name="password")

_out = Console()
_err = Console(stderr=True)

_LABEL_WIDTH = 13
_KINDS = ("login", "note")
_CONFLICTS = ("skip", "overwrite")
_LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1")


def _api_url() -> str:
    return os.environ.get("CIPHERMOTH_API_URL", "http://localhost:8000/api").rstrip("/")


def _die(msg: str) -> NoReturn:
    _err.print(f"[red]✗[/red]  {escape(msg)}")
    raise typer.Exit(1)


def _ok(msg: str) -> None:
    _out.print(f"[green]✓[/green]  {msg}")


def _check(resp: httpx.Response) -> None:
    if resp.is_success:
        return

    try:
        payload = resp.json()
        detail = payload.get("detail") or payload.get("error") or resp.text
    except ValueError:
        detail = resp.text

    if resp.status_code == 429:
        _die(
            f"{detail} Every command unlocks the vault once, so a batch of them "
            f"can hit this. Raise CIPHERMOTH_RATE_LIMIT on the backend to lift it."
        )

    _die(str(detail))


def _warn_plaintext_transport() -> None:
    parsed = urlparse(_api_url())
    host = parsed.hostname or ""
    if parsed.scheme == "https" or host in _LOCAL_HOSTS:
        return

    _err.print(
        f"[yellow]![/yellow]  {escape(host)} is reached over plain HTTP, so your "
        f"master password crosses the network unencrypted. Put the API behind HTTPS."
    )


def _unlock(client: httpx.Client) -> tuple[str, str]:
    _warn_plaintext_transport()
    master = typer.prompt("Master password", hide_input=True)
    try:
        resp = client.post("/master_password/check", json={"master_password": master})
    except httpx.ConnectError:
        _die(f"Cannot reach the API at {_api_url()!r}. Is the service running?")

    _check(resp)
    data = resp.json()
    if not data.get("valid"):
        _die("Invalid master password.")

    key: str = data["key_derivation"]
    return master, key


def _entry(resp: httpx.Response, name: str) -> dict:
    _check(resp)
    item = resp.json()
    if not isinstance(item, dict):
        _die(
            f"'{name}' can't be opened by name. Rename the entry in the web UI "
            "to manage it from the CLI."
        )
    return item


def _hdr(key: str, name: str | None = None) -> dict[str, str]:
    headers = {"x-ciphermoth-key-derivation": key}
    if name is not None:
        headers["x-ciphermoth-entry"] = quote(name, safe="")
    return headers


def _routes_slash_names(client: httpx.Client) -> bool:
    try:
        features = client.get("/meta").json().get("features", [])
    except (httpx.HTTPError, ValueError, AttributeError):
        return False
    return "entry-names-with-slash" in features


def _entry_path(client: httpx.Client, name: str, suffix: str = "") -> str:
    if "/" in name and not _routes_slash_names(client):
        _die(
            "This server can't address entry names containing '/'. "
            "Update CipherMoth, or rename the entry in the web UI."
        )
    encoded = quote(name, safe="")
    if encoded in (".", ".."):
        encoded = encoded.replace(".", "%2E")
    return f"/passwords/{encoded}{suffix}"


def _optional(label: str, current: str | None = None) -> str | None:
    return (
        typer.prompt(label, default=current or "", show_default=bool(current)) or None
    )


def _prompt_secret(label: str) -> str:
    return typer.prompt(label, hide_input=True, confirmation_prompt=True)


def _prompt_optional_secret(label: str) -> str | None:
    value = typer.prompt(label, hide_input=True, default="", show_default=False)
    if not value:
        return None

    if typer.prompt("Repeat for confirmation", hide_input=True) != value:
        _die("The two entries did not match.")

    return value


def _totp_code(secret: str) -> str:
    try:
        return generate_totp(secret)
    except (binascii.Error, ValueError):
        return "unreadable 2FA secret"


def _detail_rows(item: dict) -> list[tuple[str, str]]:
    rows = [("Note" if item.get("kind") == "note" else "Value", item["password_value"])]

    for label, key in (("Username", "username"), ("URL", "url")):
        if item.get(key):
            rows.append((label, item[key]))

    if item.get("totp_secret"):
        rows.append(("2FA code", _totp_code(item["totp_secret"])))

    if item.get("folder"):
        rows.append(("Folder", item["folder"]))

    if item.get("tags"):
        rows.append(("Tags", ", ".join(item["tags"])))

    for field in item.get("custom_fields") or []:
        shown = "••••••••" if field.get("hidden") else field.get("value", "")
        rows.append((field["label"], shown))

    if item.get("description"):
        rows.append(("Description", item["description"]))

    return rows


def _print_details(item: dict) -> None:
    rows = _detail_rows(item)
    width = max([_LABEL_WIDTH, *(len(label) + 2 for label, _ in rows)])

    _out.print(f"\n  [bold cyan]{escape(item['password_name'])}[/bold cyan]")

    for label, value in rows:
        head, *rest = str(value).split("\n")
        padding = " " * (width - len(label))
        _out.print(f"  [dim]{escape(label)}[/dim]{padding}{escape(head)}")
        for line in rest:
            _out.print(f"  {' ' * width}{escape(line)}")

    _out.print()


@pw_app.command("list", help="List every entry in the vault.")
def pw_list() -> None:
    with httpx.Client(
        base_url=_api_url(), timeout=30, follow_redirects=False
    ) as client:
        _, key = _unlock(client)
        resp = client.get("/passwords", headers=_hdr(key))

    _check(resp)

    items: list[dict] = resp.json()
    if not items:
        _out.print("[dim]The vault is empty.[/dim]")
        return

    table = Table(show_header=True, header_style="bold", box=None, padding=(0, 2, 0, 0))
    table.add_column("Name", style="cyan")
    table.add_column("Description", style="dim")
    table.add_column("Backed up", justify="center")

    for item in items:
        table.add_row(
            escape(item["password_name"]),
            escape(item.get("description") or "-"),
            "[green]✓[/green]" if item["backed_up"] else "[dim]–[/dim]",
        )

    _out.print(table)


@pw_app.command("get", help="Reveal one entry, including its live 2FA code.")
def pw_get(name: Annotated[str, typer.Argument(help="Entry name.")]) -> None:
    with httpx.Client(
        base_url=_api_url(), timeout=30, follow_redirects=False
    ) as client:
        _, key = _unlock(client)
        resp = client.get(_entry_path(client, name), headers=_hdr(key, name))

    _print_details(_entry(resp, name))


@pw_app.command(
    "create", help="Add a login or a secure note, prompting for each field."
)
def pw_create(
    name: Annotated[str, typer.Argument(help="Name for the new entry.")],
    kind: Annotated[
        str, typer.Option("--kind", "-k", help="Entry type: login or note.")
    ] = "login",
) -> None:
    if kind not in _KINDS:
        _die("--kind must be 'login' or 'note'.")

    is_note = kind == "note"

    with httpx.Client(
        base_url=_api_url(), timeout=30, follow_redirects=False
    ) as client:
        _, key = _unlock(client)
        headers = _hdr(key, name)

        existing = client.get(_entry_path(client, name), headers=headers)
        if existing.is_success and isinstance(existing.json(), dict):
            _die(f"An entry named '{name}' already exists.")

        value = _prompt_secret("Note body" if is_note else "Password value")
        username = None if is_note else _optional("Username / email")
        url = None if is_note else _optional("URL")
        totp_secret = None if is_note else _optional("TOTP secret")
        description = _optional("Description")
        folder = _optional("Folder")
        resp = client.post(
            "/passwords/create",
            json={
                "password_name": name,
                "kind": kind,
                "username": username,
                "password_value": value,
                "url": url,
                "totp_secret": totp_secret,
                "description": description,
                "folder": folder,
            },
            headers=headers,
        )

    _check(resp)

    _ok(f"Created [cyan]{escape(name)}[/cyan]")


@pw_app.command(
    "update",
    help="Edit an entry. Leave a prompt blank to keep the current value.",
)
def pw_update(name: Annotated[str, typer.Argument(help="Entry name.")]) -> None:
    with httpx.Client(
        base_url=_api_url(), timeout=30, follow_redirects=False
    ) as client:
        _, key = _unlock(client)
        headers = _hdr(key, name)

        current = _entry(client.get(_entry_path(client, name), headers=headers), name)
        is_note = current.get("kind") == "note"

        secret_label = "New note" if is_note else "New password value"
        new_value = (
            _prompt_optional_secret(f"{secret_label} (blank to keep the current one)")
            or current["password_value"]
        )
        new_username = (
            None if is_note else _optional("Username / email", current.get("username"))
        )
        new_url = None if is_note else _optional("URL", current.get("url"))
        new_totp = (
            None if is_note else _optional("TOTP secret", current.get("totp_secret"))
        )
        new_description = _optional("Description", current.get("description"))
        new_folder = _optional("Folder", current.get("folder"))

        shared = {
            "password_name": name,
            "kind": current.get("kind", "login"),
            "tags": current.get("tags", []),
            "custom_fields": current.get("custom_fields", []),
            "favorite": current.get("favorite", False),
        }
        resp = client.patch(
            "/passwords/update",
            json={
                "password": {
                    **shared,
                    "username": current.get("username"),
                    "password_value": current["password_value"],
                    "url": current.get("url"),
                    "totp_secret": current.get("totp_secret"),
                    "description": current.get("description"),
                    "folder": current.get("folder"),
                },
                "new_password": {
                    **shared,
                    "username": new_username,
                    "password_value": new_value,
                    "url": new_url,
                    "totp_secret": new_totp,
                    "description": new_description,
                    "folder": new_folder,
                },
            },
            headers=headers,
        )

    _check(resp)

    _ok(f"Updated [cyan]{escape(name)}[/cyan]")


@pw_app.command("delete", help="Move an entry to the trash. It can be restored later.")
def pw_delete(
    name: Annotated[str, typer.Argument(help="Entry name.")],
    yes: Annotated[
        bool, typer.Option("--yes", "-y", help="Skip confirmation.")
    ] = False,
) -> None:
    with httpx.Client(
        base_url=_api_url(), timeout=30, follow_redirects=False
    ) as client:
        _, key = _unlock(client)
        headers = _hdr(key, name)

        exists = client.get(_entry_path(client, name), headers=headers)
        if exists.status_code == 404:
            _check(exists)

        if not yes:
            typer.confirm(f"Move '{name}' to trash?", abort=True)

        resp = client.delete(_entry_path(client, name), headers=headers)

    _check(resp)

    _ok(f"Moved [cyan]{escape(name)}[/cyan] to trash")


@pw_app.command("trash", help="List the entries waiting in the trash.")
def pw_trash() -> None:
    with httpx.Client(
        base_url=_api_url(), timeout=30, follow_redirects=False
    ) as client:
        _, key = _unlock(client)
        resp = client.get("/passwords/trash", headers=_hdr(key))

    _check(resp)

    items: list[dict] = resp.json()
    if not items:
        _out.print("[dim]The trash is empty.[/dim]")
        return

    table = Table(show_header=True, header_style="bold", box=None, padding=(0, 2, 0, 0))
    table.add_column("Name", style="cyan")
    table.add_column("Description", style="dim")
    table.add_column("Deleted", style="dim")

    for item in items:
        table.add_row(
            escape(item["password_name"]),
            escape(item.get("description") or "-"),
            (item.get("deleted") or "-")[:19].replace("T", " "),
        )

    _out.print(table)


@pw_app.command(
    "restore", help="Move an entry out of the trash and back into the vault."
)
def pw_restore(name: Annotated[str, typer.Argument(help="Entry name.")]) -> None:
    with httpx.Client(
        base_url=_api_url(), timeout=30, follow_redirects=False
    ) as client:
        _, key = _unlock(client)
        resp = client.post(
            _entry_path(client, name, "/restore"), headers=_hdr(key, name)
        )

    _check(resp)

    _ok(f"Restored [cyan]{escape(name)}[/cyan]")


@pw_app.command(
    "purge", help="Permanently delete a trashed entry. This cannot be undone."
)
def pw_purge(
    name: Annotated[str, typer.Argument(help="Entry name.")],
    yes: Annotated[
        bool, typer.Option("--yes", "-y", help="Skip confirmation.")
    ] = False,
) -> None:
    if not yes:
        typer.confirm(f"Permanently delete '{name}' from trash?", abort=True)

    with httpx.Client(
        base_url=_api_url(), timeout=30, follow_redirects=False
    ) as client:
        _, key = _unlock(client)
        resp = client.delete(
            _entry_path(client, name, "/purge"), headers=_hdr(key, name)
        )

    _check(resp)

    _ok(f"Permanently deleted [cyan]{escape(name)}[/cyan]")


@app.command(
    "backup", help="Export the vault as a ZIP encrypted with your master password."
)
def cmd_backup(
    out_dir: Annotated[
        Path, typer.Option("--out", "-o", help="Directory to save the backup file.")
    ] = Path("."),
) -> None:
    with httpx.Client(
        base_url=_api_url(), timeout=60, follow_redirects=False
    ) as client:
        master, key = _unlock(client)
        resp = client.post(
            "/passwords/backup",
            json={"master_password": master},
            headers=_hdr(key),
        )

    _check(resp)

    out_dir.mkdir(parents=True, exist_ok=True)
    filename = f"ciphermoth_backup_{datetime.now(UTC).strftime('%Y%m%d_%H%M%S')}.zip"
    dest = out_dir / filename
    dest.touch(mode=stat.S_IRUSR | stat.S_IWUSR)
    dest.chmod(stat.S_IRUSR | stat.S_IWUSR)
    dest.write_bytes(resp.content)

    _ok(f"Backup saved to [cyan]{escape(str(dest))}[/cyan]")


def _report_import(payload: dict) -> None:
    _ok(
        f"Import complete - "
        f"[cyan]{payload['imported']}[/cyan] added, "
        f"[cyan]{payload['overwritten']}[/cyan] overwritten, "
        f"[cyan]{payload['skipped']}[/cyan] skipped"
    )
    for key, title in (
        ("renamed", "were imported under a new name"),
        ("ignored", "were not imported"),
    ):
        count = payload.get(key, 0)
        if not count:
            continue
        _err.print(f"[yellow]![/yellow]  {count} record(s) {title}:")
        rows = payload.get(f"{key}_rows", [])
        for row in rows:
            name = f" ({row['name']})" if row.get("name") else ""
            _err.print(f"   {escape(row['where'] + name)}: {escape(row['reason'])}")
        if count > len(rows):
            _err.print(f"   and {count - len(rows)} more")


def _read_import_file(file: Path, on_conflict: str) -> bytes:
    if not file.exists():
        _die(f"File not found: {file}")

    if on_conflict not in _CONFLICTS:
        _die("--on-conflict must be 'skip' or 'overwrite'.")

    return file.read_bytes()


@app.command("import", help="Restore entries from a CipherMoth backup ZIP.")
def cmd_import(
    file: Annotated[Path, typer.Argument(help="Path to the ciphermoth backup ZIP.")],
    on_conflict: Annotated[
        str,
        typer.Option(
            help="How to handle existing entries: skip or overwrite.",
        ),
    ] = "skip",
) -> None:
    file_bytes = _read_import_file(file, on_conflict)

    with httpx.Client(
        base_url=_api_url(), timeout=60, follow_redirects=False
    ) as client:
        master, key = _unlock(client)
        resp = client.post(
            "/passwords/import",
            data={"master_password": master, "on_conflict": on_conflict},
            files={"file": (file.name, file_bytes, "application/zip")},
            headers=_hdr(key),
        )

    _check(resp)

    _report_import(resp.json())


@app.command(
    "import-csv",
    help="Import a CSV exported from Chrome, Bitwarden, KeePass or Proton Pass.",
)
def cmd_import_csv(
    file: Annotated[
        Path, typer.Argument(help="Path to a CSV exported from another manager.")
    ],
    on_conflict: Annotated[
        str,
        typer.Option(
            help="How to handle existing entries: skip or overwrite.",
        ),
    ] = "skip",
) -> None:
    file_bytes = _read_import_file(file, on_conflict)

    with httpx.Client(
        base_url=_api_url(), timeout=60, follow_redirects=False
    ) as client:
        _, key = _unlock(client)
        resp = client.post(
            "/passwords/import/csv",
            data={"on_conflict": on_conflict},
            files={"file": (file.name, file_bytes, "text/csv")},
            headers=_hdr(key),
        )

    _check(resp)

    _report_import(resp.json())


if __name__ == "__main__":
    app()
