import { TranslationCache } from "../core/cache";
import { TranslationContext } from "../core/context";
import type { Glossary } from "../core/glossary";
import { asJaText } from "../core/types";
import { DisplayStage, type DisplayInput } from "./display";
import { GpuQueue } from "./gpuQueue";
import { PartialEnCoordinator } from "./partialEn";
import { FakeClock, FakeMt } from "./testing";
import type { PipelineEvent } from "./types";

/** A display stage over fakes, with the pieces a test pokes at exposed. Test support only. */
export function displayHarness(over: { partialEn?: boolean; glossary?: Glossary } = {}) {
  const events: PipelineEvent[] = [];
  const mt = new FakeMt();
  const gpu = new GpuQueue();
  const cache = new TranslationCache();
  const context = new TranslationContext();
  const clock = new FakeClock();
  const glossary = over.glossary ?? new Map<string, string>();
  const emit = (event: PipelineEvent): void => void events.push(event);
  const coordinator = new PartialEnCoordinator({ gpu, mt, cache, context, glossary: () => glossary, emit, enabled: over.partialEn ?? true });
  const stage = new DisplayStage({ gpu, mt, cache, context, coordinator, glossary: () => glossary, clock, emit, onSettled: () => undefined });

  const final = (text: string, over: Partial<Extract<DisplayInput, { kind: "final" }>> = {}): void =>
    void stage.enqueue({
      kind: "final",
      text: asJaText(text),
      timelineS: 0,
      durationS: 3,
      audioEndS: 3,
      speechEndMs: 0,
      vadWaitS: 0.384,
      queueWaitS: 0,
      asrS: 0.2,
      ...over,
    });
  const partial = (text: string, timelineS = 0): void => void stage.enqueue({ kind: "partial", text: asJaText(text), timelineS });
  return { events, mt, gpu, cache, context, clock, coordinator, stage, final, partial };
}

export type DisplayHarness = ReturnType<typeof displayHarness>;
