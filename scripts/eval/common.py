"""Helpers shared by run_eval.py (macOS) and web_eval.py (browser). No model code, so no MLX import."""

from __future__ import annotations

import json
import random
import subprocess
from pathlib import Path

from mimivox.eval.fleurs import FLEURS_CODE, load_clips
from mimivox.eval.scoring import markdown_table
from mimivox.languages import DEFAULT_PAIR, LanguagePair


def sample_clips(cache: Path, n: int, seed: int, pair: LanguagePair = DEFAULT_PAIR):
    """One random recording per sentence id, so no sentence is scored twice."""
    by_sid: dict[str, list] = {}
    for c in load_clips(cache, FLEURS_CODE[pair.source], FLEURS_CODE[pair.target]):
        by_sid.setdefault(c.sid, []).append(c)
    rng = random.Random(seed)
    sids = sorted(by_sid)
    rng.shuffle(sids)
    return [rng.choice(by_sid[s]) for s in sids[:n]]


def git_sha() -> str:
    try:
        return subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], text=True).strip()
    except Exception:
        return "unknown"


def write_report(out: Path, meta: dict, clip_report, meeting_report, scored: list[dict]) -> None:
    table = markdown_table(clip_report, meeting_report)
    report = {"meta": meta, "clips": clip_report, "meetings": meeting_report, "per_meeting": scored}
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    (out / "report.md").write_text(table)
    print(table)
    print(f"report: {out}")
