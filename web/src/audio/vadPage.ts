import { microphoneStream, startCapture, tabAudioStream, type Capture } from "./capture";
import { loadSilero } from "./sileroBrowser";
import { StreamingVad, emitted } from "./streamingVad";
import { LIVE_TUNING, SAMPLE_RATE, type Candidate } from "./vadStateMachine";
import { decodeWavTo16k } from "./wav";

const FILE_SLICE = 1600;

function element<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} missing from vad.html`);
  return el as T;
}

const startMic = element<HTMLButtonElement>("start-mic");
const startTab = element<HTMLButtonElement>("start-tab");
const wavFile = element<HTMLInputElement>("wav-file");
const stop = element<HTMLButtonElement>("stop");
const status = element("status");
const workletStats = element("worklet-stats");
const count = element("count");
const rows = element<HTMLTableSectionElement>("utterances");

function setStatus(state: string, text: string): void {
  status.dataset["state"] = state;
  status.textContent = text;
}

function setIdle(idle: boolean): void {
  startMic.disabled = !idle;
  startTab.disabled = !idle;
  wavFile.disabled = !idle;
  stop.disabled = idle;
}

function seconds(sample: number): string {
  return (sample / SAMPLE_RATE).toFixed(2);
}

function showUtterances(candidates: readonly Candidate[]): void {
  for (const u of emitted(candidates)) {
    const row = rows.insertRow();
    row.dataset["startSample"] = String(u.start);
    row.dataset["endSample"] = String(u.end);
    const cells = [
      String(rows.rows.length),
      seconds(u.start),
      seconds(u.end),
      seconds(u.end - u.start),
      u.vadWaitS.toFixed(3),
    ];
    for (const text of cells) row.insertCell().textContent = text;
  }
  count.textContent = String(rows.rows.length);
}

async function main(): Promise<void> {
  const silero = await loadSilero();
  let vad = new StreamingVad(LIVE_TUNING, silero);
  let capture: Capture | null = null;
  let statsTimer: number | undefined;

  const reset = (): void => {
    silero.reset();
    vad = new StreamingVad(LIVE_TUNING, silero);
    rows.replaceChildren();
    count.textContent = "0";
    workletStats.textContent = "";
  };

  const live = async (open: () => Promise<MediaStream>, label: string): Promise<void> => {
    try {
      const stream = await open();
      reset();
      setIdle(false);
      const current = vad;
      capture = await startCapture(stream, (samples) => {
        void current.feed(samples).then(showUtterances);
      });
      setStatus("listening", `Listening to ${label}`);
      statsTimer = window.setInterval(() => {
        void capture?.stats().then((s) => {
          workletStats.textContent =
            `worklet @ ${s.sampleRate} Hz: ${s.quanta} quanta, mean ${s.meanMs.toFixed(3)} ms, ` +
            `slow calls ${s.slowCalls}, max ${s.maxTicks} ms ticks, empty ${s.emptyInputs}, skipped ${s.skippedQuanta}`;
        });
      }, 1000);
    } catch (error) {
      setIdle(true);
      setStatus("error", error instanceof Error ? error.message : String(error));
    }
  };

  startMic.onclick = () => void live(microphoneStream, "the microphone");
  startTab.onclick = () => void live(tabAudioStream, "tab audio");

  stop.onclick = async () => {
    window.clearInterval(statsTimer);
    await capture?.stop();
    capture = null;
    showUtterances(await vad.flush());
    setIdle(true);
    setStatus("stopped", "Stopped");
  };

  wavFile.onchange = async () => {
    const file = wavFile.files?.[0];
    if (file === undefined) return;
    setIdle(false);
    stop.disabled = true;
    setStatus("running", `Scanning ${file.name}`);
    try {
      const samples = decodeWavTo16k(new Uint8Array(await file.arrayBuffer()));
      reset();
      for (let at = 0; at < samples.length; at += FILE_SLICE) {
        showUtterances(await vad.feed(samples.subarray(at, at + FILE_SLICE)));
      }
      showUtterances(await vad.flush());
      setStatus("done", `${file.name}: ${(samples.length / SAMPLE_RATE).toFixed(1)} s scanned`);
    } catch (error) {
      setStatus("error", error instanceof Error ? error.message : String(error));
    }
    setIdle(true);
    wavFile.value = "";
  };

  setIdle(true);
  setStatus("ready", "Ready");
}

main().catch((error: unknown) => {
  setStatus("error", error instanceof Error ? error.message : String(error));
});
