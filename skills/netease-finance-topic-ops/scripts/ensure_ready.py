#!/usr/bin/env python3
"""Repair the portable runtime, then require a clean strict preflight."""

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

CHILD_SKILLS = [
    "mx-finance-search",
    "tencent-news",
    "wechat-article-search",
    "news-aggregator-skill",
    "toutiao-news-trends",
    "a-stock-analysis",
]
PYTHON_MODULES = ("docx", "lxml", "requests", "bs4")


def source_files(root: Path) -> list[Path]:
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


def inconsistent_files(source: Path, destination: Path) -> list[str]:
    inconsistent: list[str] = []
    for relative in source_files(source):
        source_file = source / relative
        destination_file = destination / relative
        if not destination_file.is_file() or file_digest(source_file) != file_digest(destination_file):
            inconsistent.append(str(relative))
    return inconsistent


def run(command: list[str], *, cwd: Path | None = None, timeout: int = 600) -> tuple[int, str]:
    if os.name == "nt" and Path(command[0]).suffix.lower() in {".cmd", ".bat"}:
        command = [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", *command]
    proc = subprocess.run(
        command,
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        check=False,
    )
    return proc.returncode, (proc.stdout + "\n" + proc.stderr).strip()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skills-dir", help="Installed Codex skills directory.")
    parser.add_argument("--artifact-node-modules", required=True, help="Codex workspace node_modules path.")
    parser.add_argument("--node-executable", help="Node.js executable returned by the workspace dependency loader.")
    parser.add_argument("--npm-executable", help="npm executable; defaults to PATH.")
    parser.add_argument("--check-only", action="store_true", help="Do not repair; only run strict preflight.")
    args = parser.parse_args()

    skill_dir = Path(__file__).resolve().parent.parent
    skills_dir = Path(args.skills_dir).expanduser().resolve() if args.skills_dir else skill_dir.parent
    bundled_dir = skill_dir / "assets" / "bundled-skills"
    repairs: list[dict[str, object]] = []
    errors: list[str] = []

    skills_dir.mkdir(parents=True, exist_ok=True)
    for name in CHILD_SKILLS:
        source = bundled_dir / name
        destination = skills_dir / name
        inconsistent = inconsistent_files(source, destination) if destination.exists() else ["entire skill"]
        if not inconsistent:
            continue
        if args.check_only:
            errors.append(f"child skill {name} is incomplete or inconsistent")
            continue
        try:
            shutil.copytree(source, destination, dirs_exist_ok=True)
            repairs.append({"component": f"child skill {name}", "action": "restored", "files": inconsistent})
        except OSError as exc:
            errors.append(f"failed to restore child skill {name}: {exc}")

    missing_modules = [name for name in PYTHON_MODULES if importlib.util.find_spec(name) is None]
    if missing_modules and not args.check_only:
        code, output = run(
            [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "-r", str(skill_dir / "requirements-portable.txt")]
        )
        if code == 0:
            repairs.append({"component": "Python dependencies", "action": "installed", "modules": missing_modules})
        else:
            errors.append(f"Python dependency installation failed: {output}")

    wechat_dir = skills_dir / "wechat-article-search"
    cheerio = wechat_dir / "node_modules" / "cheerio" / "package.json"
    if not cheerio.is_file() and not args.check_only:
        npm = args.npm_executable or shutil.which("npm.cmd") or shutil.which("npm")
        if not npm:
            errors.append("npm is unavailable; cannot install the locked WeChat dependency")
        else:
            code, output = run([npm, "ci", "--omit=dev"], cwd=wechat_dir)
            if code == 0:
                repairs.append({"component": "wechat-article-search Node dependencies", "action": "installed"})
            else:
                errors.append(f"WeChat Node dependency installation failed: {output}")

    preflight_command = [
        sys.executable,
        str(skill_dir / "scripts" / "preflight.py"),
        "--strict",
        "--skills-dir",
        str(skills_dir),
        "--artifact-node-modules",
        str(Path(args.artifact_node_modules).expanduser().resolve()),
    ]
    if args.node_executable:
        preflight_command.extend(["--node-executable", args.node_executable])
    if args.npm_executable:
        preflight_command.extend(["--npm-executable", args.npm_executable])
    code, output = run(preflight_command)
    try:
        preflight = json.loads(output)
    except json.JSONDecodeError:
        preflight = {"ready": False, "failures": ["preflight returned invalid JSON"], "raw": output}
    ready = code == 0 and bool(preflight.get("ready")) and not errors
    print(json.dumps({"python_executable": sys.executable, "repairs": repairs, "repair_errors": errors, "preflight": preflight, "ready": ready}, ensure_ascii=False, indent=2))
    if not ready:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
