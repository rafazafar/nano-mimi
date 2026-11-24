import workletUrl from "./capture.worklet.ts?worker&url";
import type { WorkletMessage, WorkletRequest, WorkletStats } from "./captureProtocol";

export interface Capture {
  /** How `process()` behaved in the worklet since capture started. */
  stats(): Promise<WorkletStats>;
  stop(): Promise<void>;
}

/**
 * The microphone with the browser's voice processing off. The Python path reads
 * the raw device, and the VAD gain and noise-floor rules assume an unprocessed signal.
 */
export function microphoneStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
}

/** Audio of a tab, or of the whole system when the user shares a screen. The video track is dropped. */
export async function tabAudioStream(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true, systemAudio: "include" } as DisplayMediaStreamOptions);
  stream.getVideoTracks().forEach((track) => {
    track.stop();
    stream.removeTrack(track);
  });
  if (stream.getAudioTracks().length === 0) {
    throw new Error('The shared source has no audio. Pick a tab and tick "Share tab audio".');
  }
  return stream;
}

/**
 * Streams `stream` as 16 kHz mono float32 in 512-sample blocks. The context
 * runs at the device rate and the worklet's own resampler converts, so the
 * conversion is the same on every browser.
 */
export async function startCapture(
  stream: MediaStream,
  onSamples: (samples: Float32Array) => void,
): Promise<Capture> {
  const context = new AudioContext({ latencyHint: "interactive" });
  try {
    await context.audioWorklet.addModule(workletUrl);
    await context.resume();
  } catch (error) {
    await context.close();
    throw error;
  }
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "mimivox-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
    channelCountMode: "explicit",
  });
  const statsWaiters: ((stats: WorkletStats) => void)[] = [];
  node.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
    const message = event.data;
    if (message.type === "samples") onSamples(message.samples);
    else statsWaiters.splice(0).forEach((resolve) => resolve(message));
  };
  source.connect(node);

  return {
    stats() {
      return new Promise((resolve) => {
        statsWaiters.push(resolve);
        const request: WorkletRequest = { type: "stats" };
        node.port.postMessage(request);
      });
    },
    async stop() {
      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      node.port.onmessage = null;
      await context.close();
    },
  };
}
