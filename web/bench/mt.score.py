"""Score MT bench results: corpus chrF against the FLEURS references, CAT latency, decode speed.

    uv run python web/bench/mt.score.py <results.json> [<results.json> ...]

Latency is the worker's time for the whole retry ladder (prompt render, encode,
generate, clean, retries). `first` is the first pass alone, which is what the
S0a/MLX baseline timed (it left the number retry out).
"""

import json
import statistics
import sys
from pathlib import Path

from mimivox.eval.metrics import chrf


def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(q * (len(xs) - 1))))]


def summarize(path):
    data = json.loads(Path(path).read_text())
    rows = data["rows"]
    total = [r["result"]["totalMs"] / 1000 for r in rows]
    first = [r["result"]["attempts"][0]["ms"] / 1000 for r in rows]
    ttft = [
        a["ttftMs"] / 1000
        for r in rows
        for a in r["result"]["attempts"][:1]
        if a["ttftMs"] is not None
    ]
    firsts = [r["result"]["attempts"][0] for r in rows]
    tps = [a["decodeTps"] for a in firsts if a["decodeTps"]]
    agg = sum(a["tokens"] - 1 for a in firsts if a["decodeTps"]) / sum(
        (a["tokens"] - 1) / a["decodeTps"] for a in firsts if a["decodeTps"]
    )
    return {
        "file": path,
        "adapter": data["gpu"],
        "load": data["load"],
        "n": len(rows),
        "chrf": round(chrf([r["ref"] for r in rows], [r["result"]["en"] for r in rows]), 2),
        "cat_p50_s": round(pct(total, 0.5), 3),
        "cat_p95_s": round(pct(total, 0.95), 3),
        "first_pass_p50_s": round(pct(first, 0.5), 3),
        "first_pass_p95_s": round(pct(first, 0.95), 3),
        "ttft_p50_s": round(pct(ttft, 0.5), 3),
        "decode_tps_median": round(statistics.median(tps), 1),
        "decode_tps_aggregate": round(agg, 1),
        "mean_tokens": round(statistics.mean(a["tokens"] for a in firsts), 1),
        "retried": sum(1 for r in rows if len(r["result"]["attempts"]) > 1),
        "prompt_leaks_cleaned": sum(1 for r in rows if r["result"]["promptLeak"]),
        "empty": sum(1 for r in rows if not r["result"]["en"]),
    }


for p in sys.argv[1:]:
    print(json.dumps(summarize(p)))
