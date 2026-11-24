/// <reference lib="webworker" />
import { asJaText } from "../core/types";
import { CatEngine } from "./engine";
import { translateWithRetries } from "./ladder";
import type { MtEvent, MtRequest } from "./protocol";
import { MtScheduler } from "./scheduler";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (event: MtEvent): void => scope.postMessage(event);

let scheduler: MtScheduler | null = null;

async function init(request: Extract<MtRequest, { type: "init" }>): Promise<void> {
  try {
    const engine = await CatEngine.load(request.manifest, request.modelId);
    scheduler = new MtScheduler(
      (job, signal, onToken) =>
        translateWithRetries(asJaText(job.ja), job.context, engine.generate, { preview: job.preview, signal, onToken }),
      post,
    );
    post({ type: "ready", load: engine.load });
  } catch (e) {
    post({ type: "init-failed", message: e instanceof Error ? e.message : String(e) });
  }
}

scope.onmessage = (e: MessageEvent<MtRequest>) => {
  const request = e.data;
  switch (request.type) {
    case "init":
      void init(request);
      return;
    case "translate":
      if (scheduler === null) post({ type: "failed", id: request.id, message: "the MT worker is not ready" });
      else scheduler.submit(request);
      return;
    case "cancel":
      scheduler?.cancel(request.id);
      return;
  }
};
