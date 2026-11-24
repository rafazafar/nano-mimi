"""scripts/eval/compare_reports.py: the browser-parity bars, and refusing instead of passing on gaps."""

from __future__ import annotations

import copy
import importlib.util
import json
import sys
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location(
    "compare_reports", Path(__file__).parent.parent / "scripts" / "eval" / "compare_reports.py"
)
cr = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = cr  # dataclasses resolve their annotations through sys.modules
_spec.loader.exec_module(cr)


def _section(missed: int | None = None) -> dict:
    s = {
        "n": 100,
        "cer": 0.040,
        "chrf": 50.0,
        "latency": {
            "asr_s": {"p50": 0.12, "p95": 0.30},
            "cat_s": {"p50": 0.30, "p95": 0.60},
            "perceived_s": {"p50": 1.00, "p95": 2.00},
        },
        "revisions": 1,
    }
    if missed is not None:
        s["missed_lines"] = missed
    return s


def baseline() -> dict:
    return {"meta": {}, "clips": _section(), "meetings": _section(missed=2)}


def run(tmp_path, base: dict, cand: dict, *extra: str) -> int:
    b, c = tmp_path / "base.json", tmp_path / "cand.json"
    b.write_text(json.dumps(base))
    c.write_text(json.dumps(cand))
    return cr.main([str(b), str(c), *extra])


def worse(set_name: str, path: tuple[str, ...], value: float) -> dict:
    report = baseline()
    node = report[set_name]
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = value
    return report


def test_identical_reports_pass(tmp_path, capsys):
    assert run(tmp_path, baseline(), baseline()) == cr.EXIT_PASS
    assert "PASSED" in capsys.readouterr().out


def test_a_better_candidate_passes(tmp_path):
    better = baseline()
    for s in ("clips", "meetings"):
        better[s]["cer"] = 0.02
        better[s]["chrf"] = 55.0
        better[s]["latency"]["perceived_s"] = {"p50": 0.5, "p95": 1.0}
    better["meetings"]["missed_lines"] = 0
    assert run(tmp_path, baseline(), better) == cr.EXIT_PASS


# (metric as the table names it, report path, a value just over its bar)
WORSE = [
    ("CER", ("cer",), 0.0501),  # baseline 4.0%, bar +1.0 pt
    ("chrF", ("chrf",), 48.49),  # baseline 50.0, bar -1.5
    ("perceived p50", ("latency", "perceived_s", "p50"), 1.51),  # baseline 1.0, bar x1.5
    ("perceived p95", ("latency", "perceived_s", "p95"), 4.01),  # baseline 2.0, bar x2
]


@pytest.mark.parametrize("set_name", ["clips", "meetings"])
@pytest.mark.parametrize(("metric", "path", "value"), WORSE)
def test_a_seeded_worse_report_fails_each_metric(tmp_path, capsys, set_name, metric, path, value):
    assert run(tmp_path, baseline(), worse(set_name, path, value)) == cr.EXIT_FAIL
    out = capsys.readouterr().out
    assert f"FAILED: {set_name} {metric}" in out
    assert out.count("FAIL |") == 1  # the one seeded metric, nothing else


def test_more_missed_lines_than_the_baseline_fails(tmp_path, capsys):
    assert run(tmp_path, baseline(), worse("meetings", ("missed_lines",), 3)) == cr.EXIT_FAIL
    assert "FAILED: meetings missed lines" in capsys.readouterr().out


@pytest.mark.parametrize(
    ("set_name", "path", "value"),
    [
        ("clips", ("cer",), 0.050),
        ("clips", ("chrf",), 48.5),
        ("clips", ("latency", "perceived_s", "p50"), 1.5),
        ("clips", ("latency", "perceived_s", "p95"), 4.0),
        ("meetings", ("missed_lines",), 2),
    ],
)
def test_a_metric_exactly_at_its_bar_passes(tmp_path, set_name, path, value):
    assert run(tmp_path, baseline(), worse(set_name, path, value)) == cr.EXIT_PASS


def test_every_failing_metric_is_named(tmp_path, capsys):
    cand = baseline()
    cand["clips"]["cer"] = 0.2
    cand["meetings"]["missed_lines"] = 9
    assert run(tmp_path, baseline(), cand) == cr.EXIT_FAIL
    out = capsys.readouterr().out
    assert "clips CER" in out and "meetings missed lines" in out


REQUIRED = [
    ("cer",),
    ("chrf",),
    ("latency", "perceived_s", "p50"),
    ("latency", "perceived_s", "p95"),
    ("latency", "perceived_s"),
    ("latency",),
]


def _without(report: dict, set_name: str, path: tuple[str, ...]) -> dict:
    report = copy.deepcopy(report)
    node = report[set_name]
    for key in path[:-1]:
        node = node[key]
    del node[path[-1]]
    return report


@pytest.mark.parametrize("set_name", ["clips", "meetings"])
@pytest.mark.parametrize("path", REQUIRED)
def test_a_metric_missing_from_the_candidate_refuses(tmp_path, capsys, set_name, path):
    assert run(tmp_path, baseline(), _without(baseline(), set_name, path)) == cr.EXIT_REFUSED
    out = capsys.readouterr().out
    assert "REFUSED" in out and "PASSED" not in out and "FAILED" not in out


def test_a_metric_missing_from_the_baseline_refuses(tmp_path, capsys):
    base = _without(baseline(), "clips", ("chrf",))
    assert run(tmp_path, base, baseline()) == cr.EXIT_REFUSED
    assert "REFUSED" in capsys.readouterr().out


def test_missed_lines_missing_refuses(tmp_path):
    cand = _without(baseline(), "meetings", ("missed_lines",))
    assert run(tmp_path, baseline(), cand) == cr.EXIT_REFUSED


def test_a_missing_set_refuses(tmp_path):
    cand = baseline()
    del cand["meetings"]
    assert run(tmp_path, baseline(), cand) == cr.EXIT_REFUSED


@pytest.mark.parametrize("bad", [None, float("nan"), float("inf"), "0.04", True])
def test_a_value_that_is_not_a_finite_number_counts_as_missing(tmp_path, bad):
    assert run(tmp_path, baseline(), worse("clips", ("cer",), bad)) == cr.EXIT_REFUSED


def test_a_gap_is_not_hidden_by_a_failing_metric(tmp_path, capsys):
    cand = _without(worse("clips", ("cer",), 0.5), "meetings", ("chrf",))
    assert run(tmp_path, baseline(), cand) == cr.EXIT_REFUSED
    assert "REFUSED" in capsys.readouterr().out


def test_refusal_and_failure_are_distinct_statuses():
    assert len({cr.EXIT_PASS, cr.EXIT_FAIL, cr.EXIT_REFUSED}) == 3


def test_informational_latency_rows_never_refuse(tmp_path, capsys):
    cand = baseline()
    del cand["clips"]["latency"]["asr_s"]
    del cand["meetings"]["latency"]["cat_s"]
    assert run(tmp_path, baseline(), cand) == cr.EXIT_PASS
    assert "n/a" in capsys.readouterr().out


def test_sets_limits_what_is_judged(tmp_path):
    cand = baseline()
    del cand["meetings"]
    assert run(tmp_path, baseline(), cand, "--sets", "clips") == cr.EXIT_PASS
    assert run(tmp_path, baseline(), cand) == cr.EXIT_REFUSED


def test_the_table_shows_each_sets_sample_size(tmp_path, capsys):
    cand = baseline()
    cand["clips"]["n"] = 20
    run(tmp_path, baseline(), cand)
    assert "| clips | 100 / 20 | CER |" in capsys.readouterr().out
