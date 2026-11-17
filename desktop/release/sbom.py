"""Generate a deterministic CycloneDX SBOM from every locked dependency graph."""

import argparse
import hashlib
import json
import tomllib
import urllib.parse
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOCKS = (
    "backend/uv.lock",
    "frontend/package-lock.json",
    "desktop/package-lock.json",
    "desktop/src-tauri/Cargo.lock",
    "extension/package-lock.json",
)


def _purl(ecosystem: str, name: str, version: str) -> str:
    encoded = urllib.parse.quote(name, safe="/")
    return f"pkg:{ecosystem}/{encoded}@{urllib.parse.quote(version, safe='')}"


def _component(ecosystem: str, name: str, version: str, source: str) -> dict:
    purl = _purl(ecosystem, name, version)
    return {
        "type": "library",
        "bom-ref": purl,
        "name": name,
        "version": version,
        "purl": purl,
        "properties": [{"name": "nedra:lockfile", "value": source}],
    }


def generate(root: Path, version: str, commit: str) -> dict:
    components: dict[str, dict] = {}
    lock_hashes = []
    for relative in LOCKS:
        path = root / relative
        raw = path.read_bytes()
        lock_hashes.append(
            {
                "name": "nedra:lockfile-sha256",
                "value": f"{relative}:{hashlib.sha256(raw).hexdigest()}",
            }
        )
        if path.name == "package-lock.json":
            packages = json.loads(raw)["packages"]
            for package_path, package in packages.items():
                if not package_path or "version" not in package:
                    continue
                name = (
                    package.get("name") or package_path.rsplit("node_modules/", 1)[-1]
                )
                component = _component("npm", name, package["version"], relative)
                components.setdefault(component["bom-ref"], component)
        else:
            ecosystem = "pypi" if path.name == "uv.lock" else "cargo"
            for package in tomllib.loads(raw.decode())["package"]:
                component = _component(
                    ecosystem, package["name"], package["version"], relative
                )
                existing = components.get(component["bom-ref"])
                if existing is None:
                    components[component["bom-ref"]] = component
                elif component["properties"][0] not in existing["properties"]:
                    existing["properties"].extend(component["properties"])
    return {
        "bomFormat": "CycloneDX",
        "specVersion": "1.6",
        "serialNumber": "urn:uuid:"
        + str(
            uuid.uuid5(
                uuid.NAMESPACE_URL,
                f"https://github.com/WEBzaytsev/Nedra/{commit}/v{version}",
            )
        ),
        "version": 1,
        "metadata": {
            "component": {
                "type": "application",
                "bom-ref": f"pkg:github/WEBzaytsev/Nedra@{commit}",
                "name": "Nedra",
                "version": version,
                "purl": f"pkg:github/WEBzaytsev/Nedra@{commit}",
            },
            "properties": [
                {"name": "nedra:commit", "value": commit},
                *sorted(lock_hashes, key=lambda row: row["value"]),
            ],
        },
        "components": sorted(components.values(), key=lambda row: row["bom-ref"]),
    }


def write(path: Path, root: Path, version: str, commit: str) -> None:
    path.write_text(json.dumps(generate(root, version, commit), indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--commit", required=True)
    args = parser.parse_args()
    write(args.output, ROOT, args.version, args.commit)
