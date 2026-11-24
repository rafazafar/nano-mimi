"""Input corpus for scripts/export_web_fixtures.py.

Inputs only; the exporter calls the real Python functions to produce outputs.
Seeded from tests/test_translate.py, test_glossary.py, test_revision.py,
test_number_check.py, test_asr.py and test_vad.py, plus edge cases.
"""

from __future__ import annotations

NORMALIZE_PUNCTUATION = [
    "こんにちは",
    "こんにちは。",
    "  こんにちは  ",
    "本当ですか？",
    "Really?",
    "Done.",
    "Wow!",
    "すごい！",
    "",
    "   ",
    "　はい　",
    "それは、",
    "終わりです.",
    "a",
    "「はい」",
    "はい\n",
]

IS_NON_CONTENT_ASR = [
    "",
    "   ",
    "。",
    "、",
    "...！！",
    "「」",
    "はい。",
    "Eのフロント",
    "　。　",
    "…‥",
    "- — –",
    "~～",
    "\"'",
    "(  )",
    "【】",
    "a",
    "1",
    "。。。。。",
    "ー",
    "、はい",
]

DEDUPLICATE_PHRASES = [
    "これは普通の文章です。",
    "テスト " * 10,
    "アクセプトスクリテリアを" * 17,
    "移植、 master config, " * 25,
    "はいはいはいはいはいはい",
    "はいはいはい",
    "あ" * 40,
    "",
    "短い。",
    "ええと、 " * 6 + "終わりです。",
    "A B C D E F G H I J",
    "ありがとう ありがとう ありがとう ありがとう ありがとう ありがとう ありがとう ありがとう ありがとう",
    "今日、明日、今日、明日、今日、明日、今日、明日、今日、明日",
    "これ。これ。これ。これ。これ。これ。これ。これ。これ。これ。これ。これ。これ。これ。これ。",
    "そうですね、そうですね。次の議題です。",
    "x y x y x y x y x y x y x y x y z",
    "同じ 同じ 同じ 同じ 違う 同じ 同じ 同じ 同じ 同じ",
]

IS_MOSTLY_ENGLISH = [
    "This is English text",
    "これは日本語です",
    "",
    "   ",
    "123",
    "OK",
    "Let's circle back on that.",
    "はい、OK",
    "ミーティング",
    "Thanks, ありがとう",
    "Let's meet at 3pm と言いました",
    "ｱｲｳ test",
    "Hello! こんにちは world and more english text here",
    "。。。",
    "日本語 English English English English English English English English English",
]

# (source, target) pairs in glossary order; Python builds dict(pairs).
GLOSSARY_BASE = [("てっこうです", "結構です"), ("てっこう", "結構")]
GLOSSARY_ACME = [
    ("部長", "department head"),
    ("ミミボックス", "MimiVox"),
    ("よろしくお願いします", "I look forward to working with you"),
    ("てっこうだ", "結構だ"),
]
APPLY_GLOSSARY = [
    {"text": "てっこうです", "glossary": GLOSSARY_BASE},
    {"text": "てっこうですね、てっこう", "glossary": GLOSSARY_BASE},
    {"text": "部長によろしくお願いします", "glossary": GLOSSARY_ACME},
    {"text": "お願いします", "glossary": [("お願いします", "please")]},
    {
        "text": "よろしくお願いします",
        "glossary": [("お願いします", "please"), ("よろしくお願いします", "regards")],
    },
    {
        "text": "よろしくお願いします",
        "glossary": [("よろしくお願いします", "regards"), ("お願いします", "please")],
    },
    {"text": "AとBとAB", "glossary": [("A", "x"), ("B", "y")]},
    {"text": "AとBとAB", "glossary": [("B", "y"), ("A", "x")]},
    {"text": "AB", "glossary": [("A", "B"), ("B", "A")]},
    {"text": "AB", "glossary": [("B", "A"), ("A", "B")]},
    {"text": "ミミボックスのミミボックス", "glossary": GLOSSARY_ACME},
    {"text": "何もありません", "glossary": GLOSSARY_ACME},
    {"text": "", "glossary": GLOSSARY_ACME},
    {"text": "部長", "glossary": []},
    {"text": "部長です", "glossary": [("部長", "")]},
    {"text": "a.b", "glossary": [(".", "!"), ("a.b", "ab")]},
    {"text": "ABC", "glossary": [("ab", "x"), ("AB", "y")]},
    {"text": "見積もり、見積", "glossary": [("見積", "quote"), ("見積もり", "estimate")]},
]

ENDS_MID_SENTENCE = [
    "部長には報告しましたが、",
    "部長には報告しましたが",
    "報告しましたが。",
    "待って。",
    "忙しいから。",
    "はい",
    "えーと",
    "本当ですか？",
    "それで、部長には報告しましたか。",
    "",
    "   ",
    "「報告しましたが、」",
    "報告しましたが」",
    "ありがとう、",
    "ありがとう，",
    "ありがとう,",
    "そうなんですけれども。",
    "そうなんですけれど。",
    "そうなんですけど。",
    "そうなのでので。",
    "あああああ",
    "ああああ",
    "終わりました！",
    "これは何?",
    "ええ。",
    "行きますので。",
    "行きますが）",
]

IS_SPLIT_CONTINUATION = [
    ("部長には報告しましたが、", "まだ返事がありません。", 0.8),
    ("部長には報告しましたが", "まだ返事がありません。", 0.8),
    ("報告しましたが。", "まだ返事がありません。", 0.8),
    ("部長には報告しましたが、", "まだ返事がありません。", 1.6),
    ("部長には報告しましたが、", "まだ返事がありません。", 1.5),
    ("部長には報告しましたが、", "まだ返事がありません。", 1.5001),
    ("先月より二割高いですね。", "来週までに返事をしないといけないですね。", 0.5),
    ("それで、部長には報告しましたか。", "まだです。", 0.5),
    ("本当ですか？", "はい", 0.3),
    ("待って。", "これを見てください。", 0.5),
    ("忙しいから。", "また今度。", 0.5),
    ("はい", "わかりました。", 0.5),
    ("", "まだです。", 0.5),
    ("部長には報告しましたが、", "", 0.5),
    ("  ", "まだです。", 0.5),
    ("あ" * 70 + "、", "い" * 60 + "。", 0.5),
    ("あ" * 60 + "、", "い" * 60 + "。", 0.5),
    ("あ" * 60 + "、", "い" * 61 + "。", 0.5),
    ("部長には報告しましたが、", "まだ返事がありません。", 0.0),
    ("部長には報告しましたが、", "まだ返事がありません。", -0.2),
    (" 部長には報告しましたが、 ", " まだ返事がありません。 ", 0.4),
]

UNSUPPORTED_NUMBERS = [
    ("日本には約7000の島々があります。", "Japan has about 7,000 islands"),
    ("日本には約七千の島々があります。", "Japan has about 7,000 islands"),
    ("先月より二割高いですね。", "The price is 20 percent higher than last month"),
    ("世界で7番目に大きい島です。", "It is the 7th largest island in the world"),
    ("人口は1万2000人です。", "The population is 12,000"),
    ("予算は700万円です。", "The budget is 7 million yen"),
    ("1789年10月6日のことです。", "It happened on October 6, 1789"),
    ("円周率は３．１４です。", "Pi is 3.14"),
    ("明日話すつもりです。", "I will talk about it tomorrow"),
    (
        "日本には約7000の島々があり、世界で7番目に大きい島です。",
        "Japan has about 70,000 islands, the seventh largest in the world",
    ),
    (
        "17、89年10月6日、国王ルイ16世は戻されました。",
        "Year 1989 – On October 6, 1863, King Louis 16 was returned",
    ),
    ("三百五十円です。", "It costs 350 yen"),
    ("三百五十円です。", "It costs 530 yen"),
    ("二〇二四年です。", "It is 2024"),
    ("二〇二四年です。", "It is 2042"),
    ("1億2千万人です。", "120 million people"),
    ("1億2千万人です。", "12 million people"),
    ("三兆円です。", "3 trillion yen"),
    ("三兆円です。", "3 billion yen"),
    ("", "There are 5 apples"),
    ("りんごが五個です。", ""),
    ("3.5%です。", "It is 3.5 percent"),
    ("八割です。", "80 percent, 8 tenths, 800"),
    ("1,000円です。", "1000 yen"),
    ("1,000円です。", "It is 1,000 yen or 1.5 thousand"),
    ("百万です。", "1 million, 2 million"),
    ("ABC123です。", "ABC123 is the code"),
    ("2.5です。", "v2.5 and 2.5"),
    ("十五分です。", "15 minutes and 15 hundred"),
]

GROUP_DIGITS = [
    "約7000の島々、12345人、1789年、2024年度、3.1415",
    "7000",
    "999",
    "1000",
    "1,000と10000",
    "1789年",
    "12345年",
    "12345 年",
    "1.2345",
    "0.12345",
    "1234.5",
    "1234567",
    "電話は0312345678です。",
    "",
    "数字なし",
    "7000と8000と9000",
    "２０２４年",
    "10000円、100000円、1000000円",
    ".1000",
    "1000.",
]

CLEAN_CAT = [
    "Hello world. Translate the following",
    "Hello world",
    "  Hello  \n  world  ",
    "Line one\nLine two\n\nLine three",
    "Okay. English:",
    "It is fine English:",
    "Okay",
    "Please translate this. It is done.",
    "Translate the following Japanese text",
    "Yes. Translate to English",
    "Good morning.",
    "Good morning...",
    "reported to the部長？",
    "よろしくお願いいたします。",
    "Thank you、 very much。",
    "I will go・home…",
    "Hello. Japanese: こんにちは",
    "PLEASE TRANSLATE: hello",
    "Sure. I can help you with that",
    "Yes! That was incorrect. Moving on",
    "",
    "   ",
    "Hi!",
    "Hi! Then some more text that is long enough to pass",
    "Yes. " + "x" * 130,
    "A. Translate the following",
    "What? Your message has been received",
    "Right.\nEnglish:",
    "Meeting at ccenture today",
    "Ok. Here is the instruction: do it",
    "ｱｲｳ kana",
    "mixed English and 日本語 together",
    "Go. in Japanese it means go",
    "End.   ",
    "Trailing English:   ",
]

# (en, context pairs, ja_text)
ECHOES_CONTEXT = [
    ("We need to reply by next week", [("x", "It is due by next week")], ""),
    (
        "Not yet. Let's discuss the implementation of MimiVox together",
        [
            (
                "まだです。明日の会議で話すつもりです。",
                "Not yet. I will talk at the meeting tomorrow",
            )
        ],
        "ミミボックスの導入の件も一緒に相談しましょう。",
    ),
    (
        "Let's discuss the implementation of MimiVox together",
        [
            (
                "まだです。明日の会議で話すつもりです。",
                "Not yet. I will talk at the meeting tomorrow",
            )
        ],
        "ミミボックスの導入の件も一緒に相談しましょう。",
    ),
    (
        "Thank you. See you tomorrow.",
        [("ありがとうございます。", "Thank you.")],
        "ありがとうございます。また明日。",
    ),
    (
        "Is that it?",
        [("ですかね。", "Is that it?")],
        "ここはちょっと、温庫の方で調節していただいてください。",
    ),
    (
        "Is that it? We would like to recruit here",
        [("ですかね。", "Is that it?")],
        "こちらで募集をしてみたいと思います。",
    ),
    ("Yes.", [("はい。", "Yes.")], "はい。"),
    ("Yes.", [("はい。", "Yes.")], "いいえ。"),
    (
        "I will prepare the document",
        [("資料は私が準備します。", "I will prepare the document")],
        "",
    ),
    ("", [("a", "b")], "c"),
    ("Hello there", [], "こんにちは"),
    ("Hello there friend", [("a", "Hello there friend of mine")], "x"),
    ("hello there friend", [("a", "HELLO THERE FRIEND")], "x"),
    ("Hello, there! Friend?", [("a", "hello there friend")], "x"),
    (
        "One. Two. Three.",
        [("あ。", "Two."), ("い。", "Nine.")],
        "う。",
    ),
    (
        "One. Two. Three.",
        [("あ。", "Two."), ("い。", "Nine.")],
        "あ。う。",
    ),
    ("A b c d.", [("x", "a b c d e")], ""),
    ("A b c.", [("x", "a b c d e")], ""),
    ("It's fine today ok", [("x", "it's fine today")], ""),
    ("Okay.", [("はい。", "Okay."), ("そう。", "Right.")], "どうも。"),
]

# (en, ja)
TOO_SHORT = [
    (
        "Is that clear?",
        "募集とかもそちらの方でお願いしたいなと思ってますので、私的には本当に開催できれば"
        "本当にありがたいので、どういう形でも人数でも構いませんので、お願いしたいなと思っております。",
    ),
    (
        "We would like you to handle recruitment too. We would be grateful if it can be held, "
        "with any format or number of people.",
        "募集とかもそちらの方でお願いしたいなと思ってますので、私的には本当に開催できれば"
        "本当にありがたいので、どういう形でも人数でも構いませんので、お願いしたいなと思っております。",
    ),
    ("Yes.", "はい。"),
    ("", ""),
    ("", "はい"),
    ("Yes", ""),
    ("One", "あいうえおか"),
    ("One", "あいうえおかき"),
    ("One two", "あ" * 12),
    ("One two", "あ" * 13),
    ("It's fine", "あ、い。う！え？お!か?き.く,「け」…こー"),
    ("日本語 only", "はい。"),
    ("a1 b2 c3", "あ" * 18),
    ("a1 b2 c3", "あ" * 19),
]

PROMPT_AND_TOKENS = [
    "こんにちは",
    "  こんにちは  ",
    "あ" * 5,
    "あ" * 6,
    "あ" * 25,
    "あ" * 26,
    "あ" * 60,
    "あ" * 61,
    "これは中くらいの長さの日本語の文章でテスト用ですよ。",
    "これはとても長い日本語の文章で、たくさんの文字が含まれています。" * 2,
    "あ" * 64,
    "あ" * 65,
    "あ" * 120,
    "あ" * 125,
    "あ" * 200,
    "",
    "   ",
    "　はい　",
    "{ja} {braces}",
    "a\nb",
    "  " + "あ" * 5 + "  ",
    "  " + "あ" * 62 + "  ",
]

# Prior (JA, EN) lines used to render the context-turn layout.
CONTEXT_PAIRS = [
    ("田中さんから見積もりが届きました。", "A quote arrived from Tanaka"),
    ("先月より二割高いですね。", "It is 20 percent higher than last month"),
    ("来週までに返事をしないといけないですね。", "We have to reply by next week"),
]
CHAT_MESSAGES = [
    {"ja": "来週までに返事をしないといけないですね。", "context": CONTEXT_PAIRS[:1]},
    {"ja": "ありがとうございます。", "context": []},
    {"ja": "部長には報告しましたが、まだ返事がありません。", "context": CONTEXT_PAIRS},
    {"ja": "あ" * 70, "context": CONTEXT_PAIRS[:2]},
    {"ja": "はい", "context": [("あ" * 30, "x"), ("あ" * 4, "y")]},
]

# Sequences of TranslationContext.add(ja, en); CONTEXT_TURNS is 3.
CONTEXT_ADDS = [
    [(f"テスト{i}番目の文章です。", f"line {i}") for i in range(5)],
    [
        ("テスト0番目の文章です。", "line 0"),
        ("日本語の文章です。", ""),
        ("Let's circle back on that.", "Let's circle back on that."),
        ("ですかね。", "Is that it?"),
        ("オンラインイベントいいと思います。", "I think online events are good"),
    ],
    [
        ("ですかね。", "Is that it?"),
        ("オンラインイベントいいと思います。", "I think online events are good"),
    ],
    [("あいうえお。", "short"), ("あいうえおか。", "six chars")],
    [("あいうえお、。", "punct only counted out"), ("あいうえおか！？", "six")],
    [("これは日本語です。", "  padded  "), ("これは日本語です。", "   ")],
    [],
    [
        ("This is English text", "This is English text"),
        ("ミーティング開始です。", "The meeting starts"),
    ],
]

CACHE_KEY = [
    "移植です。 天気ですね。",
    "移植です。天気ですね。",
    "",
    "   ",
    " a b\tc\nd ",
    "全角　スペース　",
    "　　",
    "no_spaces",
    "a b",
    "a b",
    "line\r\nbreak",
    "a\x1cb\x85c",
    "a﻿b",
    "a​b",
    "a b c",
    "はい。",
    " はい。 ",
]

# Input to translation_cache_key(apply_glossary(normalize_punctuation(ja))), as the pipeline does.
PIPELINE_CACHE_KEY = [
    {"ja": "てっこうです", "glossary": GLOSSARY_BASE},
    {"ja": "部長に よろしくお願いします", "glossary": GLOSSARY_ACME},
    {"ja": "はい", "glossary": []},
    {"ja": "はい。", "glossary": []},
    {"ja": " ありがとう ", "glossary": []},
    {"ja": "", "glossary": []},
    {"ja": "本当ですか？", "glossary": GLOSSARY_ACME},
]

# Tiny vocabularies for japanese_token_ids (tests/test_translate.py plus edges).
JAPANESE_TOKEN_VOCABS = [
    {"▁So": 0, "▁the": 1, "部長": 2, "▁department": 3, "？": 4, "<0xE9>": 5, "<0x41>": 6, "é": 7},
    {
        "あ": 0,
        "ア": 1,
        "ｱ": 2,
        "a": 3,
        "<0xE3>": 4,
        "<0xEF>": 5,
        "<0xE2>": 6,
        "<0xE9>": 7,
        "<0xEA>": 8,
    },
    {
        "　": 10,
        "〜": 11,
        "ー": 12,
        "・": 13,
        "…": 14,
        "。": 15,
        ".": 16,
        "ａ": 17,
        "㐀": 18,
        "鿿": 19,
    },
    {"x<0xE3>": 3, "<0xe3>": 4, "<0xE3>x": 5, "▁": 6, "": 7, "ab部": 8},
    {},
]
