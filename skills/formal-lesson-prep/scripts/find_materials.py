#!/usr/bin/env python3
"""Cross-platform local material shortlist helper.

The script only ranks file paths by metadata. It does not read large teaching
files, so the lesson-prep agent can inspect only promising candidates later.
"""

import argparse
import datetime
import json
import os
from pathlib import Path
from typing import Any, Dict, List, Tuple


SUPPORTED_EXTENSIONS = {
    ".pdf",
    ".doc",
    ".docx",
    ".ppt",
    ".pptx",
    ".md",
    ".txt",
    ".tex",
    ".xlsx",
    ".xls",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
}


def default_root() -> str:
    if os.environ.get("PREP_MATERIAL_ROOT"):
        return os.environ["PREP_MATERIAL_ROOT"]
    if os.environ.get("PREP_WORKSPACE"):
        return str(Path(os.environ["PREP_WORKSPACE"]) / "资料库")
    return str(Path.cwd() / "资料库")


def split_keywords(values: List[str]) -> List[str]:
    seen = set()  # type: set
    result = []  # type: List[str]
    for value in values:
        for part in value.replace("，", ",").split(","):
            keyword = part.strip()
            if keyword and keyword not in seen:
                seen.add(keyword)
                result.append(keyword)
    return result


def build_result(status: str, root: Path, stage: str, grade: str, keywords: List[str], candidates: List[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        "status": status,
        "root": str(root),
        "query": {
            "stage": stage,
            "grade": grade,
            "keywords": keywords,
        },
        "candidateCount": len(candidates),
        "candidates": candidates,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Rank local lesson-prep materials by path hits.")
    parser.add_argument("--root", "-r", default=default_root())
    parser.add_argument("--stage", default="")
    parser.add_argument("--grade", default="")
    parser.add_argument("--keywords", "-k", action="append", default=[])
    parser.add_argument("--limit", "-l", type=int, default=80)
    args = parser.parse_args()

    root = Path(args.root).expanduser().resolve()
    keywords = split_keywords(args.keywords)

    if not root.is_dir():
        print(json.dumps(build_result("missing-root", root, args.stage, args.grade, keywords, []), ensure_ascii=False, indent=2))
        return 0

    weighted_terms = []  # type: List[Tuple[str, int]]
    if args.stage.strip():
        weighted_terms.append((args.stage.strip(), 8))
    if args.grade.strip():
        weighted_terms.append((args.grade.strip(), 8))
    weighted_terms.extend((keyword, 5) for keyword in keywords)

    candidates = []  # type: List[Dict[str, Any]]
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if not name.startswith(".") and name != "node_modules"]
        for filename in filenames:
            path = Path(dirpath) / filename
            extension = path.suffix.lower()
            if extension not in SUPPORTED_EXTENSIONS:
                continue
            full_path = str(path)
            haystack = full_path.casefold()
            score = 0
            hits = []  # type: List[str]
            for term, weight in weighted_terms:
                if term.casefold() in haystack:
                    score += weight
                    hits.append(term)
            try:
                stat = path.stat()
            except OSError:
                continue
            candidates.append(
                {
                    "path": full_path,
                    "extension": extension,
                    "sizeBytes": stat.st_size,
                    "lastWriteTime": stat.st_mtime,
                    "score": score,
                    "pathHits": sorted(set(hits)),
                }
            )

    if not candidates:
        print(json.dumps(build_result("empty-root", root, args.stage, args.grade, keywords, []), ensure_ascii=False, indent=2))
        return 0

    candidates.sort(key=lambda item: (-item["score"], -item["lastWriteTime"], item["path"]))
    ranked = candidates[: max(1, args.limit)]
    for item in ranked:
        item["lastWriteTime"] = datetime.datetime.fromtimestamp(item["lastWriteTime"]).isoformat(timespec="seconds")
    print(json.dumps(build_result("ok", root, args.stage, args.grade, keywords, ranked), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
