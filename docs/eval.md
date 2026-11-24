# Eval harness

Measures the real pipeline on public human speech (Google FLEURS ja_jp dev,
CC-BY-4.0) so a feature can be judged by numbers. Rerun it before and after a
change and compare the two `report.json` files.

`make eval` runs all three steps below with the defaults.

```bash
PY="uv run python"
$PY scripts/eval/fetch_fleurs.py                  # once; --langs ja_jp zh_cn ko_kr for more
$PY scripts/eval/build_meetings.py -n 5           # data/eval/meetings/meeting-N.{wav,json}
$PY scripts/eval/run_eval.py --clips 100          # loads Whisper + CAT (~20 min)
```

Audio is cached in `~/Library/Caches/mimivox/eval/fleurs/` (download is
SHA-256 checked, a second fetch downloads nothing). Meetings and reports live
under `data/eval/` (git-ignored).

## What it does

- **Clips**: samples N clips (one recording per sentence id, `--seed`), runs each
  as its own replay-file session through `pipeline.run`, and scores the
  concatenated caption rows.
- **Meetings**: concatenates clips with 0.6-1.5 s gaps, alternating a male (A)
  and a female (B) clip, so turns are known. The sidecar JSON has the same
  shape as `make_meeting_fixture.py` (`lines[]` of speaker, ja, start_s,
  end_s) plus the English reference. Meetings are fed at 1x real time so
  perceived latency is honest (`--fast-meetings` skips pacing; perceived then
  includes queue backlog).
- The translation cache is reset before each session, and `default_settings()`
  is used instead of your settings file, so runs are repeatable.

## Metrics

| metric | definition |
|---|---|
| CER | Corpus edit distance over reference characters. Both sides are NFKC-normalized and stripped of punctuation, symbols and whitespace, so punctuation is never counted. Reference is FLEURS's normalized JA transcript. |
| chrF | sacrebleu corpus chrF (0-100) of the EN captions against the FLEURS en_us text for the same sentence id. |
| latency | p50/p95 over caption rows of ASR, CAT, and perceived (VAD wait + queue wait + ASR + CAT). |
| speaker acc | Fraction of meeting lines labelled correctly under the best mapping of true speakers to predicted labels. Only when `data/models/wespeaker/voxceleb_resnet34_LM.onnx` exists. |
| revisions | Fragments merged back into an earlier caption. |
| missed lines | Meeting lines with no caption row overlapping them in time. |

Meeting alignment assigns each caption row to the ground-truth line it overlaps
most in time (row start is the pipeline's `timeline_s`, end is start +
`duration_s`). A line's hypothesis is its assigned rows joined in order; a
missed line scores as an empty hypothesis. Rows overlapping no line are counted
as `unaligned_rows` in `report.json`.

## Flags

`--clips N` (0 skips), `--seed`, `--no-meetings`, `--fast-meetings`,
`--glossary file.csv` (same loader as the CLI), `--meetings-dir`, `--out`,
`--raw-levels` (feed clips at FLEURS's own levels, about -60 dBFS for the
female ja_jp clips, to test quiet speakers).

## Browser eval

`make web-eval` runs the web app on the same clips and meetings and prints its
report next to the macOS baseline (`data/eval/baseline-macos/report.json`, a copy
of a `make eval` report directory). It needs headed Chrome with WebGPU and the
models in `web/.models`, and takes about 35 minutes because every input plays at 1x.

```bash
$PY scripts/eval/web_eval.py prepare --clips 100            # data/eval/web-inputs/ (self-contained)
(cd web && node eval/run.ts --inputs ../data/eval/web-inputs --out ../data/eval/web-reports/<run>/rows.json)
$PY scripts/eval/web_eval.py score --rows data/eval/web-reports/<run>/rows.json
$PY scripts/eval/compare_reports.py data/eval/baseline-macos/report.json data/eval/web-reports/<run>/report.json
```

`web/eval/run.ts` mounts the real app and logs its pipeline events. Meetings go through
Chrome's fake microphone (`--use-file-for-fake-audio-capture`), one Chrome launch each.
Clips go through the app's WAV-file source in one warm page, one fresh session per clip
(`--clips-via mic` uses the fake microphone for them too). `web_eval.py score` hands the
logged rows to the scoring functions `run_eval.py` uses, so CER, chrF, alignment and
latency percentiles are computed by the same code. Neither Python step imports MLX, so
`prepare` and `score` run on a machine that only runs the browser.

`compare_reports.py` judges each of `clips` and `meetings` against these bars and exits 0
(all hold), 1 (a bar failed) or 2 (refused: a metric is missing or not a number in either
report, so nothing is judged):

| metric | bar |
|---|---|
| CER | at most 1.0 percentage point above the baseline |
| chrF | at most 1.5 below the baseline |
| perceived p50 / p95 | at most 1.5x / 2x the baseline |
| missed lines (meetings) | no more than the baseline |

The web app has only the live VAD tuning (400 ms silence close), while `make eval` uses
the replay tuning (700 ms). `run_eval.py --live-vad` produces the like-for-like baseline;
point `make web-eval BASELINE=<dir>` at a copy of its report directory to judge against it.
The replay baseline waits longer before closing a row, so its perceived latency is higher
and a web run looks better against it than it does against the like-for-like baseline.

## Caveats

- FLEURS has no speaker id. "Speaker A/B" is the gender role, so two male clips
  can be different people. Speaker accuracy is a lower bound on diarization
  quality in that case.
- Whisper may write numerals as digits where FLEURS normalizes differently
  (and the reverse), which inflates CER a little.
- FLEURS sentences are read text, not conversation: expect better ASR than a
  real meeting, and no overlapping speech.
