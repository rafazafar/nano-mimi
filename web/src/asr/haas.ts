import type * as Ort from "onnxruntime-web";
import { deduplicatePhrases, isNonContentAsr } from "../core/text";
import { asJaText, type JaText } from "../core/types";
import type { HaasConfig } from "./config";
import { MelFrontEnd } from "./mel";
import { greedyTdt, type Joint } from "./tdt";
import { PieceDecoder } from "./tokenizer";
import { trimTrailingSilence } from "./trim";

export type OrtModule = Pick<typeof Ort, "InferenceSession" | "Tensor">;

export interface OrtSession {
  readonly ort: OrtModule;
  readonly session: Ort.InferenceSession;
}

/** The checkpoint's non-ONNX parts the JS front end and detokenizer read. */
export interface HaasTables {
  readonly config: HaasConfig;
  readonly window: Float32Array;
  readonly fb: Float32Array;
  readonly pieces: readonly string[];
}

export interface AsrTiming {
  readonly melMs: number;
  readonly encMs: number;
  readonly decMs: number;
  /** Joint evaluations. */
  readonly steps: number;
}

export interface Transcript {
  /** Empty when the decode was punctuation-only; repeated-phrase loops collapsed. */
  readonly text: JaText;
  /** The detokenized decoder output before the non-content filter and dedup. */
  readonly raw: string;
  readonly ids: readonly number[];
  readonly timing: AsrTiming;
}

/** Encoder output as `[frames, dModel]` row-major. */
export interface EncodedFrames {
  readonly data: Float32Array;
  readonly frames: number;
}

/** The transducer decoder, cut by scripts/build_web_asr_models.py into its two halves. Both from one ORT build. */
export interface DecoderSessions {
  readonly ort: OrtModule;
  /** (targets, target_length, input_states_1/2) to (pred, output_states_1/2). */
  readonly predictor: Ort.InferenceSession;
  /** (encoder_outputs, pred) to logits. */
  readonly joint: Ort.InferenceSession;
}

type States = readonly [Ort.Tensor, Ort.Tensor];

/**
 * The prediction network + joint over one clip's encoder frames. Greedy TDT re-feeds the
 * same token and state after every blank, so the predictor's output is kept and only the
 * joint runs again.
 */
export class SplitJoint implements Joint<States> {
  readonly #dec: DecoderSessions;
  readonly #cfg: HaasConfig;
  readonly #enc: EncodedFrames;
  readonly #targetLength: Ort.Tensor;
  #token = -1;
  #state: States | undefined;
  #pred: Ort.Tensor | undefined;
  #next: States | undefined;

  constructor(dec: DecoderSessions, cfg: HaasConfig, enc: EncodedFrames) {
    this.#dec = dec;
    this.#cfg = cfg;
    this.#enc = enc;
    this.#targetLength = new dec.ort.Tensor("int32", Int32Array.of(1), [1]);
  }

  initState(): States {
    const { Tensor } = this.#dec.ort;
    const shape = [this.#cfg.predLayers, 1, this.#cfg.stateWidth];
    const n = this.#cfg.predLayers * this.#cfg.stateWidth;
    return [new Tensor("float32", new Float32Array(n), shape), new Tensor("float32", new Float32Array(n), shape)];
  }

  async step(t: number, token: number, state: States): Promise<{ logits: Float32Array; state: States }> {
    const { ort, predictor, joint } = this.#dec;
    const { Tensor } = ort;
    if (token !== this.#token || state !== this.#state || this.#pred === undefined || this.#next === undefined) {
      const p = await predictor.run({
        targets: new Tensor("int32", Int32Array.of(token), [1, 1]),
        target_length: this.#targetLength,
        input_states_1: state[0],
        input_states_2: state[1],
      });
      this.#token = token;
      this.#state = state;
      this.#pred = p["pred"]!;
      this.#next = [p["output_states_1"]!, p["output_states_2"]!];
    }
    const D = this.#cfg.dModel;
    const out = await joint.run({
      encoder_outputs: new Tensor("float32", this.#enc.data.subarray(t * D, (t + 1) * D), [1, D, 1]),
      pred: this.#pred,
    });
    return { logits: out["outputs"]!.data as Float32Array, state: this.#next };
  }
}

/** `transcribe` = trailing-silence trim, log-mel, encoder, TDT greedy decode, detokenize, W2's ASR text filters. */
export class HaasRecognizer {
  readonly #cfg: HaasConfig;
  readonly #mel: MelFrontEnd;
  readonly #pieces: PieceDecoder;
  readonly #encoder: OrtSession;
  readonly #decoder: DecoderSessions;

  /** Each session comes with the onnxruntime-web build that created it: tensors don't cross builds. */
  constructor(tables: HaasTables, encoder: OrtSession, decoder: DecoderSessions) {
    this.#cfg = tables.config;
    this.#mel = new MelFrontEnd(tables.config, tables.window, tables.fb);
    this.#pieces = new PieceDecoder(tables.pieces);
    this.#encoder = encoder;
    this.#decoder = decoder;
  }

  async decode(enc: EncodedFrames): Promise<{ ids: number[]; steps: number }> {
    if (enc.frames === 0) return { ids: [], steps: 0 };
    return greedyTdt(new SplitJoint(this.#decoder, this.#cfg, enc), enc.frames, this.#cfg);
  }

  detokenize(ids: readonly number[]): string {
    return this.#pieces.decode(ids);
  }

  async transcribe(audio: Float32Array): Promise<Transcript> {
    const t0 = performance.now();
    const samples = trimTrailingSilence(audio);
    const { mel, padded, frames } = this.#mel.compute(samples);
    const t1 = performance.now();
    const enc = frames === 0 ? { data: new Float32Array(0), frames: 0 } : await this.#runEncoder(mel, padded, frames);
    const t2 = performance.now();
    const { ids, steps } = await this.decode(enc);
    const t3 = performance.now();
    const raw = this.#pieces.decode(ids);
    const ja = asJaText(raw);
    return {
      text: isNonContentAsr(ja) ? asJaText("") : deduplicatePhrases(ja),
      raw,
      ids,
      timing: { melMs: t1 - t0, encMs: t2 - t1, decMs: t3 - t2, steps },
    };
  }

  async #runEncoder(mel: Float32Array, padded: number, frames: number): Promise<EncodedFrames> {
    const { ort, session } = this.#encoder;
    const out = await session.run({
      audio_signal: new ort.Tensor("float32", mel, [1, this.#cfg.nMels, padded]),
      length: new ort.Tensor("int64", BigInt64Array.of(BigInt(frames)), [1]),
    });
    const o = out["outputs"]!;
    const lengths = out["encoded_lengths"]!;
    const tEnc = o.dims[2]!;
    const valid = Number((lengths.data as BigInt64Array)[0]);
    const D = this.#cfg.dModel;
    const src = o.data as Float32Array;
    const data = new Float32Array(valid * D);
    for (let d = 0; d < D; d++) for (let t = 0; t < valid; t++) data[t * D + d] = src[d * tEnc + t]!;
    o.dispose();
    lengths.dispose();
    return { data, frames: valid };
  }
}
