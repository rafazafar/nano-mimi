"""Run the Python pipeline over a WAV at 1x and dump its log rows, the reference for web/bench/pipeline.compare.py.

    PYTHONPATH=src uv run python web/bench/pipeline.baseline.py data/fixtures/meeting-recording.wav \
        --runs 5 --out web/.bench/results/python-meeting.json

Same path as scripts/eval/run_eval.py's meeting runs (``pipeline.run(..., realtime_feed=True)`` on the default
settings, no glossary), with one difference: the live VAD overrides (400 ms silence close) are applied, because
the web app only has the live tuning and a file replay would otherwise wait 700 ms to close each utterance.
Pass ``--replay-vad`` for the 700 ms replay tuning. Each run resets the translation cache.

Perceived latency is the eval's definition: VAD wait + queue wait + ASR + CAT, per log row. Hold the GPU lock.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import sys
import tempfile
from pathlib import Path

from mimivox import config, pipeline
from mimivox.config import reset_translation_cache
from mimivox.settings_store import apply_settings_for_session, default_settings


async def one_run(wav: Path, log_dir: Path) -> list[dict]:
    reset_translation_cache()
    pipeline.DATA_DIR = str(log_dir)
    await pipeline.run(str(wav), live=False, asr_only=False, realtime_feed=True)
    log = log_dir / "logs" / f"{wav.stem}_v3_log.jsonl"
    rows = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines() if line]
    log.unlink()
    return rows


def perceived(row: dict) -> float:
    return (
        row.get("vad_wait_s", 0.0)
        + row.get("queue_wait_s", 0.0)
        + row["asr_latency_s"]
        + row["translate_latency_s"]
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("wav", type=Path)
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument(
        "--replay-vad", action="store_true", help="keep the 700 ms replay silence close"
    )
    args = ap.parse_args()

    apply_settings_for_session(default_settings())
    if not args.replay_vad:
        config.apply_live_vad_overrides()
    tuning = config.latency_tuning_snapshot()

    runs: list[dict] = []
    log_path = args.out.with_suffix(".log")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with (
        open(log_path, "w", encoding="utf-8") as log_file,
        contextlib.redirect_stdout(log_file),
        tempfile.TemporaryDirectory() as tmp,
    ):
        pipeline.load_all_models()

        async def go() -> None:
            for i in range(args.runs):
                load = os.getloadavg()[0]
                rows = await one_run(args.wav, Path(tmp))
                for r in rows:
                    r["perceived_s"] = round(perceived(r), 3)
                runs.append({"run": i, "load1": round(load, 2), "rows": rows})
                print(f"run {i}: {len(rows)} rows", file=sys.stderr, flush=True)

        asyncio.run(go())

    out = {"wav": args.wav.name, "tuning": tuning, "replay_vad": args.replay_vad, "runs": runs}
    args.out.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
