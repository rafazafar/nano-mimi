"""scripts/eval/web_eval.py score: browser rows become a report.json that compare_reports can judge."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

SCRIPTS = Path(__file__).parent.parent / "scripts" / "eval"


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    sys.path.insert(0, str(SCRIPTS))  # web_eval imports its sibling common.py
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(str(SCRIPTS))
    return module


web_eval = _load("web_eval")
compare_reports = _load("compare_reports")


def _row(ja: str, en: str, start: float, dur: float) -> dict:
    return {
        "id": 1,
        "ja": ja,
        "en": en,
        "timeline_s": start,
        "duration_s": dur,
        "vad_wait_s": 0.4,
        "queue_wait_s": 0.0,
        "asr_latency_s": 0.1,
        "translate_latency_s": 0.3,
        "merged_ids": [],
        "source": "mt",
    }


MANIFEST = {
    "seed": 0,
    "levels": "rms",
    "clips": [{"sid": "7", "wav": "a.wav", "ja_norm": "こんにちは", "en": "Hello", "seconds": 2.0}],
    "meetings": [
        {
            "name": "meeting-1.wav",
            "seconds": 10.0,
            "truth": {
                "lines": [
                    {
                        "speaker": "A",
                        "ja": "おはよう",
                        "en": "Good morning",
                        "start_s": 1.0,
                        "end_s": 3.0,
                    },
                    {
                        "speaker": "B",
                        "ja": "さようなら",
                        "en": "Goodbye",
                        "start_s": 5.0,
                        "end_s": 7.0,
                    },
                ]
            },
        }
    ],
}


def _run(complete: bool = True, error: str | None = None) -> dict:
    meeting = {
        "name": "meeting-1.wav",
        "rows": [_row("おはよう", "Good morning", 1.0, 2.0)],  # the second line gets no row
        "unsettled": 0,
        "errors": [],
    }
    clip = {
        "sid": "7",
        "rows": [_row("こんにちは", "Hello", 0.2, 1.5)],
        "unsettled": 0,
        "errors": [],
    }
    if error:
        clip["error"] = error
    return {
        "complete": complete,
        "runtime": {"kind": "web", "realtime": True},
        "clips": [clip],
        "meetings": [meeting],
    }


def _score(tmp_path: Path, run: dict) -> int:
    (tmp_path / "inputs").mkdir(exist_ok=True)
    (tmp_path / "inputs" / "manifest.json").write_text(json.dumps(MANIFEST), encoding="utf-8")
    rows = tmp_path / "run" / "rows.json"
    rows.parent.mkdir(exist_ok=True)
    rows.write_text(json.dumps(run), encoding="utf-8")
    return web_eval.score(argparse.Namespace(rows=rows, inputs=tmp_path / "inputs"))


def test_score_writes_a_report_in_run_evals_schema_with_the_same_scoring(tmp_path):
    assert _score(tmp_path, _run()) == 0
    report = json.loads((tmp_path / "run" / "report.json").read_text(encoding="utf-8"))
    assert set(report) == {"meta", "clips", "meetings", "per_meeting"}
    assert report["clips"]["n"] == 1 and report["clips"]["cer"] == 0.0
    assert report["meetings"]["n"] == 1 and report["meetings"]["lines"] == 2
    assert report["meetings"]["missed_lines"] == 1  # the unanswered line
    assert report["meetings"]["realtime"] is True
    assert report["clips"]["latency"]["perceived_s"]["p50"] == 0.8  # 0.4 + 0.0 + 0.1 + 0.3
    assert (tmp_path / "run" / "report.md").read_text().startswith("| set |")


def test_a_web_report_has_every_metric_compare_reports_needs(tmp_path):
    _score(tmp_path, _run())
    report = tmp_path / "run" / "report.json"
    code = compare_reports.main([str(report), str(report)])
    assert code == compare_reports.EXIT_PASS


def test_an_incomplete_or_failed_browser_run_is_refused_without_a_report(tmp_path):
    assert _score(tmp_path, _run(complete=False)) == 2
    assert _score(tmp_path, _run(error="app needs attention: boom")) == 2
    assert not (tmp_path / "run" / "report.json").exists()
