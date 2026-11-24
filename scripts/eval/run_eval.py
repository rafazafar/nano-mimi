"""Run the real MimiVox pipeline over FLEURS clips and synthetic meetings and score it.

    lockf -k /tmp/claude-501/mimivox-models.lock \
        env PYTHONPATH=src python scripts/eval/run_eval.py [--clips 100] [--glossary g.csv]

Needs scripts/eval/fetch_fleurs.py and scripts/eval/build_meetings.py to have run.
Writes data/eval/reports/<timestamp>/{report.json,report.md,run.log} and prints the table.
Speaker accuracy appears only when the WeSpeaker model is in data/models/wespeaker/.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import datetime
import json
import sys
import tempfile
from pathlib import Path

from common import git_sha, sample_clips, write_report

from mimivox import config, pipeline
from mimivox.config import reset_translation_cache
from mimivox.eval.fleurs import DEFAULT_CACHE
from mimivox.eval.meetings import normalize_rms, read_wav, write_wav
from mimivox.eval.scoring import aggregate_meetings, score_clips, score_meeting
from mimivox.languages import DEFAULT_PAIR, LanguagePair, parse_pair
from mimivox.settings_store import apply_settings_for_session, default_settings


async def run_pipeline(
    wav: Path, *, realtime: bool, log_dir: Path, pair: LanguagePair = DEFAULT_PAIR
) -> list[dict]:
    """One replay-file session through pipeline.run; returns its log rows."""
    reset_translation_cache()  # the same sentence recorded twice must not hit the cache
    pipeline.DATA_DIR = str(log_dir)
    await pipeline.run(str(wav), live=False, asr_only=False, realtime_feed=realtime, pair=pair)
    log = log_dir / "logs" / f"{wav.stem}_v3_log.jsonl"
    rows = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines() if line]
    log.unlink()
    return rows


def rescore(args: argparse.Namespace) -> None:
    old = json.loads(args.rescore.read_text(encoding="utf-8"))
    scored = []
    for m in old["per_meeting"]:
        truth = json.loads(
            (args.meetings_dir / m["name"]).with_suffix(".json").read_text(encoding="utf-8")
        )
        new = score_meeting(truth, m["log_rows"])
        new["name"] = m["name"]
        scored.append(new)
    agg = aggregate_meetings(scored)
    agg["realtime"] = old["meetings"]["realtime"]
    out = args.out / datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True)
    meta = {**old["meta"], "timestamp": out.name, "rescored_from": old["meta"]["timestamp"]}
    write_report(out, meta, old["clips"], agg, scored)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--clips", type=int, default=100, help="clips to sample (0 skips)")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument(
        "--pair",
        default="ja-en",
        help="language pair, e.g. ja-en, zh-en, ko-en, en-ja "
        "(meetings are ja-en only: pass --no-meetings for other pairs)",
    )
    ap.add_argument("--meetings-dir", type=Path, default=Path("data/eval/meetings"))
    ap.add_argument("--no-meetings", action="store_true")
    ap.add_argument(
        "--fast-meetings",
        action="store_true",
        help="feed meetings at max speed instead of 1x (perceived latency then "
        "includes queue backlog and is not comparable)",
    )
    ap.add_argument(
        "--raw-levels",
        action="store_true",
        help="feed clips at FLEURS's original levels (female ja_jp clips are ~-60 "
        "dBFS: tests quiet-speaker handling); meetings use their built levels",
    )
    ap.add_argument("--glossary", default=None, help="glossary file (.csv/.tsv/.json)")
    ap.add_argument(
        "--live-vad",
        action="store_true",
        help="use the live VAD tuning (400 ms silence close), the one the web app runs, "
        "instead of the replay tuning (700 ms)",
    )
    ap.add_argument(
        "--rescore",
        type=Path,
        metavar="REPORT_JSON",
        help="re-score the meetings saved in an earlier report.json with the "
        "current scoring code; loads no models",
    )
    ap.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    ap.add_argument("--out", type=Path, default=Path("data/eval/reports"))
    args = ap.parse_args()

    if args.rescore:
        rescore(args)
        return

    pair = parse_pair(*args.pair.split("-", 1))
    if pair != DEFAULT_PAIR:
        args.no_meetings = True
    settings = default_settings()  # not the user's settings file: runs must be repeatable
    if args.glossary:
        settings["glossary_path"] = args.glossary
    settings.update(source_lang=pair.source, target_lang=pair.target)
    apply_settings_for_session(settings)
    if args.live_vad:
        config.apply_live_vad_overrides()

    out = args.out / datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True)

    def progress(msg: str) -> None:
        print(msg, file=sys.stderr, flush=True)

    clip_report = meeting_report = None
    meetings_scored: list[dict] = []
    with (
        open(out / "run.log", "w", encoding="utf-8") as log_file,
        contextlib.redirect_stdout(log_file),
        tempfile.TemporaryDirectory() as tmp,
    ):
        pipeline.load_all_models()
        tmp_dir = Path(tmp)

        async def go() -> None:
            nonlocal clip_report, meeting_report
            if args.clips:
                items = []
                clips = sample_clips(args.cache, args.clips, args.seed, pair)
                for i, c in enumerate(clips, 1):
                    wav = c.wav
                    if not args.raw_levels:
                        wav = tmp_dir / "clip.wav"
                        write_wav(wav, normalize_rms(read_wav(c.wav)))
                    rows = await run_pipeline(wav, realtime=False, log_dir=tmp_dir, pair=pair)
                    items.append(
                        ({"sid": c.sid, "wav": c.wav.name, "ja_norm": c.ja_norm, "en": c.en}, rows)
                    )
                    progress(f"clip {i}/{len(clips)}")
                clip_report = score_clips(items, fold_case=pair.source == "en")
            if not args.no_meetings:
                for wav in sorted(args.meetings_dir.glob("meeting-*.wav")):
                    truth = json.loads(wav.with_suffix(".json").read_text(encoding="utf-8"))
                    rows = await run_pipeline(wav, realtime=not args.fast_meetings, log_dir=tmp_dir)
                    m = score_meeting(truth, rows)
                    m["name"] = wav.name
                    meetings_scored.append(m)
                    progress(
                        f"meeting {wav.name}: {len(rows)} rows, "
                        f"{m['missed_lines']}/{m['lines']} lines missed"
                    )
                if meetings_scored:
                    meeting_report = aggregate_meetings(meetings_scored)
                    meeting_report["realtime"] = not args.fast_meetings

        asyncio.run(go())

    meta = {
        "timestamp": out.name,
        "git": git_sha(),
        "asr_model": pair.src.asr_model,
        "pair": pair.code,
        "glossary": args.glossary,
        "clips_requested": args.clips,
        "seed": args.seed,
        "vad": "live" if args.live_vad else "replay",
    }
    write_report(out, meta, clip_report, meeting_report, meetings_scored)


if __name__ == "__main__":
    main()
