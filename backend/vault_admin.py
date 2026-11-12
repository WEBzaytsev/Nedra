from pathlib import Path
from typing import Annotated

import typer

import storage
from settings import get_storage_settings, get_vault_defaults

app = typer.Typer(
    help=(
        "Vault file maintenance: consistent snapshots, integrity checks and "
        "restores. Snapshots copy the encrypted vault as it is; they open only "
        "with the master password that was current when they were taken."
    ),
    no_args_is_help=True,
)


def _data_dir() -> Path:
    return get_storage_settings().data_dir


def _fail(error: storage.StorageError) -> typer.Exit:
    typer.echo(f"Error: {error}", err=True)
    return typer.Exit(1)


@app.command(help="Copy the vault to a new snapshot file. Safe while running.")
def snapshot(
    output: Annotated[
        Path | None,
        typer.Option(help="Where to write the snapshot (default: data/snapshots)."),
    ] = None,
) -> None:
    try:
        path = storage.snapshot(_data_dir(), output)
    except storage.StorageError as error:
        raise _fail(error) from None
    typer.echo(f"Snapshot written: {path}")


@app.command(help="Check a vault or snapshot file (default: the live vault).")
def check(path: Annotated[Path | None, typer.Argument()] = None) -> None:
    target = path or storage.vault_file(_data_dir())
    try:
        problems = storage.check_file(target)
    except storage.StorageError as error:
        raise _fail(error) from None
    if problems:
        for problem in problems[:20]:
            typer.echo(f"Problem: {problem}", err=True)
        raise typer.Exit(1)
    typer.echo(f"{target}: ok")


@app.command(
    help=(
        "Replace the vault with a snapshot. Stop CipherMoth first; the replaced "
        "vault is kept in the snapshot folder."
    )
)
def restore(
    path: Path,
    yes: Annotated[bool, typer.Option("--yes", help="Do not ask to confirm.")] = False,
) -> None:
    if not yes:
        typer.confirm(f"Replace the vault in {_data_dir()} with {path}?", abort=True)
    try:
        kept = storage.restore(_data_dir(), path)
    except storage.StorageError as error:
        raise _fail(error) from None
    if kept is not None:
        typer.echo(f"The replaced vault was kept as {kept}")
    typer.echo("Restored. Start CipherMoth and unlock with that snapshot's password.")


@app.command(
    "reset-settings",
    help=(
        "Discard saved administrator settings and inherit environment defaults. "
        "Stop CipherMoth first; a rollback snapshot is kept."
    ),
)
def reset_settings(
    yes: Annotated[bool, typer.Option("--yes", help="Do not ask to confirm.")] = False,
) -> None:
    get_vault_defaults()  # Refuse invalid environment defaults before changing data.
    if not yes:
        typer.confirm(
            "Discard saved settings and inherit the server defaults?", abort=True
        )
    try:
        saved = storage.reset_settings(_data_dir())
    except storage.StorageError as error:
        raise _fail(error) from None
    typer.echo(f"Settings reset. Rollback snapshot: {saved}")


@app.command(
    "migrate-users",
    help=(
        "Upgrade a stopped upstream CipherMoth 3.1 vault to the multi-user "
        "schema. A rollback snapshot is created first."
    ),
)
def migrate_users(
    yes: Annotated[bool, typer.Option("--yes", help="Do not ask to confirm.")] = False,
) -> None:
    if not yes:
        typer.confirm(
            "Migrate the stopped schema-2 vault in "
            f"{_data_dir()} for users and grants?",
            abort=True,
        )
    try:
        snapshot = storage.migrate_users(_data_dir())
    except storage.StorageError as error:
        raise _fail(error) from None
    typer.echo(f"Migrated. Rollback snapshot: {snapshot}")
    typer.echo(
        "Start CipherMoth and create the first administrator with the vault's "
        "current master password; existing entries will belong to that account."
    )


@app.command(
    "migrate-folders",
    help=(
        "Upgrade a stopped multi-user vault for stable folders, groups, expiring "
        "grants and access audit. A rollback snapshot is created first."
    ),
)
def migrate_folders(
    yes: Annotated[bool, typer.Option("--yes", help="Do not ask to confirm.")] = False,
) -> None:
    if not yes:
        typer.confirm(
            "Migrate the stopped schema-3 vault in "
            f"{_data_dir()} for folder access management?",
            abort=True,
        )
    try:
        saved = storage.migrate_folders(_data_dir())
    except storage.StorageError as error:
        raise _fail(error) from None
    typer.echo(f"Migrated. Rollback snapshot: {saved}")
    typer.echo(
        "Encrypted legacy folder names will be linked atomically on the next "
        "successful account unlock."
    )


@app.command(
    "migrate-service-permissions",
    help=(
        "Upgrade a stopped multi-user vault for explicit MCP service permissions. "
        "A rollback snapshot is created first; existing service tokens start disabled."
    ),
)
def migrate_service_permissions(
    yes: Annotated[bool, typer.Option("--yes", help="Do not ask to confirm.")] = False,
) -> None:
    if not yes:
        typer.confirm(
            "Migrate the stopped schema-4 vault in "
            f"{_data_dir()} for MCP service permissions? Existing service tokens "
            "will be disabled until an administrator explicitly configures them.",
            abort=True,
        )
    try:
        saved = storage.migrate_service_permissions(_data_dir())
    except storage.StorageError as error:
        raise _fail(error) from None
    typer.echo(f"Migrated. Rollback snapshot: {saved}")
    typer.echo(
        "Start CipherMoth, then configure each service account's allowed MCP "
        "operations."
    )


@app.command(
    "migrate-recovery",
    help=(
        "Upgrade a stopped schema-5 vault for personal recovery codes. "
        "A rollback snapshot is created first."
    ),
)
def migrate_recovery(
    yes: Annotated[bool, typer.Option("--yes", help="Do not ask to confirm.")] = False,
) -> None:
    if not yes:
        typer.confirm(
            "Migrate the stopped schema-5 vault in "
            f"{_data_dir()} for personal recovery codes?",
            abort=True,
        )
    try:
        saved = storage.migrate_recovery(_data_dir())
    except storage.StorageError as error:
        raise _fail(error) from None
    typer.echo(f"Migrated. Rollback snapshot: {saved}")


@app.command(
    "migrate-hardware-factors",
    help="Upgrade a stopped schema-6 vault for personal FIDO2 hardware factors.",
)
def migrate_hardware_factors(
    yes: Annotated[bool, typer.Option("--yes", help="Do not ask to confirm.")] = False,
) -> None:
    if not yes:
        typer.confirm(
            "Migrate the stopped schema-6 vault for personal hardware factors? "
            "A rollback snapshot will be created.",
            abort=True,
        )
    try:
        saved = storage.migrate_hardware_factors(_data_dir())
    except storage.StorageError as error:
        raise _fail(error) from None
    typer.echo(f"Migrated. Rollback snapshot: {saved}")


@app.command(
    "migrate-device-unlock",
    help="Upgrade a stopped schema-7 vault for voluntary per-user device unlock.",
)
def migrate_device_unlock(
    yes: Annotated[bool, typer.Option("--yes", help="Do not ask to confirm.")] = False,
) -> None:
    if not yes:
        typer.confirm(
            "Migrate the stopped schema-7 vault for voluntary device unlock? "
            "A rollback snapshot will be created.",
            abort=True,
        )
    try:
        saved = storage.migrate_device_unlock(_data_dir())
    except storage.StorageError as error:
        raise _fail(error) from None
    typer.echo(f"Migrated. Rollback snapshot: {saved}")


@app.command(
    "set-aside",
    help=(
        "Move the vault file (with its WAL) into a new folder in the snapshot "
        "folder, so the next start creates a new, empty vault. Nothing is "
        "deleted. Use it for a vault this release refuses to open, such as one "
        "from CipherMoth 2.0. Stop CipherMoth first."
    ),
)
def set_aside(
    yes: Annotated[bool, typer.Option("--yes", help="Do not ask to confirm.")] = False,
) -> None:
    if not yes:
        typer.confirm(
            f"Move the vault in {_data_dir()} aside and start over with an empty "
            "vault the next time CipherMoth starts?",
            abort=True,
        )
    try:
        kept = storage.set_aside(_data_dir())
    except storage.StorageError as error:
        raise _fail(error) from None
    if kept is None:
        typer.echo("There is no vault file to move.")
        return
    typer.echo(f"The vault was moved to {kept}")
    typer.echo(
        "Start CipherMoth to create a new vault. To go back, stop CipherMoth and "
        "move the files in that folder back into the data folder."
    )


if __name__ == "__main__":
    app()
