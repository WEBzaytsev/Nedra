import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def target():
    system = {"Darwin": "darwin", "Windows": "windows", "Linux": "linux"}[
        platform.system()
    ]
    arch = {
        "arm64": "aarch64",
        "aarch64": "aarch64",
        "amd64": "x86_64",
        "x86_64": "x86_64",
    }[platform.machine().lower()]
    return f"{system}-{arch}"


def collect(bundle, out, version):
    bundle = bundle.resolve()
    out = out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    native = target()
    formats = {
        "darwin": [
            ("macos/*.app.tar.gz", "app.tar.gz", True),
            ("dmg/*.dmg", "dmg", False),
        ],
        "windows": [("nsis/*.exe", "exe", True)],
        "linux": [
            ("appimage/*.AppImage", "AppImage", True),
            ("deb/*.deb", "deb", False),
        ],
    }[native.split("-")[0]]
    public = out / "updater.pub"
    public.write_text(
        json.loads((ROOT / "desktop/src-tauri/tauri.conf.json").read_text())["plugins"][
            "updater"
        ]["pubkey"]
    )
    verifier = (
        ROOT
        / "desktop/src-tauri/target/release/examples"
        / ("verify_update.exe" if os.name == "nt" else "verify_update")
    )

    def sign(path):
        command = [
            "node",
            str(ROOT / "desktop/node_modules/@tauri-apps/cli/tauri.js"),
            "signer",
            "sign",
            "--app-version",
            version,
            str(path),
        ]
        env = dict(os.environ)
        key_path = env.pop("TAURI_SIGNING_PRIVATE_KEY")
        if not Path(key_path).is_file():
            raise RuntimeError("Signing requires an owner-controlled key file")
        env["TAURI_SIGNING_PRIVATE_KEY_PATH"] = key_path
        result = subprocess.run(
            command, cwd=ROOT / "desktop", env=env, capture_output=True
        )
        if result.returncode:
            raise RuntimeError(
                "Tauri signing failed (output withheld to protect credentials)"
            )
        subprocess.run(
            [str(verifier), str(public), str(path), str(path) + ".sig", version],
            check=True,
        )

    def record(path, updater):
        records.append(
            {
                "file": path.name,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "bytes": path.stat().st_size,
                "updater": updater,
            }
        )

    records = []
    for pattern, suffix, update in formats:
        candidates = list(bundle.glob(pattern))
        if len(candidates) != 1:
            raise RuntimeError(f"Expected one bundle for {pattern}, got {len(candidates)}")
        canonical = out / f"Nedra_{version}_{native}.{suffix}"
        shutil.copy2(candidates[0], canonical)
        if update:
            sign(canonical)
        record(canonical, update)
    source = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
    ).strip()
    (out / f"provenance-{native}.json").write_text(
        json.dumps(
            {
                "commit": source,
                "version": version,
                "target": native,
                "workflow_run": os.environ.get("GITHUB_RUN_ID"),
                "runner": os.environ.get("RUNNER_OS"),
                "artifacts": records,
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--bundle", type=Path, default=ROOT / "desktop/src-tauri/target/release/bundle"
    )
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    collect(args.bundle, args.out, args.version)
