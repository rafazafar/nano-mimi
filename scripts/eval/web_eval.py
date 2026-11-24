"""The Python halves of the browser eval: build its inputs, then score what the browser produced.

    python scripts/eval/web_eval.py prepare [--clips 100] [--seed 0]      # data/eval/web-inputs/
    (cd web && node eval/run.ts --inputs ../data/eval/web-inputs --out <dir>/rows.json)
    python scripts/eval/web_eval.py score --rows <dir>/rows.json          # <dir>/report.json

``prepare`` picks the clips run_eval.py picks (same sampler and seed), levels them the same way, copies
the synthetic meetings and embeds every reference, so the inputs directory is all a machine without the
FLEURS cache needs. ``score`` hands the rows the browser logged to run_eval.py's own scoring functions and
writes a report.json in run_eval.py's schema, so compare_reports.py can diff it with the macOS baseline.
Neither step imports MLX, so both run anywhere the browser run does.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from common import git_sha, sample_clips, write_report

from mimivox.eval.fleurs import DEFAULT_CACHE
from mimivox.eval.meetings import SAMPLE_RATE, normalize_rms, read_wav, write_wav
from mimivox.eval.scoring import aggregate_meetings, score_clips, score_meeting
from mimivox.languages import DEFAULT_PAIR

DEFAULT_INPUTS = Path("data/eval/web-inputs")


def prepare(args: argparse.Namespace) -> None:
    out: Path = args.inputs
    shutil.rmtree(out, ignore_errors=True)
    clips = []
    for i, c in enumerate(sample_clips(args.cache, args.clips, args.seed, DEFAULT_PAIR), 1):
        pcm = read_wav(c.wav)
        if not args.raw_levels:
            pcm = normalize_rms(pcm)
        file = Path("clips") / f"clip-{i:03d}.wav"
        write_wav(out / file, pcm)
        clips.append(
            {
                "sid": c.sid,
                "wav": c.wav.name,
                "ja_norm": c.ja_norm,
                "en": c.en,
                "file": file.as_posix(),
                "seconds": len(pcm) / SAMPLE_RATE,
            }
        )
    meetings = []
    for wav in sorted(args.meetings_dir.glob("meeting-*.wav")):
        file = Path("meetings") / wav.name
        (out / file).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(wav, out / file)
        meetings.append(
            {
                "name": wav.name,
                "file": file.as_posix(),
                "seconds": len(read_wav(wav)) / SAMPLE_RATE,
                "truth": json.loads(wav.with_suffix(".json").read_text(encoding="utf-8")),
            }
        )
    if (args.clips and not clips) or not meetings:
        raise SystemExit(
            "no FLEURS clips or no meetings: run scripts/eval/fetch_fleurs.py and build_meetings.py first"
        )
    manifest = {
        "seed": args.seed,
        "levels": "raw" if args.raw_levels else "rms",
        "clips": clips,
        "meetings": meetings,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    minutes = (sum(c["seconds"] for c in clips) + sum(m["seconds"] for m in meetings)) / 60
    print(f"{out}: {len(clips)} clips, {len(meetings)} meetings, {minutes:.0f} min of audio at 1x")


def _by_key(items: list[dict], key: str) -> dict[str, dict]:
    return {i[key]: i for i in items}


def score(args: argparse.Namespace) -> int:
    manifest = json.loads((args.inputs / "manifest.json").read_text(encoding="utf-8"))
    run = json.loads(args.rows.read_text(encoding="utf-8"))
    refs = _by_key(manifest["clips"], "sid")
    truths = _by_key(manifest["meetings"], "name")

    failed = [
        f"{key}: {item['error']}"
        for kind, key in (("clips", "sid"), ("meetings", "name"))
        for item in run[kind]
        if item.get("error")
    ]
    if not run.get("complete"):
        failed.append("rows.json is not marked complete (the browser run stopped early)")
    if failed:
        print("REFUSED: part of the browser run failed, so no report is written:", file=sys.stderr)
        print("\n".join(f"  {f}" for f in failed[:20]), file=sys.stderr)
        return 2

    clip_report = None
    if run["clips"]:
        items = [
            ({k: refs[c["sid"]][k] for k in ("sid", "wav", "ja_norm", "en")}, c["rows"])
            for c in run["clips"]
        ]
        clip_report = score_clips(items)
    scored, meeting_report = [], None
    for m in run["meetings"]:
        s = score_meeting(truths[m["name"]]["truth"], m["rows"])
        s["name"] = m["name"]
        scored.append(s)
    if scored:
        meeting_report = aggregate_meetings(scored)
        meeting_report["realtime"] = run["runtime"]["realtime"]

    out = args.rows.parent
    sessions = [*run["clips"], *run["meetings"]]
    meta = {
        "timestamp": out.name,
        "git": git_sha(),
        "asr_model": "haas-ja (browser, onnxruntime-web)",
        "pair": DEFAULT_PAIR.code,
        "glossary": None,
        "clips_requested": len(run["clips"]),
        "seed": manifest["seed"],
        "levels": manifest["levels"],
        "runtime": run["runtime"],
        "unsettled_rows": sum(i.get("unsettled", 0) for i in sessions),
        "pipeline_errors": sum(len(i.get("errors", [])) for i in sessions),
    }
    write_report(out, meta, clip_report, meeting_report, scored)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="command", required=True)

    p = sub.add_parser(
        "prepare", help="write the clips, meetings and references the browser run reads"
    )
    p.add_argument("--clips", type=int, default=100)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--raw-levels", action="store_true", help="as run_eval.py --raw-levels")
    p.add_argument("--meetings-dir", type=Path, default=Path("data/eval/meetings"))
    p.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    p.add_argument("--inputs", type=Path, default=DEFAULT_INPUTS)
    p.set_defaults(run=prepare)

    p = sub.add_parser("score", help="score a browser run into report.json, next to its rows.json")
    p.add_argument("--rows", type=Path, required=True)
    p.add_argument("--inputs", type=Path, default=DEFAULT_INPUTS)
    p.set_defaults(run=score)

    args = ap.parse_args()
    return args.run(args) or 0


if __name__ == "__main__":
    sys.exit(main())
