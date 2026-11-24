"""Compare a web live run (bench/live-drive.ts) with the Python pipeline on the same file.

    uv run python web/bench/live_compare.py <live.json> <python.json> [--out <json>]

The Python side comes from `pipeline.baseline.py`. Perceived latency is the eval's definition on both sides:
VAD wait + queue wait + ASR + translate. The web side also has end to end, counted from the end of speech.
The bar is p50 at most 1.5x and p95 at most 2x the Python figure.
"""

import argparse
import difflib
import json
import re
import unicodedata
from pathlib import Path

BAR_P50 = 1.5
BAR_P95 = 2.0


def percentile(values, p):
    ordered = sorted(values)
    rank = p * (len(ordered) - 1)
    lo = int(rank)
    hi = min(lo + 1, len(ordered) - 1)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (rank - lo)


def seconds(text):
    match = re.match(r"([\d.]+)\s*(ms|s)", text or "")
    if match is None:
        return None
    value = float(match.group(1))
    return value / 1000 if match.group(2) == "ms" else value


def norm(text):
    return re.sub(r"[\s。、．，.,!?！？]", "", unicodedata.normalize("NFKC", text))


def python_gaps(rows):
    """Row ids Python skipped: each one is a fragment merged into the row before it."""
    ids = [r["id"] for r in rows]
    return [i for i in range(ids[0], ids[-1] + 1) if i not in ids]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("live")
    ap.add_argument("python")
    ap.add_argument("--out")
    args = ap.parse_args()
    live = json.loads(Path(args.live).read_text())
    py = json.loads(Path(args.python).read_text())

    report = {"live": args.live, "python": args.python, "env": live.get("env")}
    py_last = py["runs"][-1]["rows"]
    print(
        f"audio {live['audioS']:.1f} s; web runs {len(live['runs'])}, python runs {len(py['runs'])}"
    )

    print("\nRows and Japanese text (web vs the last Python run)")
    row_reports = []
    for run in live["runs"]:
        rows = run["rows"]
        empty = [r["id"] for r in rows if not r["en"].strip()]
        pairs = list(zip(rows, py_last))
        exact = sum(1 for w, p in pairs if w["ja"] == p["ja"])
        loose = sum(1 for w, p in pairs if norm(w["ja"]) == norm(p["ja"]))
        sims = [
            difflib.SequenceMatcher(None, norm(w["ja"]), norm(p["ja"])).ratio() for w, p in pairs
        ]
        revised = [r["id"] for r in rows if r["revisions"] > 0]
        print(
            f"run {run['index']}: {len(rows)} rows (python {len(py_last)}), empty English {empty or 'none'}, "
            f"JA exact {exact}/{len(pairs)}, normalized {loose}/{len(pairs)}, mean similarity {sum(sims) / max(1, len(sims)):.3f}, "
            f"revised rows {revised or 'none'} (python merged ids {python_gaps(py_last) or 'none'})"
        )
        for w, p in pairs:
            if norm(w["ja"]) != norm(p["ja"]):
                print(f"    row {w['id']}  web: {w['ja']}\n           py: {p['ja']}")
        row_reports.append(
            {
                "run": run["index"],
                "rows": len(rows),
                "pythonRows": len(py_last),
                "emptyEnglish": empty,
                "jaExact": exact,
                "jaNormalized": loose,
                "revisedRows": revised,
            }
        )
    report["rows"] = row_reports

    py_all = [r["perceived_s"] for run in py["runs"] for r in run["rows"]]
    py_warm = [r["perceived_s"] for run in py["runs"][1:] for r in run["rows"]]
    web_by_run = [
        [seconds(r["timing"].get("Perceived")) for r in run["rows"]] for run in live["runs"]
    ]
    web_all = [v for run in web_by_run for v in run if v is not None]
    web_warm = [v for run in web_by_run[1:] for v in run if v is not None]
    e2e_all = [seconds(r["timing"].get("End to end")) for run in live["runs"] for r in run["rows"]]
    e2e_all = [v for v in e2e_all if v is not None]

    print("\nPerceived latency, s (VAD wait + queue wait + ASR + translate)")
    print(f"{'':28}{'n':>4}{'p50':>8}{'p95':>8}")
    perf = {}
    for label, values in (
        ("python, all runs", py_all),
        ("python, warm runs", py_warm),
        ("web, all runs", web_all),
        ("web, warm runs", web_warm),
        ("web end to end, all", e2e_all),
    ):
        if values:
            perf[label] = {
                "n": len(values),
                "p50": percentile(values, 0.5),
                "p95": percentile(values, 0.95),
            }
            print(f"{label:28}{len(values):>4}{perf[label]['p50']:>8.3f}{perf[label]['p95']:>8.3f}")
    report["perceived"] = perf

    print(f"\nAgainst the bar (p50 <= {BAR_P50:.1f}x, p95 <= {BAR_P95:.1f}x the Python figure)")
    for web_label, py_label in (
        ("web, all runs", "python, all runs"),
        ("web, warm runs", "python, warm runs"),
    ):
        if web_label in perf and py_label in perf:
            r50 = perf[web_label]["p50"] / perf[py_label]["p50"]
            r95 = perf[web_label]["p95"] / perf[py_label]["p95"]
            ok = r50 <= BAR_P50 and r95 <= BAR_P95
            print(
                f"{web_label} vs {py_label}: p50 {r50:.2f}x, p95 {r95:.2f}x -> {'within the bar' if ok else 'OVER the bar'}"
            )
            report[f"ratio {web_label}"] = {"p50": r50, "p95": r95, "ok": ok}

    print("\nWhere the web time goes, mean over all rows, s")
    parts = [
        "VAD wait",
        "Queue wait",
        "Speech recognition",
        "Translation",
        "Perceived",
        "End to end",
    ]
    for part in parts:
        vals = [seconds(r["timing"].get(part)) for run in live["runs"] for r in run["rows"]]
        vals = [v for v in vals if v is not None]
        if vals:
            print(f"  {part:20}{sum(vals) / len(vals):>7.3f}   (p50 {percentile(vals, 0.5):.3f})")
    py_parts = [
        ("VAD wait", "vad_wait_s"),
        ("Queue wait", "queue_wait_s"),
        ("Speech recognition", "asr_latency_s"),
        ("Translation", "translate_latency_s"),
    ]
    print("Python, mean over all rows, s")
    for label, key in py_parts:
        vals = [r[key] for run in py["runs"] for r in run["rows"]]
        print(f"  {label:20}{sum(vals) / len(vals):>7.3f}   (p50 {percentile(vals, 0.5):.3f})")

    if args.out:
        Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=1))


main()
