import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
INSTALLER = ROOT / "install.sh"

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell")

DOCKER = """#!/bin/sh
echo "docker $*" >> "$STUB_LOG"
if [ "$1 $2" = "volume inspect" ]; then
  [ "$3" = "nedra_postgres_data" ] && [ -n "$STUB_POSTGRES_VOLUME" ] && exit 0
  exit 1
fi
exit 0
"""

CURL = """#!/bin/sh
echo "curl $*" >> "$STUB_LOG"
url=""
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
cp "$STUB_REPO/${url#*/main/}" "$out"
"""

LEGACY_COMPOSE = """name: nedra
services:
  db:
    image: postgres:16-alpine
"""


def _stubs(tmp_path: Path) -> dict[str, str]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, body in (("docker", DOCKER), ("curl", CURL)):
        (bin_dir / name).write_text(body)
        (bin_dir / name).chmod(0o755)
    return {
        "PATH": f"{bin_dir}:/usr/bin:/bin",
        "HOME": str(tmp_path),
        "STUB_LOG": str(tmp_path / "calls.log"),
        "STUB_REPO": str(ROOT),
    }


def _install(tmp_path: Path, folder: Path, **env: str) -> subprocess.CompletedProcess:
    environment = {**_stubs_once(tmp_path), "NEDRA_DIR": str(folder), **env}
    return subprocess.run(
        ["sh", str(INSTALLER)],
        env=environment,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=60,
        start_new_session=True,
    )


_PREPARED: dict[Path, dict[str, str]] = {}


def _stubs_once(tmp_path: Path) -> dict[str, str]:
    if tmp_path not in _PREPARED:
        _PREPARED[tmp_path] = _stubs(tmp_path)
    return _PREPARED[tmp_path]


def _calls(tmp_path: Path) -> list[str]:
    log = tmp_path / "calls.log"
    return log.read_text().splitlines() if log.exists() else []


def _assert_never_removes_anything(tmp_path: Path) -> None:
    for call in _calls(tmp_path):
        assert " down" not in call, call
        assert "volume rm" not in call, call
        assert " rm " not in call, call
        assert "prune" not in call, call


def _backups(folder: Path, name: str) -> list[Path]:
    return sorted(folder.glob(f"{name}.backup-*"))


def test_a_fresh_install_writes_the_release_files_and_starts_the_stack(
    tmp_path: Path,
) -> None:
    folder = tmp_path / "nedra"
    result = _install(tmp_path, folder)

    assert result.returncode == 0, result.stderr
    assert (folder / "docker-compose.prod.yml").read_bytes() == (
        ROOT / "docker-compose.prod.yml"
    ).read_bytes()
    assert os.access(folder / "nedra", os.X_OK)
    assert "NEDRA_VERSION=latest" in (folder / ".env").read_text()
    calls = _calls(tmp_path)
    assert "docker compose -f docker-compose.prod.yml pull" in calls
    assert "docker compose -f docker-compose.prod.yml up -d --remove-orphans" in calls
    assert "signed images" not in result.stdout
    _assert_never_removes_anything(tmp_path)


def test_rerunning_on_a_2x_install_keeps_its_settings_and_backups(
    tmp_path: Path,
) -> None:
    folder = tmp_path / "nedra"
    assert _install(tmp_path, folder).returncode == 0
    env = "NEDRA_VERSION=2.0.0\nNEDRA_BIND_ADDRESS=0.0.0.0\n"
    (folder / ".env").write_text(env)
    (folder / "docker-compose.prod.yml.backup-20260101T000000Z").write_text("old")

    result = _install(tmp_path, folder)

    assert result.returncode == 0, result.stderr
    assert (folder / ".env").read_text() == env
    assert _backups(folder, ".env") == []
    assert [p.name for p in _backups(folder, "docker-compose.prod.yml")] == [
        "docker-compose.prod.yml.backup-20260101T000000Z"
    ]
    _assert_never_removes_anything(tmp_path)


def test_a_changed_compose_file_is_backed_up_without_overwriting_older_backups(
    tmp_path: Path,
) -> None:
    folder = tmp_path / "nedra"
    folder.mkdir()
    for content in ("first local edit", "second local edit"):
        (folder / "docker-compose.prod.yml").write_text(content)
        assert _install(tmp_path, folder).returncode == 0

    kept = sorted(p.read_text() for p in _backups(folder, "docker-compose.prod.yml"))
    assert kept == ["first local edit", "second local edit"]


def test_an_existing_version_pin_is_preserved(tmp_path: Path) -> None:
    folder = tmp_path / "nedra"
    folder.mkdir()
    old = "POSTGRES_PASSWORD=secret\nNEDRA_VERSION=1.6.0\nNEDRA_BACKEND_PORT=9000\n"
    (folder / ".env").write_text(old)

    result = _install(tmp_path, folder)

    assert result.returncode == 0, result.stderr
    assert (folder / ".env").read_text() == old
    assert _backups(folder, ".env") == []


@pytest.mark.parametrize("found_by", ["volume", "compose file"])
def test_an_old_install_is_updated_without_removing_data(
    tmp_path: Path, found_by: str
) -> None:
    folder = tmp_path / "nedra"
    env: dict[str, str] = {}
    if found_by == "volume":
        env["STUB_POSTGRES_VOLUME"] = "1"
    else:
        folder.mkdir()
        (folder / "docker-compose.prod.yml").write_text(LEGACY_COMPOSE)
        (folder / ".env").write_text("NEDRA_VERSION=1.6.0\n")

    result = _install(tmp_path, folder, **env)

    assert result.returncode == 0, result.stderr
    if found_by == "volume":
        assert folder.exists()
    else:
        assert (folder / "docker-compose.prod.yml").read_bytes() == (
            ROOT / "docker-compose.prod.yml"
        ).read_bytes()
        assert (folder / ".env").read_text() == "NEDRA_VERSION=1.6.0\n"
        [kept] = _backups(folder, "docker-compose.prod.yml")
        assert kept.read_text() == LEGACY_COMPOSE
    calls = _calls(tmp_path)
    assert any(call.startswith("curl") for call in calls), calls
    assert any(" pull" in call for call in calls)
    assert any(" up " in call for call in calls)
    _assert_never_removes_anything(tmp_path)


def test_an_existing_install_keeps_env_and_backs_up_changed_compose(
    tmp_path: Path,
) -> None:
    folder = tmp_path / "nedra"
    folder.mkdir()
    (folder / "docker-compose.prod.yml").write_text(LEGACY_COMPOSE)
    (folder / ".env").write_text("POSTGRES_PASSWORD=secret\nNEDRA_VERSION=1.6.0\n")

    result = _install(tmp_path, folder, STUB_POSTGRES_VOLUME="1", NEDRA_FRESH="y")

    assert result.returncode == 0, result.stderr
    [compose] = _backups(folder, "docker-compose.prod.yml")
    assert compose.read_text() == LEGACY_COMPOSE
    assert _backups(folder, ".env") == []
    assert "NEDRA_VERSION=1.6.0" in (folder / ".env").read_text()
    _assert_never_removes_anything(tmp_path)
