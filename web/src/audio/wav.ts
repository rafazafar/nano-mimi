import { SAMPLE_RATE } from "./vadStateMachine";
import { resampleTo16k } from "./resampler";

export interface Wav {
  readonly sampleRate: number;
  /** Channels averaged to mono, scaled to [-1, 1). */
  readonly samples: Float32Array;
}

/** Reads a RIFF WAV with 16-bit PCM or 32-bit float samples. */
export function decodeWav(bytes: Uint8Array): Wav {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Not a RIFF WAVE file");

  let format: { code: number; channels: number; rate: number; bits: number } | null = null;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (tag(at) === "fmt ") {
      format = {
        code: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (tag(at) === "data") {
      if (format === null) throw new Error("WAV data chunk before fmt chunk");
      return {
        sampleRate: format.rate,
        samples: readSamples(view, body, Math.min(size, bytes.length - body), format),
      };
    }
    at = body + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

function readSamples(
  view: DataView,
  start: number,
  byteLength: number,
  format: { code: number; channels: number; bits: number },
): Float32Array {
  const pcm16 = format.code === 1 && format.bits === 16;
  const float32 = format.code === 3 && format.bits === 32;
  if (!pcm16 && !float32) {
    throw new Error(`Unsupported WAV format ${format.code} with ${format.bits} bits`);
  }
  const bytesPerSample = format.bits / 8;
  const frames = Math.floor(byteLength / (bytesPerSample * format.channels));
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < format.channels; c++) {
      const at = start + (f * format.channels + c) * bytesPerSample;
      sum += pcm16 ? view.getInt16(at, true) / 32768 : view.getFloat32(at, true);
    }
    out[f] = sum / format.channels;
  }
  return out;
}

/** A WAV as 16 kHz mono float32. A file already at 16 kHz is not resampled. */
export function decodeWavTo16k(bytes: Uint8Array): Float32Array {
  const wav = decodeWav(bytes);
  return wav.sampleRate === SAMPLE_RATE ? wav.samples : resampleTo16k(wav.samples, wav.sampleRate);
}
