"""Write the MT bench input: the 100 FLEURS dev sentences in mt.ids.txt (JA source, EN reference).

    uv run python web/bench/mt.prep.py <out.json>

Same sample as spike S0a (docs/plans/s0/s0a-mt.md): the JA side is the reference
transcript, so ASR plays no part.
"""

import json
import sys
from pathlib import Path

from mimivox.eval.fleurs import load_clips

ids = (Path(__file__).parent / "mt.ids.txt").read_text().split()
clips = {}
for clip in load_clips():
    clips.setdefault(clip.sid, clip)
items = [{"id": i, "ja": clips[i].ja_raw.strip(), "ref": clips[i].en} for i in ids]
Path(sys.argv[1]).write_text(json.dumps({"items": items}, ensure_ascii=False))
print(f"{len(items)} items -> {sys.argv[1]}")
