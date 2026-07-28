#!/usr/bin/env python3
"""Validate the audit data, workbook, and always-generated source-list DOCX."""

from __future__ import annotations

import argparse
import json
import sqlite3
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REQUIRED_SHEETS = {"每日选题", "信息来源", "历史去重库", "配置与词表"}
BANNED_BODY_MARKS = ("-", "—", "–")


def validate_db(path: Path) -> dict:
    conn = sqlite3.connect(path)
    report_date = conn.execute(
        "SELECT MAX(search_date) FROM (SELECT search_date FROM search_logs UNION ALL SELECT search_date FROM search_materials)"
    ).fetchone()[0]
    topic_count = conn.execute("SELECT COUNT(*) FROM topics").fetchone()[0]
    source_count = conn.execute("SELECT COUNT(*) FROM sources").fetchone()[0]
    orphan_count = conn.execute(
        "SELECT COUNT(*) FROM topic_sources ts LEFT JOIN topics t ON t.topic_id=ts.topic_id "
        "LEFT JOIN sources s ON s.source_id=ts.source_id WHERE t.topic_id IS NULL OR s.source_id IS NULL"
    ).fetchone()[0]
    final_count = conn.execute(
        "SELECT COUNT(*) FROM topics WHERE status IN ('submitted','approved') AND discovered_date=?",
        (report_date,),
    ).fetchone()[0] if report_date else 0
    material_count = conn.execute(
        "SELECT COUNT(*) FROM search_materials WHERE in_window=1 AND search_date=?", (report_date,)
    ).fetchone()[0] if report_date else 0
    web_count = conn.execute(
        "SELECT COUNT(*) FROM search_materials WHERE in_window=1 AND lower(channel)='web_search' AND search_date=?",
        (report_date,),
    ).fetchone()[0] if report_date else 0
    s_material_count = conn.execute(
        "SELECT COUNT(*) FROM search_materials WHERE in_window=1 AND upper(grade)='S' AND search_date=?",
        (report_date,),
    ).fetchone()[0] if report_date else 0
    final_without_s = conn.execute(
        """SELECT COUNT(*) FROM topics t
           WHERE t.status IN ('submitted','approved') AND t.discovered_date=?
             AND NOT EXISTS (
               SELECT 1 FROM topic_sources ts JOIN sources s ON s.source_id=ts.source_id
               WHERE ts.topic_id=t.topic_id AND upper(s.grade)='S' AND s.directly_citable=1
             )""",
        (report_date,),
    ).fetchone()[0] if report_date else 0
    if orphan_count or final_without_s:
        raise ValueError(
            f"SQLite integrity failed: orphans={orphan_count}, final_without_s={final_without_s}"
        )
    failures = []
    if material_count < 100:
        failures.append(f"四天内去重资料不足100条：{material_count}条")
    if web_count == 0:
        failures.append("未记录Web Search资料")
    if final_count < 4:
        failures.append(f"成功选题不足4条：{final_count}条")
    return {
        "topics": topic_count,
        "sources": source_count,
        "report_date": report_date,
        "final": final_count,
        "orphans": orphan_count,
        "qualified_materials": material_count,
        "web_search_materials": web_count,
        "s_grade_materials": s_material_count,
        "final_without_s": final_without_s,
        "complete": not failures,
        "failures": failures,
    }


def validate_xlsx(path: Path) -> dict:
    with zipfile.ZipFile(path) as archive:
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        sheets = {sheet.attrib["name"] for sheet in workbook.findall(f".//{{{S}}}sheet")}
        missing = REQUIRED_SHEETS - sheets
        if missing:
            raise ValueError(f"XLSX missing sheets: {sorted(missing)}")
        error_hits = []
        for name in archive.namelist():
            if name.startswith("xl/worksheets/sheet") and name.endswith(".xml"):
                data = archive.read(name).decode("utf-8", errors="ignore")
                for token in ("#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A"):
                    if token in data:
                        error_hits.append(f"{name}:{token}")
        if error_hits:
            raise ValueError(f"XLSX formula errors: {error_hits}")
    return {"sheets": sorted(sheets), "formula_errors": 0}


def validate_docx(path: Path) -> dict:
    if not path.is_file() or path.stat().st_size == 0:
        raise ValueError("DOCX was not generated")
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        if "word/footnotes.xml" in names or "word/endnotes.xml" in names:
            raise ValueError("DOCX must not contain footnotes or endnotes")
        document = ET.fromstring(archive.read("word/document.xml"))
        if document.findall(f".//{{{W}}}footnoteReference") or document.findall(f".//{{{W}}}endnoteReference"):
            raise ValueError("DOCX body contains note references")
        superscript = [
            item for item in document.findall(f".//{{{W}}}vertAlign")
            if item.attrib.get(f"{{{W}}}val") == "superscript"
        ]
        if superscript:
            raise ValueError("DOCX body contains superscript runs")
        paragraphs = ["".join(paragraph.itertext()).strip() for paragraph in document.findall(f".//{{{W}}}p")]
        if "信息来源" not in paragraphs:
            raise ValueError("DOCX has no final information sources section")
        source_index = len(paragraphs) - 1 - paragraphs[::-1].index("信息来源")
        if source_index >= len(paragraphs) - 1:
            raise ValueError("DOCX information sources section has no content")
        document_text = "".join(paragraphs)
        if "完成状态：" not in document_text or "实际结果：" not in document_text:
            raise ValueError("DOCX does not report completion status and actual result")
        fact_count = 0
        for paragraph in document.findall(f".//{{{W}}}p"):
            ppr = paragraph.find(f"{{{W}}}pPr")
            indent = ppr.find(f"{{{W}}}ind") if ppr is not None else None
            if indent is None or indent.attrib.get(f"{{{W}}}left") != "480":
                continue
            fact_count += 1
            text = "".join(paragraph.itertext()).strip()
            conclusion, separator, data = text.partition("：")
            if separator != "：" or not 2 <= len(conclusion) <= 10 or not data.strip():
                raise ValueError(f"invalid fact paragraph format: {text}")
            if not all("\u3400" <= char <= "\u9fff" for char in conclusion):
                raise ValueError(f"invalid fact conclusion: {conclusion}")
            banned = [mark for mark in BANNED_BODY_MARKS if mark in text]
            if banned:
                raise ValueError(f"fact paragraph contains banned punctuation: {''.join(banned)}")
    return {
        "exists": True,
        "notes": 0,
        "superscript": 0,
        "sources_section": True,
        "fact_paragraphs": fact_count,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True)
    parser.add_argument("--xlsx", required=True)
    parser.add_argument("--docx", required=True)
    args = parser.parse_args()
    result = {
        "sqlite": validate_db(Path(args.db)),
        "xlsx": validate_xlsx(Path(args.xlsx)),
        "docx": validate_docx(Path(args.docx)),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
