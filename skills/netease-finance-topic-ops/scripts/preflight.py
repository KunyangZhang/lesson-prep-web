#!/usr/bin/env python3
"""Check portable deployment requirements without exposing secret values."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

MIN_PYTHON = (3, 10)
MIN_NODE = (20, 18, 1)
CHILD_SKILLS = [
    "mx-finance-search",
    "tencent-news",
    "wechat-article-search",
    "news-aggregator-skill",
    "toutiao-news-trends",
    "a-stock-analysis",
]
PYTHON_MODULES = {
    "docx": "python-docx",
    "lxml": "lxml",
    "requests": "requests",
    "bs4": "beautifulsoup4",
}


def command_output(command: list[str], timeout: int = 15) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
        return proc.returncode, (proc.stdout + "\n" + proc.stderr).strip()
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 1, str(exc)


def parse_version(text: str) -> tuple[int, int, int]:
    raw = text.strip().lstrip("vV").split(".")
    values: list[int] = []
    for item in raw[:3]:
        digits = "".join(ch for ch in item if ch.isdigit())
        values.append(int(digits or 0))
    while len(values) < 3:
        values.append(0)
    return tuple(values)  # type: ignore[return-value]


def required_source_files(root: Path) -> list[Path]:
    return [
        path.relative_to(root)
        for path in root.rglob("*")
        if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"
    ]


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def check_tencent_cli() -> dict:
    cli = shutil.which("tencent-news-cli")
    if not cli:
        return {"installed": False, "api_key_configured": False, "status": "missing"}
    code, output = command_output([cli, "apikey-get"])
    configured = code == 0 and bool(output.strip()) and not any(
        token in output.lower() for token in ("not set", "missing", "未设置")
    )
    return {
        "installed": True,
        "api_key_configured": configured,
        "status": "configured" if configured else "missing_or_error",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strict", action="store_true", help="Return non-zero when a required component is missing.")
    parser.add_argument("--skills-dir", help="Installed Codex skills directory. Defaults to this parent skill's directory.")
    parser.add_argument("--artifact-node-modules", help="Node modules directory returned by the Codex workspace dependency loader.")
    parser.add_argument("--node-executable", help="Node.js executable returned by the Codex workspace dependency loader.")
    parser.add_argument("--npm-executable", help="npm executable; defaults to PATH.")
    args = parser.parse_args()

    skill_dir = Path(__file__).resolve().parent.parent
    skills_dir = Path(args.skills_dir).expanduser().resolve() if args.skills_dir else skill_dir.parent
    manifest_path = skill_dir / "assets" / "portable-manifest.json"
    manifest_valid = False
    manifest_error = None
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest_valid = (
            manifest.get("parent_skill") == skill_dir.name
            and manifest.get("bundled_skills") == CHILD_SKILLS
        )
        if not manifest_valid:
            manifest_error = "component list mismatch"
    except (OSError, json.JSONDecodeError) as exc:
        manifest_error = str(exc)
    python_ok = sys.version_info >= MIN_PYTHON
    modules = {name: importlib.util.find_spec(name) is not None for name in PYTHON_MODULES}

    node_path = args.node_executable or shutil.which("node")
    node_version = None
    node_ok = False
    if node_path:
        code, output = command_output([node_path, "--version"])
        if code == 0:
            node_version = output.splitlines()[0].strip()
            node_ok = parse_version(node_version) >= MIN_NODE

    npm_path = args.npm_executable or shutil.which("npm.cmd") or shutil.which("npm")
    bundled_dir = skill_dir / "assets" / "bundled-skills"
    child_missing_files: dict[str, list[str]] = {}
    for name in CHILD_SKILLS:
        source = bundled_dir / name
        destination = skills_dir / name
        child_missing_files[name] = [
            str(relative)
            for relative in required_source_files(source)
            if not (destination / relative).is_file()
            or file_digest(source / relative) != file_digest(destination / relative)
        ]
    children = {name: not missing for name, missing in child_missing_files.items()}
    wechat_dep = (skills_dir / "wechat-article-search" / "node_modules" / "cheerio").exists()
    em_present = bool(os.environ.get("EM_API_KEY", "").strip())
    tencent = check_tencent_cli()

    artifact_status = "unchecked"
    artifact_ok = None
    if args.artifact_node_modules:
        base = Path(args.artifact_node_modules).expanduser().resolve()
        artifact_ok = (base / "@oai" / "artifact-tool").exists()
        artifact_status = "available" if artifact_ok else "missing"

    result = {
        "python": {"executable": sys.executable, "version": sys.version.split()[0], "minimum": "3.10", "ok": python_ok},
        "python_modules": modules,
        "node": {"path_present": bool(node_path), "version": node_version, "minimum": "20.18.1", "ok": node_ok},
        "npm_present": bool(npm_path),
        "skills_dir": str(skills_dir),
        "portable_manifest": {
            "present": manifest_path.is_file(),
            "valid": manifest_valid,
            "error": manifest_error,
        },
        "child_skills": children,
        "child_missing_files": child_missing_files,
        "wechat_cheerio_installed": wechat_dep,
        "credentials": {
            "EM_API_KEY": "configured" if em_present else "missing",
            "tencent_news": tencent,
        },
        "artifact_tool": {"status": artifact_status, "ok": artifact_ok},
    }

    failures: list[str] = []
    if not python_ok:
        failures.append("Python 3.10+")
    failures.extend(f"Python module {PYTHON_MODULES[name]}" for name, ok in modules.items() if not ok)
    if not node_ok:
        failures.append("Node.js 20.18.1+")
    if not npm_path:
        failures.append("npm")
    if not manifest_valid:
        failures.append("portable manifest")
    failures.extend(f"child skill {name}" for name, ok in children.items() if not ok)
    if not wechat_dep:
        failures.append("wechat cheerio dependency")
    if not em_present:
        failures.append("EM_API_KEY")
    if not tencent["installed"]:
        failures.append("tencent-news-cli")
    elif not tencent["api_key_configured"]:
        failures.append("Tencent News API key")
    if artifact_ok is not True:
        failures.append("@oai/artifact-tool")

    result["failures"] = failures
    result["ready"] = not failures
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if args.strict and failures:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
