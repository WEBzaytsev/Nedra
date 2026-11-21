import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parent
venv = root / "core/build/venv"
python = venv / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
if not python.exists():
    subprocess.run(["uv", "venv", str(venv), "--python", "3.13.15"], check=True)
subprocess.run(
    [
        "uv",
        "pip",
        "install",
        "--python",
        str(python),
        "-r",
        str(root / "core/requirements-desktop.lock"),
    ],
    check=True,
)
