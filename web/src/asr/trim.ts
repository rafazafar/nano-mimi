const FLOOR = Math.fround(0.01);
const PAD = 16_000 / 50;

/**
 * Port of asr.py `_trim_trailing_silence`: cut after the last sample at or above 0.01,
 * keeping up to ~20 ms. Unlike the VAD's trim, an all-quiet clip comes back whole.
 */
export function trimTrailingSilence(audio: Float32Array): Float32Array {
  for (let last = audio.length - 1; last >= 0; last--) {
    if (Math.abs(audio[last]!) >= FLOOR) {
      return audio.subarray(0, last + 1 + Math.min(PAD, audio.length - last - 1));
    }
  }
  return audio;
}
