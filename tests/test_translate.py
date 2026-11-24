import pytest

from mimivox import translate
from mimivox.translate import (
    get_translator,
    reset_translator,
)


# ---------------------------------------------------------------------------
# Existing CAT helper coverage (unchanged behaviour)
# ---------------------------------------------------------------------------
def test_normalize_punctuation_adds_period():
    assert translate.normalize_punctuation("こんにちは") == "こんにちは。"


def test_normalize_punctuation_no_double_period():
    assert translate.normalize_punctuation("こんにちは。") == "こんにちは。"


def test_apply_glossary():
    assert translate.apply_glossary("てっこうです") == "結構です"


def test_is_mostly_english_true():
    assert translate._is_mostly_english("This is English text") is True


def test_is_mostly_english_false():
    assert translate._is_mostly_english("これは日本語です") is False


def test_clean_cat_output_strips_markers():
    raw = "Hello world. Translate the following"
    assert translate.clean_cat_output(raw) == "Hello world"


@pytest.mark.parametrize(
    "suffix",
    [
        "Avoid using overly formal and literal wording.",
        "Avoid using overly formal and literal language.",
        "Avoid overly literal wording.",
        "Avoid overly formal wording.",
    ],
)
def test_clean_cat_output_strips_overly_formal_suffix(suffix):
    raw = f"The police arrived at the scene. {suffix}"
    assert translate.clean_cat_output(raw) == "The police arrived at the scene"


def test_prompt_and_tokens_short():
    content, max_tok = translate._prompt_and_tokens("こんにちは")
    assert max_tok == 16
    assert "Japanese:" in content


def test_prompt_and_tokens_medium():
    # Need >25 chars after strip to leave the short-phrase bucket.
    ja = "これは中くらいの長さの日本語の文章でテスト用ですよ。"
    assert len(ja.strip()) > 25
    assert len(ja.strip()) <= 60
    content, max_tok = translate._prompt_and_tokens(ja)
    assert max_tok == 64
    assert "Translate the following" in content


def test_prompt_and_tokens_long():
    ja = "これはとても長い日本語の文章で、たくさんの文字が含まれています。" * 2
    content, max_tok = translate._prompt_and_tokens(ja)
    assert max_tok == 80
    assert max_tok <= 80


def test_translation_cache_key_strips_spaces():
    a = translate.translation_cache_key("移植です。 天気ですね。")
    b = translate.translation_cache_key("移植です。天気ですね。")
    assert a == b == "移植です。天気ですね。"


# ---------------------------------------------------------------------------
# Factory selection
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def _reset_singleton(monkeypatch):
    """Clear the cached translator between tests so env-var changes take effect."""
    reset_translator()
    yield
    reset_translator()


def test_get_translator_returns_cat():
    t = get_translator()
    assert isinstance(t, translate.CatTranslator)


def test_get_translator_returns_singleton():
    assert get_translator() is get_translator()


def test_official_prompt_matches_cat_translate_format():
    assert translate.official_prompt("Hello", "en-ja") == (
        "Translate the following English text into Japanese.\n\n Hello"
    )
    assert translate.official_prompt("こんにちは", "ja-en") == (
        "Translate the following Japanese text into English.\n\n こんにちは"
    )


@pytest.mark.asyncio
async def test_translate_directed_serializes_on_cat_lock(monkeypatch):
    import asyncio

    lock = asyncio.Lock()
    monkeypatch.setattr(translate._models, "cat_lock", lock)
    seen = {}

    def fake(text, direction):
        seen["locked"] = lock.locked()
        seen["args"] = (text, direction)
        return "ok"

    monkeypatch.setattr(translate, "_do_translate_directed", fake)
    assert await translate.translate_directed("Hi", "en-ja") == "ok"
    assert seen == {"locked": True, "args": ("Hi", "en-ja")}
    assert translate._models.cat_final_waiting == 0


# ---------------------------------------------------------------------------
# Rolling translation context
# ---------------------------------------------------------------------------
def test_chat_messages_include_prior_turns_before_current_line():
    from mimivox import translate as tr

    ctx = [("田中さんから見積もりが届きました。", "A quote arrived from Tanaka")]
    messages, _ = tr._chat_messages("来週までに返事をしないといけないですね。", ctx)

    assert [m["role"] for m in messages] == ["user", "assistant", "user"]
    assert messages[0]["content"] == tr._prompt_and_tokens(ctx[0][0])[0]
    assert messages[1]["content"] == "A quote arrived from Tanaka"
    assert (
        messages[2]["content"]
        == tr._prompt_and_tokens("来週までに返事をしないといけないですね。")[0]
    )
    # Context is never inlined in the current turn (CAT would translate it too).
    assert "田中" not in messages[2]["content"]


def test_chat_messages_without_context_is_single_user_turn():
    from mimivox import translate as tr

    messages, _ = tr._chat_messages("ありがとうございます。", ())
    assert [m["role"] for m in messages] == ["user"]


def test_translation_context_keeps_last_n_and_skips_passthrough():
    from mimivox.config import CONTEXT_TURNS
    from mimivox.translate import TranslationContext

    ctx = TranslationContext()
    for i in range(CONTEXT_TURNS + 2):
        ctx.add(f"テスト{i}番目の文章です。", f"line {i}")
    assert [en for _, en in ctx.pairs()] == [f"line {i}" for i in range(2, CONTEXT_TURNS + 2)]

    before = ctx.pairs()
    ctx.add("日本語の文章です。", "")  # empty EN
    ctx.add("Let's circle back on that.", "Let's circle back on that.")  # English passthrough
    assert ctx.pairs() == before


def _chunk(text, logprob=-0.1):
    import types

    return types.SimpleNamespace(text=text, token=0, logprobs=[logprob])


def _stream_answers(monkeypatch, *texts, retry_logprob=-0.1):
    """stream_generate answers each call with the next text (first run, then retry)."""
    import mlx_lm

    answers = iter(texts)
    logprobs = iter([-0.1] + [retry_logprob] * len(texts))
    monkeypatch.setattr(
        mlx_lm,
        "stream_generate",
        lambda *a, **k: iter([_chunk(next(answers), next(logprobs))]),
    )


def test_do_translate_streaming_sends_context_turns_to_tokenizer(monkeypatch):
    import mlx_lm

    from mimivox import translate as tr

    seen = {}

    class _Tok:
        def apply_chat_template(self, messages, **kw):
            seen["messages"] = messages
            return "PROMPT"

    monkeypatch.setattr(tr._models, "cat_tokenizer", _Tok(), raising=False)
    monkeypatch.setattr(tr._models, "cat_model", object(), raising=False)
    monkeypatch.setattr(
        mlx_lm,
        "stream_generate",
        lambda *a, **k: iter([_chunk("We will talk about it")]),
    )
    en, _, signals = tr._do_translate_streaming(
        "明日話すつもりです。", lambda t: None, None, [("まだです。", "Not yet")]
    )
    assert en == "We will talk about it"
    assert signals.mean_logprob == pytest.approx(-0.1)
    assert [m["role"] for m in seen["messages"]] == ["user", "assistant", "user"]


def test_streaming_retranslates_without_context_when_output_echoes_prior_line(monkeypatch):
    from mimivox import translate as tr

    turn_counts = []

    class _Tok:
        def apply_chat_template(self, messages, **kw):
            turn_counts.append(len(messages))
            return "PROMPT"

    monkeypatch.setattr(tr._models, "cat_tokenizer", _Tok(), raising=False)
    monkeypatch.setattr(tr._models, "cat_model", object(), raising=False)
    _stream_answers(
        monkeypatch,
        "Thank you. I will prepare the document",
        "Thank you. I look forward to working with you",
    )

    en, *_ = tr._do_translate_streaming(
        "ありがとうございます。よろしくお願いします。",
        lambda t: None,
        None,
        [("資料は私が準備します。", "Understood. I will prepare the document")],
    )
    assert en == "Thank you. I look forward to working with you"
    assert turn_counts == [3, 1]  # with context, then retried without


def test_shared_short_phrase_is_not_an_echo():
    from mimivox.translate import _echoes_context

    assert not _echoes_context("We need to reply by next week", [("x", "It is due by next week")])


def test_streaming_retranslates_without_context_when_output_is_only_japanese(monkeypatch):
    from mimivox import translate as tr

    class _Tok:
        def apply_chat_template(self, messages, **kw):
            return "PROMPT"

    monkeypatch.setattr(tr._models, "cat_tokenizer", _Tok(), raising=False)
    monkeypatch.setattr(tr._models, "cat_model", object(), raising=False)
    _stream_answers(
        monkeypatch,
        "よろしくお願いいたします。",
        "We look forward to working with you",
        retry_logprob=-0.2,
    )

    en, _, signals = tr._do_translate_streaming(
        "ありがとうございます、I look forward to working with you。",
        lambda t: None,
        None,
        [("資料は私が準備します。", "I will prepare the document")],
    )
    assert en == "We look forward to working with you"
    assert signals.mean_logprob == pytest.approx(-0.2)  # the retry is scored, not unknown


def test_prepended_prior_sentence_counts_as_echo():
    from mimivox.translate import _echoes_context

    ctx = [
        ("まだです。明日の会議で話すつもりです。", "Not yet. I will talk at the meeting tomorrow")
    ]
    ja = "ミミボックスの導入の件も一緒に相談しましょう。"
    assert _echoes_context("Not yet. Let's discuss the implementation of MimiVox together", ctx, ja)
    assert not _echoes_context("Let's discuss the implementation of MimiVox together", ctx, ja)


def test_repeated_short_sentence_matching_the_source_is_not_an_echo():
    from mimivox.translate import _echoes_context

    ctx = [("ありがとうございます。", "Thank you.")]
    # Two JA sentences, two EN sentences: "Thank you." is a real translation here.
    assert not _echoes_context(
        "Thank you. See you tomorrow.", ctx, "ありがとうございます。また明日。"
    )


def test_short_prior_answer_repeated_for_new_line_is_an_echo():
    from mimivox.translate import _echoes_context

    # Measured live: after ですかね → "Is that it?", CAT gave "Is that it?" for
    # the next three unrelated lines, each one feeding the next as context.
    ctx = [("ですかね。", "Is that it?")]
    assert _echoes_context(
        "Is that it?", ctx, "ここはちょっと、温庫の方で調節していただいてください。"
    )
    assert _echoes_context(
        "Is that it? We would like to recruit here", ctx, "こちらで募集をしてみたいと思います。"
    )
    assert not _echoes_context("Yes.", [("はい。", "Yes.")], "はい。")


def test_fragments_stay_out_of_context():
    from mimivox.translate import TranslationContext

    ctx = TranslationContext()
    ctx.add("ですかね。", "Is that it?")
    ctx.add("オンラインイベントいいと思います。", "I think online events are good")
    assert ctx.pairs() == (
        ("オンラインイベントいいと思います。", "I think online events are good"),
    )


def test_short_answer_for_long_line_is_too_short():
    from mimivox.translate import _too_short

    long_ja = (
        "募集とかもそちらの方でお願いしたいなと思ってますので、私的には本当に開催できれば"
        "本当にありがたいので、どういう形でも人数でも構いませんので、お願いしたいなと思っております。"
    )
    assert _too_short("Is that clear?", long_ja)
    assert not _too_short(
        "We would like you to handle recruitment too. We would be grateful if it can be held, "
        "with any format or number of people.",
        long_ja,
    )
    assert not _too_short("Yes.", "はい。")


# ---------------------------------------------------------------------------
# Words and numbers must survive translation
# ---------------------------------------------------------------------------
_VOCAB = {
    "▁So": 0,
    "▁the": 1,
    "部長": 2,
    "▁department": 3,
    "？": 4,
    "<0xE9>": 5,
    "<0x41>": 6,
    "é": 7,
}


class _PromptTok:
    def __init__(self):
        self.prompts = []

    def apply_chat_template(self, messages, **kw):
        self.prompts.append(messages)
        return "PROMPT"


def test_japanese_token_ids_cover_kana_kanji_cjk_punctuation_and_their_bytes():
    assert translate.japanese_token_ids(_VOCAB) == [2, 4, 5]


def test_cat_cannot_copy_japanese_terms_into_the_english(monkeypatch):
    """CAT left 部長 untranslated and cleanup erased it: "reported to the"."""
    import types

    import mlx.core as mx
    import mlx_lm

    from mimivox import translate as tr

    ids = {i: p for p, i in _VOCAB.items()}

    def fake_stream(model, tok, prompt, max_tokens, logits_processors=None, **kw):
        logits = mx.array([[0.0, 0.0, 9.0, 5.0, 0.0, 0.0, 0.0, 0.0]])  # model prefers 部長
        for proc in logits_processors or ():
            logits = proc(mx.array([]), logits)
        token = int(mx.argmax(logits, axis=-1).item())
        yield types.SimpleNamespace(text=ids[token].replace("▁", " "), token=0, logprobs=[-0.1])

    monkeypatch.setattr(tr._models, "cat_tokenizer", _PromptTok(), raising=False)
    monkeypatch.setattr(tr._models, "cat_model", object(), raising=False)
    monkeypatch.setattr(tr._models, "cat_banned_ids", mx.array(tr.japanese_token_ids(_VOCAB)))
    monkeypatch.setattr(mlx_lm, "stream_generate", fake_stream)

    en, _, signals = tr._do_translate_streaming("部長には報告しましたか。", lambda t: None)
    assert en == "department"
    assert not signals.japanese_stripped


def test_wrong_number_is_retranslated_with_grouped_digits(monkeypatch):
    from mimivox import translate as tr

    tok = _PromptTok()
    monkeypatch.setattr(tr._models, "cat_tokenizer", tok, raising=False)
    monkeypatch.setattr(tr._models, "cat_model", object(), raising=False)
    _stream_answers(monkeypatch, "Japan has about 70,000 islands", "Japan has about 7,000 islands")

    en, _, signals = tr._do_translate_streaming("日本には約7000の島々があります。", lambda t: None)
    assert en == "Japan has about 7,000 islands"
    assert "約7,000の島々" in tok.prompts[-1][-1]["content"]
    assert not signals.numbers_mismatch


def test_number_still_wrong_after_retry_is_flagged_low(monkeypatch):
    from mimivox import translate as tr
    from mimivox.confidence import assess

    monkeypatch.setattr(tr._models, "cat_tokenizer", _PromptTok(), raising=False)
    monkeypatch.setattr(tr._models, "cat_model", object(), raising=False)
    _stream_answers(monkeypatch, "Japan has about 70,000 islands", "Japan has 70,000 islands")

    en, _, signals = tr._do_translate_streaming("日本には約7000の島々があります。", lambda t: None)
    assert en == "Japan has about 70,000 islands"  # the retry was no better: keep the first
    assert signals.numbers_mismatch
    confidence = assess(None, signals, en)
    assert confidence.level == "low"
    assert "Numbers may not match the Japanese" in confidence.reasons


def test_correct_numbers_cost_no_retry(monkeypatch):
    from mimivox import translate as tr

    tok = _PromptTok()
    monkeypatch.setattr(tr._models, "cat_tokenizer", tok, raising=False)
    monkeypatch.setattr(tr._models, "cat_model", object(), raising=False)
    _stream_answers(monkeypatch, "The price is 20 percent higher than last month")

    en, *_ = tr._do_translate_streaming("先月より二割高いですね。", lambda t: None)
    assert en == "The price is 20 percent higher than last month"
    assert len(tok.prompts) == 1


def test_label_prefixed_answer_with_context_is_retried_without_context(monkeypatch):
    """A fragment as the prior turn made CAT answer 'Translation: ...'."""
    from mimivox import translate as tr

    tok = _PromptTok()
    monkeypatch.setattr(tr._models, "cat_tokenizer", tok, raising=False)
    monkeypatch.setattr(tr._models, "cat_model", object(), raising=False)
    _stream_answers(
        monkeypatch,
        "Translation: From the palace, we were forced to return to Paris",
        "They were forced to return from the palace to Paris",
    )

    en, *_ = tr._do_translate_streaming(
        "宮殿からパリへと強制的に戻されました。",
        lambda t: None,
        None,
        [("市場の女性たちによって、", "by the women of the market")],
    )
    assert en == "They were forced to return from the palace to Paris"
    assert [len(p) for p in tok.prompts] == [3, 1]


def test_long_line_gets_room_to_finish():
    """80 tokens cut a 125-character FLEURS sentence off at '... to Paris by the'."""
    ja = (
        "1789年10月6日、恐怖におびえた国王ルイ16世、王妃マリー・アントワネットと2人の幼い子供たち"
        * 2
    )
    _, max_tok = translate._prompt_and_tokens(ja)
    assert max_tok > len(ja)
