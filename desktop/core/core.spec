from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files

import fido2

here = Path(SPECPATH).resolve()
backend = (here / ".." / ".." / "backend").resolve()


analysis = Analysis(
    [str(here / "core_main.py")],
    pathex=[str(backend), str(here)],
    binaries=[],
    datas=[(str(backend / "pyproject.toml"), "."), *collect_data_files("fido2")],
    hiddenimports=[
        "aiosqlite",
        "sqlalchemy.dialects.sqlite.aiosqlite",
        "greenlet",
        "desktop_core.entry",
        "desktop_core.security_key",
        "desktop_core.vectors",
        "security_key_client",
        "fido2.hid",
        "fido2.hid.macos",
        "fido2.hid.linux",
        "fido2.hid.windows",
        "fido2.client.windows",
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "pydoc", "IPython", "pytest", "hypothesis"],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(analysis.pure)

executable = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="ciphermoth-core",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=True,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

collected = COLLECT(
    executable,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    name="ciphermoth-core",
)
