"""Score ASR bench runs (web/.bench/results/<name>.json) with the repo's CER.

    uv run python web/bench/asr_score.py NAME [NAME...]

Per pass: CER (mimivox.eval.metrics.cer) on the final text, latency p50/p95 of the
main-thread round trip, RTF (sum of round trips / sum of audio), and the per-stage
medians. The bars are W5's: CER <= MLX + 1.0 point, p50 <= 1.5x MLX. MLX Haas-ja 8-bit
measured 3.93% CER and 121 ms p50 on these clips (docs/plans/s0/s0b-asr.md).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

from mimivox.eval.metrics import cer

BENCH = Path(__file__).resolve().parent.parent / ".bench"
MLX_CER, MLX_P50 = 3.93, 121.0


def main() -> None:
    clips = {c["sid"]: c for c in json.loads((BENCH / "clips.json").read_text())}
    for name in sys.argv[1:]:
        run = json.loads((BENCH / "results" / f"{name}.json").read_text())
        res = run["result"]
        print(
            f"{name}: {json.dumps(res['device'])} load {res['loadMs']:.0f} ms, cold clip {res['cold']['ms']:.0f} ms"
        )
        for i, rows in enumerate(res["passes"]):
            score = 100 * cer([clips[r["sid"]]["ref"] for r in rows], [r["text"] for r in rows])
            ms = np.array([r["ms"] for r in rows])
            rtf = ms.sum() / 1000 / sum(clips[r["sid"]]["dur_s"] for r in rows)
            p50, p95 = np.percentile(ms, 50), np.percentile(ms, 95)
            stages = " ".join(
                f"{k[:-2]} {np.median([r[k] for r in rows]):.1f}"
                for k in ("melMs", "encMs", "decMs")
            )
            verdict = "PASS" if score <= MLX_CER + 1.0 and p50 <= 1.5 * MLX_P50 else "FAIL"
            print(
                f"  pass {i}: n={len(rows)} CER {score:.2f}% p50 {p50:.1f} ms p95 {p95:.1f} ms RTF {rtf:.4f}"
                f" ({p50 / MLX_P50:.2f}x MLX) | medians {stages} | {verdict}"
            )


if __name__ == "__main__":
    main()
