"""Compare two eval report.json files against the browser-parity bars.

    python scripts/eval/compare_reports.py BASELINE.json CANDIDATE.json [--sets clips meetings]

The reports come from run_eval.py (the macOS baseline) and web/eval (the browser run). Per set:

    CER                  candidate - baseline <= 1.0 percentage point
    chrF                 candidate >= baseline - 1.5
    perceived p50        candidate <= 1.5 x baseline
    perceived p95        candidate <= 2.0 x baseline
    missed lines         candidate <= baseline (meetings only)

Exit status: 0 every bar holds, 1 at least one bar failed, 2 refused because a metric the
bars need is missing or not a number in either report (nothing is judged then, so a gap can
never read as a pass).
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

EXIT_PASS, EXIT_FAIL, EXIT_REFUSED = 0, 1, 2
EPS = 1e-9

CER_BAR_PT = 1.0
CHRF_BAR = 1.5
P50_BAR = 1.5
P95_BAR = 2.0


@dataclass(frozen=True)
class Metric:
    """One number in a set's section of the report, and the bar (if any) it must clear."""

    name: str
    path: tuple[str, ...]
    show: Callable[[float], str]
    bar: str = ""
    delta: Callable[[float, float], str] = lambda b, c: f"{c - b:+.2f}"
    ok: Callable[[float, float], bool] | None = None
    sets: tuple[str, ...] = ("clips", "meetings")
    required: bool = True  # informational rows never refuse


def _pct(v: float) -> str:
    return f"{v * 100:.2f}%"


def _secs(v: float) -> str:
    return f"{v:.3f} s"


def _ratio(b: float, c: float) -> str:
    return f"{c / b:.2f}x" if b > 0 else "n/a"


METRICS: tuple[Metric, ...] = (
    Metric(
        "CER",
        ("cer",),
        _pct,
        f"+{CER_BAR_PT:.1f} pt",
        lambda b, c: f"{(c - b) * 100:+.2f} pt",
        lambda b, c: (c - b) * 100 <= CER_BAR_PT + EPS,
    ),
    Metric(
        "chrF",
        ("chrf",),
        lambda v: f"{v:.2f}",
        f"-{CHRF_BAR:.1f}",
        lambda b, c: f"{c - b:+.2f}",
        lambda b, c: c >= b - CHRF_BAR - EPS,
    ),
    Metric(
        "perceived p50",
        ("latency", "perceived_s", "p50"),
        _secs,
        f"x{P50_BAR:g}",
        _ratio,
        lambda b, c: c <= b * P50_BAR + EPS,
    ),
    Metric(
        "perceived p95",
        ("latency", "perceived_s", "p95"),
        _secs,
        f"x{P95_BAR:g}",
        _ratio,
        lambda b, c: c <= b * P95_BAR + EPS,
    ),
    Metric(
        "missed lines",
        ("missed_lines",),
        lambda v: f"{v:g}",
        "<= baseline",
        lambda b, c: f"{c - b:+g}",
        lambda b, c: c <= b,
        sets=("meetings",),
    ),
    Metric("ASR p50", ("latency", "asr_s", "p50"), _secs, delta=_ratio, required=False),
    Metric("ASR p95", ("latency", "asr_s", "p95"), _secs, delta=_ratio, required=False),
    Metric("CAT p50", ("latency", "cat_s", "p50"), _secs, delta=_ratio, required=False),
    Metric("CAT p95", ("latency", "cat_s", "p95"), _secs, delta=_ratio, required=False),
)


def lookup(report: dict, set_name: str, path: Sequence[str]) -> float | None:
    """The number at ``path`` inside the set's section, or None when it is absent or not a finite number."""
    node = report.get(set_name)
    for key in path:
        if not isinstance(node, dict) or key not in node:
            return None
        node = node[key]
    if isinstance(node, bool) or not isinstance(node, (int, float)) or not math.isfinite(node):
        return None
    return float(node)


@dataclass(frozen=True)
class Row:
    set: str
    metric: Metric
    baseline: float | None
    candidate: float | None

    @property
    def missing(self) -> bool:
        return self.baseline is None or self.candidate is None

    @property
    def passed(self) -> bool | None:
        """None for an informational row or one that cannot be judged."""
        if self.metric.ok is None or self.baseline is None or self.candidate is None:
            return None
        return self.metric.ok(self.baseline, self.candidate)


def collect(baseline: dict, candidate: dict, sets: Sequence[str]) -> list[Row]:
    return [
        Row(s, m, lookup(baseline, s, m.path), lookup(candidate, s, m.path))
        for s in sets
        for m in METRICS
        if s in m.sets
    ]


def verdict(rows: Sequence[Row]) -> int:
    if any(r.missing and r.metric.required for r in rows):
        return EXIT_REFUSED
    return EXIT_FAIL if any(r.passed is False for r in rows) else EXIT_PASS


def _sample(report: dict, set_name: str) -> str:
    n = lookup(report, set_name, ("n",))
    return "?" if n is None else f"{n:g}"


def render(rows: Sequence[Row], baseline: dict, candidate: dict) -> str:
    out = ["| set | n (base / cand) | metric | baseline | candidate | change | bar | verdict |"]
    out.append("|---|---|---|---|---|---|---|---|")
    for r in rows:
        m = r.metric
        if r.baseline is None or r.candidate is None:
            change, status = "-", "MISSING" if m.required else "n/a"
        else:
            change = m.delta(r.baseline, r.candidate)
            status = {True: "pass", False: "FAIL", None: "info"}[r.passed]
        base = "MISSING" if r.baseline is None else m.show(r.baseline)
        cand = "MISSING" if r.candidate is None else m.show(r.candidate)
        n = f"{_sample(baseline, r.set)} / {_sample(candidate, r.set)}"
        out.append(
            f"| {r.set} | {n} | {m.name} | {base} | {cand} | {change} | {m.bar or '-'} | {status} |"
        )
    return "\n".join(out)


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("baseline", type=Path)
    ap.add_argument("candidate", type=Path)
    ap.add_argument(
        "--sets",
        nargs="+",
        default=["clips", "meetings"],
        choices=["clips", "meetings"],
        help="report sections to judge (default: both)",
    )
    args = ap.parse_args(argv)
    baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
    candidate = json.loads(args.candidate.read_text(encoding="utf-8"))

    rows = collect(baseline, candidate, args.sets)
    print(render(rows, baseline, candidate))
    code = verdict(rows)
    if code == EXIT_REFUSED:
        gaps = [f"{r.set} {r.metric.name}" for r in rows if r.missing and r.metric.required]
        print(f"\nREFUSED: no verdict, missing or non-numeric metric(s): {', '.join(gaps)}")
    elif code == EXIT_FAIL:
        failed = [f"{r.set} {r.metric.name}" for r in rows if r.passed is False]
        print(f"\nFAILED: {', '.join(failed)}")
    else:
        print("\nPASSED: every bar holds")
    return code


if __name__ == "__main__":
    sys.exit(main())
