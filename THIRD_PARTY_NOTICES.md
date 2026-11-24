# Third-party notices

## WeSpeaker ResNet34-LM speaker embedding model

MimiVox's optional speaker labels use the WeSpeaker ResNet34-LM model
(`voxceleb_resnet34_LM.onnx`), downloaded unmodified on demand from
https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM
(pinned revision `f0c48c298fd835726c27956a5d617bad7115627e`).

- Toolkit: [WeSpeaker](https://github.com/wenet-e2e/wespeaker), Apache-2.0.
- Model weights: trained on VoxCeleb; licensed
  [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) by the WeSpeaker
  authors. MimiVox has not modified the model. It is not a MimiVox work.
- Runs fully on-device with ONNX Runtime (MIT).

## Haas-ja v1.0 speech recognition model

Speech recognition for Japanese-source sessions runs Haas-ja v1.0, downloaded
unmodified on demand from
https://huggingface.co/basyauma-tech/Haas-ja-v1.0-mlx-8bit.

- Model weights: Haas-ja-v1.0, Third Intelligence, Inc., Apache-2.0.
- 8-bit MLX conversion: Basyauma Technologies LLC, Apache-2.0.
- Inference code: [haas-ja-local](https://github.com/basyauma-tech/haas-ja-local)
  (pinned commit `c56919f0da98ee0044ba64279d54b495f8bc5eaa`), Apache-2.0,
  installed as a Python dependency.
- Runs fully on-device with MLX. It is not a MimiVox work.

## Parakeet TDT 0.6B v2 speech recognition model

The browser app's English speech recognition (the `en-ja` pair) runs Parakeet TDT
0.6B v2, downloaded unmodified on demand from
https://huggingface.co/ysdede/parakeet-tdt-0.6b-v2-onnx
(pinned revision `db4a768f5795e0f508187a34241fbeeef6ebb0d3`).

- Model weights: [parakeet-tdt-0.6b-v2](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2),
  NVIDIA, licensed [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/).
- ONNX export: ysdede. MimiVox has not modified it.
- Runs fully on-device in the browser. It is not a MimiVox work.

## Silero VAD model

Speech detection runs the Silero VAD model (`src/mimivox/silero/silero_vad.onnx`),
copied unmodified from the [silero-vad](https://github.com/snakers4/silero-vad)
6.2.1 package. Copyright (c) 2020-present Silero Team, MIT license; the full
text ships beside the model in `src/mimivox/silero/LICENSE`. Runs on-device with
ONNX Runtime (MIT).

## Google FLEURS (evaluation data only)

The eval harness in `scripts/eval/` measures MimiVox on the dev split of
[FLEURS](https://huggingface.co/datasets/google/fleurs) (Conneau et al., 2022),
licensed [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) by Google.
The audio and transcripts are downloaded on demand into a local cache, are not
redistributed with MimiVox, and are not used for training.

## Learning mode: SudachiPy, SudachiDict-small and JMdict

Learning mode (furigana, word glosses, vocabulary export) runs fully on-device.

- **SudachiPy** and **SudachiDict-small** (Works Applications), Apache-2.0,
  split Japanese text into words and give their readings. They are installed as
  ordinary Python dependencies (`sudachipy`, `sudachidict_small`).
- **JMdict** word glosses come from `src/mimivox/lexicon/jmdict_common.tsv.gz`, a
  subset of the English JMdict file (`JMdict_e.gz`) from the
  [Electronic Dictionary Research and Development Group](https://www.edrdg.org/),
  (c) EDRDG, licensed
  [CC-BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The subset keeps
  entries tagged common (news, ichi, spec, gai, nf), at most two senses each, and
  is rebuilt by `scripts/build_jmdict_subset.py`. It is a derivative of JMdict, so
  this file stays under CC-BY-SA 4.0 (share-alike); the rest of MimiVox is not
  affected. Vocabulary exports contain these glosses and carry the same terms.
