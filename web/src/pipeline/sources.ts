import { microphoneStream, startCapture, tabAudioStream, type Capture } from "../audio/capture";
import { SAMPLE_RATE } from "../audio/vadStateMachine";
import { decodeWavTo16k } from "../audio/wav";
import type { SourceSpec } from "./session";

const CAPTURE_DRAIN_MS = 300;

/** Something that delivers 16 kHz mono blocks until it ends or is stopped. */
export interface AudioSource {
  readonly label: string;
  /**
   * Settles when the source stops on its own: a file played to its end, or the user stopped sharing a tab
   * (resolves), or the microphone went away (rejects). Resolves after `stop()` too.
   */
  readonly ended: Promise<void>;
  start(onSamples: (samples: Float32Array) => void): Promise<void>;
  stop(): Promise<void>;
  /** The audio as a live track, for a recognizer that listens itself. Null before `start` for a file. */
  track(): MediaStreamTrack | null;
}

interface Signal {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

function signal(): Signal {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // The session attaches its handlers after start; a rejection before then must not be reported as unhandled.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function streamSource(stream: MediaStream, label: string, deviceLostMessage: string | null): AudioSource {
  const ended = signal();
  let capture: Capture | null = null;
  const release = (): void => stream.getTracks().forEach((track) => track.stop());
  stream.getAudioTracks()[0]?.addEventListener(
    "ended",
    () => (deviceLostMessage === null ? ended.resolve() : ended.reject(new Error(deviceLostMessage))),
    { once: true },
  );
  return {
    label,
    ended: ended.promise,
    track: () => stream.getAudioTracks()[0] ?? null,
    async start(onSamples) {
      try {
        capture = await startCapture(stream, onSamples);
      } catch (error) {
        release();
        throw error;
      }
    },
    async stop() {
      await capture?.stop();
      capture = null;
      release();
      ended.resolve();
    },
  };
}

function fileSource(name: string, bytes: Uint8Array): AudioSource {
  const samples = decodeWavTo16k(bytes);
  const ended = signal();
  let context: AudioContext | null = null;
  let capture: Capture | null = null;
  let track: MediaStreamTrack | null = null;
  let tail: ReturnType<typeof setTimeout> | undefined;
  return {
    label: name,
    ended: ended.promise,
    track: () => track,
    async start(onSamples) {
      const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      context = ctx;
      try {
        const buffer = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
        buffer.getChannelData(0).set(samples);
        const destination = ctx.createMediaStreamDestination();
        track = destination.stream.getAudioTracks()[0] ?? null;
        const player = ctx.createBufferSource();
        player.buffer = buffer;
        player.connect(destination);
        player.onended = () => {
          tail = setTimeout(ended.resolve, CAPTURE_DRAIN_MS);
        };
        capture = await startCapture(destination.stream, onSamples);
        await ctx.resume();
        player.start();
      } catch (error) {
        await ctx.close();
        context = null;
        throw error;
      }
    },
    async stop() {
      clearTimeout(tail);
      await capture?.stop();
      capture = null;
      await context?.close();
      context = null;
      ended.resolve();
    },
  };
}

/** Opens the source and asks for any permission it needs. Rejects with the browser's own error when refused. */
export async function openSource(spec: SourceSpec): Promise<AudioSource> {
  switch (spec.kind) {
    case "mic": {
      const stream = await microphoneStream();
      const label = stream.getAudioTracks()[0]?.label ?? "";
      return streamSource(stream, label === "" ? "Microphone" : label, "The microphone stopped. Check that it is still connected.");
    }
    case "tab":
      return streamSource(await tabAudioStream(), "Tab audio", null);
    case "file":
      return fileSource(spec.name, spec.bytes);
  }
}
