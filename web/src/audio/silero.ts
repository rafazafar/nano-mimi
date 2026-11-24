import type * as Ort from "onnxruntime-web";
import { SAMPLE_RATE, WINDOW } from "./vadStateMachine";
import type { WindowScorer } from "./streamingVad";

const CONTEXT = 64;
const STATE_SIZE = 2 * 1 * 128;

type OrtModule = Pick<typeof Ort, "InferenceSession" | "Tensor">;

/**
 * Silero VAD (silero_vad.onnx from silero-vad 6.2.1) on onnxruntime. Mirrors
 * `SileroOnnx` in `src/mimivox/vad.py`: each 512-sample window is scored with
 * the previous 64 samples prepended and the (2, 1, 128) state carried over.
 */
export class SileroOnnx implements WindowScorer {
  readonly #ort: OrtModule;
  readonly #session: Ort.InferenceSession;
  readonly #sr: Ort.Tensor;
  readonly #input = new Float32Array(CONTEXT + WINDOW);
  #state = new Float32Array(STATE_SIZE);

  private constructor(ort: OrtModule, session: Ort.InferenceSession) {
    this.#ort = ort;
    this.#session = session;
    this.#sr = new ort.Tensor("int64", BigInt64Array.of(BigInt(SAMPLE_RATE)), []);
  }

  /** `model` is a URL or the model's bytes. */
  static async create(
    ort: OrtModule,
    model: string | Uint8Array,
    options: Ort.InferenceSession.SessionOptions = {},
  ): Promise<SileroOnnx> {
    const session = await ort.InferenceSession.create(model as string & Uint8Array, {
      executionProviders: ["wasm"],
      ...options,
    });
    return new SileroOnnx(ort, session);
  }

  reset(): void {
    this.#state = new Float32Array(STATE_SIZE);
    this.#input.fill(0, 0, CONTEXT);
  }

  async score(win: Float32Array): Promise<number> {
    if (win.length !== WINDOW) {
      throw new Error(`Silero scores ${WINDOW}-sample windows, got ${win.length}`);
    }
    this.#input.set(win, CONTEXT);
    const out = await this.#session.run({
      input: new this.#ort.Tensor("float32", this.#input, [1, CONTEXT + WINDOW]),
      state: new this.#ort.Tensor("float32", this.#state, [2, 1, 128]),
      sr: this.#sr,
    });
    this.#state = new Float32Array((out["stateN"] as Ort.Tensor).data as Float32Array);
    this.#input.copyWithin(0, WINDOW, CONTEXT + WINDOW);
    return ((out["output"] as Ort.Tensor).data as Float32Array)[0] as number;
  }
}
