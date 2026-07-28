#!/usr/bin/env python3
"""Persist, score, fingerprint, deduplicate, and export finance topic candidates."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from zoneinfo import ZoneInfo

SCORE_LIMITS = {
    "timeliness": 20,
    "company": 15,
    "event": 15,
    "contradiction": 20,
    "traffic": 10,
    "extension": 10,
    "evidence": 10,
}
FINAL_STATUSES = {"submitted", "approved"}
SHANGHAI = ZoneInfo("Asia/Shanghai")
VALID_STATUSES = {
    "candidate", "needs_verification", "shortlisted", "submitted", "approved",
    "published", "rejected", "duplicate", "expired",
}

SCHEMA = """
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS topics (
  topic_id TEXT PRIMARY KEY,
  discovered_date TEXT NOT NULL,
  event_date TEXT,
  first_reported_at TEXT,
  industry TEXT,
  company TEXT NOT NULL,
  company_aliases_json TEXT NOT NULL DEFAULT '[]',
  company_type TEXT,
  event_type TEXT,
  latest_event TEXT NOT NULL,
  key_numbers TEXT,
  contradictions_json TEXT NOT NULL DEFAULT '[]',
  suggested_title TEXT NOT NULL,
  increment_text TEXT,
  traffic_signal TEXT,
  interview_direction TEXT,
  wording_risk TEXT,
  status TEXT NOT NULL,
  grade TEXT,
  rejection_reason TEXT,
  editor_feedback TEXT,
  channel_name TEXT,
  article_url TEXT,
  published_date TEXT,
  fingerprint TEXT NOT NULL,
  semantic_summary TEXT,
  keywords_json TEXT NOT NULL DEFAULT '[]',
  similarity REAL NOT NULL DEFAULT 0,
  similar_topic_id TEXT,
  netease_finance_check TEXT NOT NULL DEFAULT 'not_checked',
  netease_hao_check TEXT NOT NULL DEFAULT 'not_checked',
  wechat_backend_check TEXT NOT NULL DEFAULT 'not_checked',
  new_facts TEXT,
  dedupe_conclusion TEXT,
  override_reason TEXT,
  score_timeliness INTEGER NOT NULL DEFAULT 0,
  score_company INTEGER NOT NULL DEFAULT 0,
  score_event INTEGER NOT NULL DEFAULT 0,
  score_contradiction INTEGER NOT NULL DEFAULT 0,
  score_traffic INTEGER NOT NULL DEFAULT 0,
  score_extension INTEGER NOT NULL DEFAULT 0,
  score_evidence INTEGER NOT NULL DEFAULT 0,
  score_total INTEGER NOT NULL DEFAULT 0,
  sections_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topics_fingerprint ON topics(fingerprint);
CREATE INDEX IF NOT EXISTS idx_topics_company ON topics(company);
CREATE INDEX IF NOT EXISTS idx_topics_status ON topics(status);
CREATE TABLE IF NOT EXISTS sources (
  source_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_type TEXT,
  grade TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  published_at TEXT,
  accessed_at TEXT,
  supports TEXT,
  quote_text TEXT,
  document_no TEXT,
  cross_verified INTEGER NOT NULL DEFAULT 0,
  directly_citable INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(url, title)
);
CREATE TABLE IF NOT EXISTS topic_sources (
  topic_id TEXT NOT NULL REFERENCES topics(topic_id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
  PRIMARY KEY(topic_id, source_id)
);
CREATE TABLE IF NOT EXISTS decisions (
  decision_id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id TEXT NOT NULL REFERENCES topics(topic_id) ON DELETE CASCADE,
  old_status TEXT,
  new_status TEXT NOT NULL,
  reason TEXT,
  actor TEXT NOT NULL DEFAULT 'Codex',
  decided_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS search_logs (
  search_id INTEGER PRIMARY KEY AUTOINCREMENT,
  search_date TEXT,
  channel TEXT NOT NULL,
  query TEXT NOT NULL,
  status TEXT NOT NULL,
  result_count INTEGER,
  searched_at TEXT NOT NULL,
  time_window TEXT,
  error_text TEXT
);
CREATE TABLE IF NOT EXISTS search_materials (
  result_id TEXT NOT NULL,
  search_date TEXT NOT NULL,
  query TEXT NOT NULL,
  channel TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  grade TEXT NOT NULL,
  published_at TEXT NOT NULL,
  accessed_at TEXT NOT NULL,
  clue TEXT,
  in_window INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY(search_date, result_id),
  UNIQUE(search_date, normalized_url)
);
CREATE INDEX IF NOT EXISTS idx_search_materials_date ON search_materials(search_date);
CREATE INDEX IF NOT EXISTS idx_search_materials_channel ON search_materials(channel);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def normalize_text(value: Any) -> str:
    text = str(value or "").lower().strip()
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", text)


def normalize_keywords(values: Any) -> list[str]:
    if isinstance(values, str):
        values = re.split(r"[,，;；|\s]+", values)
    return sorted({normalize_text(v) for v in (values or []) if normalize_text(v)})


def parse_date(value: Any) -> date | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        return date.fromisoformat(raw)
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=SHANGHAI)
        return parsed.astimezone(SHANGHAI).date()
    except ValueError:
        return None


def in_four_day_window(value: Any, search_date: date) -> bool:
    published = parse_date(value)
    return published is not None and search_date - timedelta(days=3) <= published <= search_date


def normalize_url(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    parsed = urlsplit(raw)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
        return ""
    ignored = {"fbclid", "gclid", "spm", "utm_campaign", "utm_content", "utm_medium", "utm_source", "utm_term"}
    query = urlencode(sorted((key, val) for key, val in parse_qsl(parsed.query, keep_blank_values=True) if key.lower() not in ignored))
    path = parsed.path.rstrip("/") or "/"
    return urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), path, query, ""))


def search_gate(payload: dict[str, Any], search_day: date) -> dict[str, Any]:
    unique: dict[str, dict[str, Any]] = {}
    for item in payload.get("materials", []):
        normalized = normalize_url(item.get("url"))
        if not normalized or not in_four_day_window(item.get("published_at"), search_day):
            continue
        unique.setdefault(normalized, item)
    channels = {str(item.get("channel", "")).strip().lower() for item in unique.values()}
    has_web_search = "web_search" in channels
    web_material_count = sum(str(item.get("channel", "")).strip().lower() == "web_search" for item in unique.values())
    s_count = sum(str(item.get("grade", "")).strip().upper() == "S" for item in unique.values())
    failures = []
    if len(unique) < 100:
        failures.append(f"四天内去重资料不足100条：{len(unique)}条")
    if not has_web_search:
        failures.append("未记录Web Search资料")
    return {
        "ready": not failures,
        "qualified_materials": len(unique),
        "web_search_materials": web_material_count,
        "s_grade_materials": s_count,
        "window_start": (search_day - timedelta(days=3)).isoformat(),
        "window_end": search_day.isoformat(),
        "failures": failures,
        "items": unique,
    }


def make_fingerprint(topic: dict[str, Any]) -> str:
    payload = "|".join([
        normalize_text(topic.get("company")),
        normalize_text(topic.get("event_type")),
        normalize_text(topic.get("event_date")),
        ",".join(normalize_keywords(topic.get("keywords"))),
    ])
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def jaccard(a: list[str], b: list[str]) -> float:
    left, right = set(a), set(b)
    if not left and not right:
        return 1.0
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def score_topic(topic: dict[str, Any]) -> tuple[dict[str, int], int]:
    provided = topic.get("scores") or {}
    scores: dict[str, int] = {}
    for key, limit in SCORE_LIMITS.items():
        raw = provided.get(key, 0)
        try:
            value = int(raw)
        except (TypeError, ValueError):
            value = 0
        scores[key] = max(0, min(limit, value))
    return scores, sum(scores.values())


def source_gate(sources: list[dict[str, Any]], search_day: date) -> tuple[bool, str]:
    if not sources:
        return False, "没有绑定信源"
    stale = [s.get("source_id") or s.get("url") or "未命名信源" for s in sources if not in_four_day_window(s.get("published_at"), search_day)]
    if stale:
        return False, f"存在发布时间缺失或不在四天窗口内的信源：{', '.join(map(str, stale))}"
    has_s = any(str(s.get("grade", "")).upper() == "S" and s.get("directly_citable") for s in sources)
    if not has_s:
        return False, "缺少四天窗口内且可直接引用的S级信源"
    return True, ""


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def find_duplicate(conn: sqlite3.Connection, topic: dict[str, Any], fingerprint: str, threshold: float) -> tuple[str | None, float]:
    exact = conn.execute(
        "SELECT topic_id FROM topics WHERE fingerprint=? AND topic_id<>? ORDER BY updated_at DESC LIMIT 1",
        (fingerprint, topic["topic_id"]),
    ).fetchone()
    if exact:
        return exact["topic_id"], 1.0
    keys = normalize_keywords(topic.get("keywords"))
    best_id, best_score = None, 0.0
    rows = conn.execute(
        "SELECT topic_id, keywords_json FROM topics WHERE company=? AND topic_id<>?",
        (topic.get("company"), topic["topic_id"]),
    ).fetchall()
    for row in rows:
        sim = jaccard(keys, json.loads(row["keywords_json"] or "[]"))
        if sim > best_score:
            best_id, best_score = row["topic_id"], sim
    return (best_id, best_score) if best_score >= threshold else (None, best_score)


def ingest(args: argparse.Namespace) -> None:
    payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
    topics = payload.get("topics", [])
    run = payload.get("run", {})
    search_day = parse_date(run.get("search_date"))
    if search_day is None:
        raise ValueError("run.search_date must be an ISO date")
    gate = search_gate(payload, search_day)
    conn = connect(Path(args.db))
    stamp = now_iso()
    normalized: list[dict[str, Any]] = []
    with conn:
        for log in payload.get("searches", []):
            conn.execute(
                "INSERT INTO search_logs(search_date,channel,query,status,result_count,searched_at,time_window,error_text) VALUES(?,?,?,?,?,?,?,?)",
                (run.get("search_date"), log.get("channel", "unknown"), log.get("query", ""), log.get("status", "unknown"), log.get("result_count"), log.get("searched_at", stamp), log.get("time_window"), log.get("error")),
            )
        conn.execute("DELETE FROM search_materials WHERE search_date=?", (search_day.isoformat(),))
        for normalized_material_url, item in gate["items"].items():
            result_id = str(item.get("result_id") or hashlib.sha256(normalized_material_url.encode("utf-8")).hexdigest()[:20])
            conn.execute(
                """INSERT INTO search_materials(result_id,search_date,query,channel,title,url,normalized_url,grade,published_at,accessed_at,clue,in_window,created_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (result_id, search_day.isoformat(), item.get("query", ""), item.get("channel", "unknown"), item.get("title", "未命名资料"), item.get("url", ""), normalized_material_url, str(item.get("grade", "C")).upper(), item.get("published_at"), item.get("accessed_at", stamp), item.get("clue"), 1, stamp),
            )
        for raw in topics:
            topic = dict(raw)
            if not topic.get("topic_id") or not topic.get("company") or not topic.get("latest_event") or not topic.get("suggested_title"):
                raise ValueError("topic_id, company, latest_event and suggested_title are required")
            scores, total = score_topic(topic)
            fingerprint = make_fingerprint(topic)
            dup_id, similarity = find_duplicate(conn, topic, fingerprint, args.similarity_threshold)
            old = conn.execute("SELECT status, created_at FROM topics WHERE topic_id=?", (topic["topic_id"],)).fetchone()
            status = topic.get("status", "candidate")
            if status not in VALID_STATUSES:
                raise ValueError(f"invalid status for {topic['topic_id']}: {status}")
            sources = topic.get("sources", [])
            source_ok, source_reason = source_gate(sources, search_day)
            if status in FINAL_STATUSES and (not gate["ready"] or not source_ok):
                status = "needs_verification"
                reasons = [*gate["failures"]]
                if not source_ok:
                    reasons.append(source_reason)
                topic["rejection_reason"] = "；".join(reasons)
            if dup_id and not topic.get("new_facts") and status not in {"published", "approved"}:
                status = "duplicate"
                topic["dedupe_conclusion"] = f"与历史选题 {dup_id} 重复"
            vals = (
                topic["topic_id"], topic.get("discovered_date", run.get("search_date", "")), topic.get("event_date"), topic.get("first_reported_at"),
                topic.get("industry"), topic["company"], json.dumps(topic.get("company_aliases", []), ensure_ascii=False), topic.get("company_type"),
                topic.get("event_type"), topic["latest_event"], topic.get("key_numbers"), json.dumps(topic.get("contradictions", []), ensure_ascii=False),
                topic["suggested_title"], topic.get("increment"), topic.get("traffic_signal"), topic.get("interview_direction"), topic.get("wording_risk"),
                status, topic.get("grade"), topic.get("rejection_reason"), topic.get("editor_feedback"), topic.get("channel"), topic.get("article_url"), topic.get("published_date"),
                fingerprint, topic.get("semantic_summary") or "；".join([topic.get("latest_event", ""), *topic.get("contradictions", [])]),
                json.dumps(normalize_keywords(topic.get("keywords")), ensure_ascii=False), similarity, dup_id,
                topic.get("netease_finance_check", "not_checked"), topic.get("netease_hao_check", "not_checked"), topic.get("wechat_backend_check", "not_checked"),
                topic.get("new_facts"), topic.get("dedupe_conclusion"), topic.get("override_reason"),
                scores["timeliness"], scores["company"], scores["event"], scores["contradiction"], scores["traffic"], scores["extension"], scores["evidence"], total,
                json.dumps(topic.get("sections", []), ensure_ascii=False), old["created_at"] if old else stamp, stamp,
            )
            conn.execute("""
                INSERT INTO topics VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(topic_id) DO UPDATE SET
                  discovered_date=excluded.discovered_date,event_date=excluded.event_date,first_reported_at=excluded.first_reported_at,
                  industry=excluded.industry,company=excluded.company,company_aliases_json=excluded.company_aliases_json,company_type=excluded.company_type,
                  event_type=excluded.event_type,latest_event=excluded.latest_event,key_numbers=excluded.key_numbers,contradictions_json=excluded.contradictions_json,
                  suggested_title=excluded.suggested_title,increment_text=excluded.increment_text,traffic_signal=excluded.traffic_signal,
                  interview_direction=excluded.interview_direction,wording_risk=excluded.wording_risk,status=excluded.status,grade=excluded.grade,
                  rejection_reason=excluded.rejection_reason,editor_feedback=excluded.editor_feedback,channel_name=excluded.channel_name,
                  article_url=excluded.article_url,published_date=excluded.published_date,fingerprint=excluded.fingerprint,
                  semantic_summary=excluded.semantic_summary,keywords_json=excluded.keywords_json,similarity=excluded.similarity,
                  similar_topic_id=excluded.similar_topic_id,netease_finance_check=excluded.netease_finance_check,
                  netease_hao_check=excluded.netease_hao_check,wechat_backend_check=excluded.wechat_backend_check,new_facts=excluded.new_facts,
                  dedupe_conclusion=excluded.dedupe_conclusion,override_reason=excluded.override_reason,score_timeliness=excluded.score_timeliness,
                  score_company=excluded.score_company,score_event=excluded.score_event,score_contradiction=excluded.score_contradiction,
                  score_traffic=excluded.score_traffic,score_extension=excluded.score_extension,score_evidence=excluded.score_evidence,
                  score_total=excluded.score_total,sections_json=excluded.sections_json,updated_at=excluded.updated_at
            """, vals)
            if not old or old["status"] != status:
                conn.execute("INSERT INTO decisions(topic_id,old_status,new_status,reason,actor,decided_at) VALUES(?,?,?,?,?,?)",
                             (topic["topic_id"], old["status"] if old else None, status, topic.get("rejection_reason") or topic.get("dedupe_conclusion"), args.actor, stamp))
            conn.execute("DELETE FROM topic_sources WHERE topic_id=?", (topic["topic_id"],))
            for idx, src in enumerate(sources, 1):
                source_id = src.get("source_id") or hashlib.sha256((src.get("url", "") + src.get("title", "")).encode("utf-8")).hexdigest()[:16]
                conn.execute("""
                    INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(source_id) DO UPDATE SET name=excluded.name,source_type=excluded.source_type,grade=excluded.grade,title=excluded.title,
                    url=excluded.url,published_at=excluded.published_at,accessed_at=excluded.accessed_at,supports=excluded.supports,
                    quote_text=excluded.quote_text,document_no=excluded.document_no,cross_verified=excluded.cross_verified,directly_citable=excluded.directly_citable
                """, (source_id, src.get("name", "未知来源"), src.get("type"), str(src.get("grade", "C")).upper(), src.get("title", "未命名原文"), src.get("url", ""),
                      src.get("published_at"), src.get("accessed_at", stamp), src.get("supports"), src.get("quote"), src.get("document_no"), bool(src.get("cross_verified")), bool(src.get("directly_citable")), stamp))
                conn.execute("INSERT OR IGNORE INTO topic_sources(topic_id,source_id) VALUES(?,?)", (topic["topic_id"], source_id))
                src["source_id"] = source_id
            topic.update({"status": status, "fingerprint": fingerprint, "similarity": round(similarity, 4), "similar_topic_id": dup_id, "scores": scores, "score_total": total})
            normalized.append(topic)
    public_gate = {key: value for key, value in gate.items() if key != "items"}
    out = {"run": payload.get("run", {}), "search_gate": public_gate, "searches": payload.get("searches", []), "materials": payload.get("materials", []), "topics": normalized}
    if args.output:
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"topics": len(normalized), "final": sum(t["status"] in FINAL_STATUSES for t in normalized), "search_gate": public_gate, "db": str(Path(args.db).resolve())}, ensure_ascii=False))


def export_ledger(args: argparse.Namespace) -> None:
    conn = connect(Path(args.db))
    topic_rows = [dict(r) for r in conn.execute("SELECT * FROM topics ORDER BY discovered_date DESC, score_total DESC, topic_id")]
    source_rows = [dict(r) for r in conn.execute("""
        SELECT ts.topic_id,s.* FROM topic_sources ts JOIN sources s ON s.source_id=ts.source_id
        ORDER BY ts.topic_id,s.grade,s.source_id
    """)]
    decisions = [dict(r) for r in conn.execute("SELECT * FROM decisions ORDER BY decision_id")]
    searches = [dict(r) for r in conn.execute("SELECT * FROM search_logs ORDER BY search_id")]
    materials = [dict(r) for r in conn.execute("SELECT * FROM search_materials ORDER BY search_date DESC, result_id")]
    payload = {"topics": topic_rows, "sources": source_rows, "decisions": decisions, "searches": searches, "materials": materials, "exported_at": now_iso()}
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"topics": len(topic_rows), "sources": len(source_rows), "output": str(Path(args.output).resolve())}, ensure_ascii=False))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    init_p = sub.add_parser("init")
    init_p.add_argument("--db", required=True)
    ingest_p = sub.add_parser("ingest")
    ingest_p.add_argument("--db", required=True)
    ingest_p.add_argument("--input", required=True)
    ingest_p.add_argument("--output")
    ingest_p.add_argument("--similarity-threshold", type=float, default=0.72)
    ingest_p.add_argument("--actor", default="Codex")
    export_p = sub.add_parser("export")
    export_p.add_argument("--db", required=True)
    export_p.add_argument("--output", required=True)
    args = parser.parse_args()
    if args.command == "init":
        connect(Path(args.db)).close()
        print(str(Path(args.db).resolve()))
    elif args.command == "ingest":
        ingest(args)
    else:
        export_ledger(args)


if __name__ == "__main__":
    main()
