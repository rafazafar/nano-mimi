# Language pairs

A session has one `LanguagePair` (`src/mimivox/languages.py`): `source_lang` is what the recognizer
hears, and `target_lang` is the caption language. Settings store both codes.
`/api/session/start` accepts both fields to override the saved pair for a session.

Supported: `ja-en` (default), `zh-en`, `ko-en`, `en-ja`. Anything else is a 400.

| Stage | ja-en | other pairs |
|---|---|---|
| Speech recognition | Haas-ja v1.0 (no language or prompt input) | Whisper, `language=<source>`, per-language prompt base |
| Translator | CAT-Translate (unchanged) | Qwen3-4B-Instruct (the meeting-notes model, `notes_llm`) |
| Glossary terms | yes, substituted before translation only (no Whisper prompt bias under Haas) | yes (term sources bias Whisper, targets are substituted before translation) |
| Glossary ASR fixes | yes | no effect (their Japanese sources never match other text) |
| Context translation | yes | yes (last 3 lines as chat turns, echo guard retries without context) |
| Confidence flags | yes | yes (Qwen token logprobs; thresholds are CAT-tuned, not re-tuned) |
| Split-sentence revision | yes | off (the heuristics read Japanese endings) |
| Partial-EN preview | optional | off |
| English passthrough | yes | n/a |

The non-JA translator needs the optional model download (Settings → Models). Starting such a
pair without it fails fast with a message instead of letting mlx_lm download it silently.
The model stays resident while a session uses it (`notes_llm.pin`), so the notes idle timer
cannot evict it mid-meeting.

## Web app (`web/`)

The browser app supports `ja-en` and `en-ja`, with CAT-Translate for both. One table,
`web/src/core/strategy.ts`, holds the per-pair differences.

| Stage | ja-en | en-ja |
|---|---|---|
| Speech recognition | Haas-ja v1.0 | Parakeet TDT 0.6B v2 |
| CAT prompt | the length-tiered Japanese prompts | CAT's official `Translate the following English text into Japanese.` |
| Token cap | by Japanese length | `clamp(ceil(chars * 0.5) + 24, 32, 192)` |
| Japanese-token ban | yes | no |
| Output cleaning | prompt leaks, first sentence, Japanese stripped | prompt leaks and a leading label; Japanese kept |
| Context turns and retry without context | context; retry on empty, echo, too short, labelled | no context turns, so no retry (with context CAT 1.4B often answered in English) |
| Number check and grouped-digits retry | yes | off |
| Glossary | Japanese substitution, ASR fixes and terms | English term to Japanese term, whole word, ignoring case; Japanese-source entries skipped |
| Punctuation | appends `。` | appends `.` |
| Split-sentence revision, partial-EN preview | yes | off |
| English passthrough | yes | n/a |

Wire format: events and log rows keep their `ja` / `en` keys. For a pair `ja` holds the source
text and `en` the translation, and `session_start` carries `source_lang` / `target_lang`.

Eval: `scripts/eval/fetch_fleurs.py --langs cmn_hans_cn ko_kr --limit 30` and
`--langs ja_jp en_us --audio-langs en_us --limit 30`, then
`run_eval.py --pair zh-en|ko-en|en-ja --clips 30`. See `docs/eval.md`.
