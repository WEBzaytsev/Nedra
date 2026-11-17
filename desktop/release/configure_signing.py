"""Keep key material out of workflow output and public artifact directories."""

import json
import os
import subprocess
from pathlib import Path

os.umask(0o077)
root = Path(os.environ["RUNNER_TEMP"]) / "nedra-signing"
root.mkdir(mode=0o700, exist_ok=False)
key = root / "updater.key"
release_key = os.environ.get("RELEASE_KEY")
if os.environ.get("RELEASE_SIGNING") == "true" and not release_key:
    raise SystemExit("Protected production signing secret is missing")
if release_key:
    key.write_text(release_key)
else:
    result = subprocess.run(
        [
            "node",
            "desktop/node_modules/@tauri-apps/cli/tauri.js",
            "signer",
            "generate",
            "--ci",
            "-w",
            str(key),
        ],
        capture_output=True,
    )
    if result.returncode:
        raise SystemExit("Disposable key generation failed; output withheld")
    config = Path("desktop/src-tauri/tauri.conf.json")
    data = json.loads(config.read_text())
    data["plugins"]["updater"]["pubkey"] = Path(str(key) + ".pub").read_text().strip()
    config.write_text(json.dumps(data, indent=2) + "\n")
with Path(os.environ["GITHUB_ENV"]).open("a") as env:
    env.write(f"TAURI_SIGNING_PRIVATE_KEY={key}\nTAURI_SIGNING_PRIVATE_KEY_PASSWORD=\n")
print(
    "Using protected release key"
    if release_key
    else "Using disposable validation key; artifacts cannot update production"
)
