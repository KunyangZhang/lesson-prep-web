#!/usr/bin/env python3
"""Create a secret-safe portable ZIP of this skill."""

from __future__ import annotations

import argparse
import json
import re
import zipfile
from pathlib import Path

import yaml

EXCLUDED_PARTS = {"__pycache__", "node_modules", ".git", "reports"}
EXCLUDED_SUFFIXES = {".pyc", ".pyo", ".log", ".sqlite", ".db"}
SECRET_PATTERNS = [
    re.compile(rb"sk-[A-Za-z0-9_-]{20,}"),
    re.compile(rb"em_[A-Za-z0-9]{20,}"),
]
PLACEHOLDERS = (b"your_", b"replace_", b"example", b"YOUR_", b"REPLACE_")
CHILD_SKILLS = [
    "mx-finance-search",
    "tencent-news",
    "wechat-article-search",
    "news-aggregator-skill",
    "toutiao-news-trends",
    "a-stock-analysis",
]


def include(path: Path, root: Path) -> bool:
    rel = path.relative_to(root)
    return not any(part in EXCLUDED_PARTS for part in rel.parts) and path.suffix.lower() not in EXCLUDED_SUFFIXES


def validate_skill(path: Path, expected_name: str) -> None:
    skill_file = path / "SKILL.md"
    if not skill_file.is_file():
        raise ValueError(f"missing SKILL.md for {expected_name}")
    text = skill_file.read_text(encoding="utf-8")
    frontmatter = re.match(r"^---\s*\n(.*?)\n---\s*\n", text, re.DOTALL)
    if not frontmatter:
        raise ValueError(f"invalid frontmatter in {skill_file}")
    try:
        metadata = yaml.safe_load(frontmatter.group(1))
    except yaml.YAMLError as exc:
        raise ValueError(f"invalid YAML in {skill_file}: {exc}") from exc
    if not isinstance(metadata, dict):
        raise ValueError(f"frontmatter must be a mapping in {skill_file}")
    name = metadata.get("name")
    description = metadata.get("description")
    if name != expected_name or not isinstance(description, str) or not description.strip():
        raise ValueError(f"invalid name or description in {skill_file}")


def validate_manifest(root: Path) -> None:
    manifest_path = root / "assets" / "portable-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("parent_skill") != root.name:
        raise ValueError("portable manifest parent skill mismatch")
    if manifest.get("bundled_skills") != CHILD_SKILLS:
        raise ValueError("portable manifest child skill list mismatch")
    if manifest.get("bundle_format") != 2:
        raise ValueError("portable manifest format mismatch")
    expected_policy = {
        "entrypoint": "scripts/ensure_ready.py",
        "repair_before_run": True,
        "strict_preflight_required": True,
    }
    if manifest.get("startup_policy") != expected_policy:
        raise ValueError("portable manifest startup policy mismatch")
    if not (root / "scripts" / "ensure_ready.py").is_file():
        raise ValueError("portable runtime guard is missing")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    output = Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    validate_skill(root, root.name)
    validate_manifest(root)
    for name in CHILD_SKILLS:
        validate_skill(root / "assets" / "bundled-skills" / name, name)
    files = sorted(p for p in root.rglob("*") if p.is_file() and include(p, root))
    for file in files:
        data = file.read_bytes()
        for pattern in SECRET_PATTERNS:
            if pattern.search(data):
                raise ValueError(f"possible secret in {file.relative_to(root)}")
        for line in data.splitlines():
            match = re.search(rb"(?:^|[;$]\s*)EM_API_KEY\s*=\s*[\"']([^\"']+)[\"']", line)
            if not match:
                continue
            value = match.group(1).strip()
            if len(value) >= 12 and not value.startswith(PLACEHOLDERS):
                raise ValueError(f"possible EM_API_KEY value in {file.relative_to(root)}")
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for file in files:
            arcname = Path(root.name) / file.relative_to(root)
            archive.write(file, arcname.as_posix())
    print(f"Created {output} with {len(files)} files")


if __name__ == "__main__":
    main()
