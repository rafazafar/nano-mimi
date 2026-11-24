import { describe, expect, it } from "vitest";
import { StreamingVad, type WindowScorer } from "../audio/streamingVad";
import { LIVE_TUNING, SAMPLE_RATE } from "../audio/vadStateMachine";
import { UtteranceFeed, type UtteranceSink } from "./feed";
import type { AsrItem } from "./types";

/** Scores a window as speech when it is not silent, so a test draws speech by writing amplitude. */
class AmplitudeScorer implements WindowScorer {
  failNext = false;
  score(win: Float32Array): Promise<number> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("scorer crashed"));
    }
    return Promise.resolve(win.some((v) => v !== 0) ? 0.95 : 0.02);
  }
  reset(): void {}
}

class RecordingSink implements UtteranceSink {
  readonly items: Omit<AsrItem, "enqueuedAtMs">[] = [];
  readonly clock: number[] = [];
  submit(item: Omit<AsrItem, "enqueuedAtMs">): Promise<void> {
    this.items.push(item);
    return Promise.resolve();
  }
  advanceAudio(seconds: number): void {
    this.clock.push(seconds);
  }
}

const tone = (seconds: number): Float32Array => new Float32Array(Math.round(seconds * SAMPLE_RATE)).fill(0.3);
const silence = (seconds: number): Float32Array => new Float32Array(Math.round(seconds * SAMPLE_RATE));

function rig() {
  const scorer = new AmplitudeScorer();
  const sink = new RecordingSink();
  const errors: string[] = [];
  const feed = new UtteranceFeed(new StreamingVad(LIVE_TUNING, scorer), sink, (detail) => errors.push(detail));
  return { scorer, sink, errors, feed };
}

/** Feeds in 100 ms blocks, as the capture worklet's batches arrive. */
function play(feed: UtteranceFeed, audio: Float32Array): void {
  const block = SAMPLE_RATE / 10;
  for (let at = 0; at < audio.length; at += block) feed.feed(audio.subarray(at, at + block));
}

describe("the utterance feed", () => {
  it("hands each spoken stretch to the sink once the silence after it has been seen", async () => {
    const { feed, sink } = rig();
    play(feed, silence(1));
    play(feed, tone(1.5));
    play(feed, silence(1));
    await feed.close();

    expect(sink.items).toHaveLength(1);
    const [only] = sink.items;
    expect(only?.samples.length).toBeGreaterThan(1.5 * SAMPLE_RATE);
    expect(only?.audioEndS).toBeGreaterThan(2.5);
    expect(only?.audioEndS).toBeLessThan(3.2);
    expect(only?.vadWaitS).toBeGreaterThan(0);
  });

  it("keeps two utterances apart and in order", async () => {
    const { feed, sink } = rig();
    for (const part of [tone(1.2), silence(1), tone(1.2), silence(1)]) play(feed, part);
    await feed.close();
    expect(sink.items).toHaveLength(2);
    expect(sink.items[1]?.audioEndS).toBeGreaterThan(sink.items[0]?.audioEndS ?? Infinity);
  });

  it("closes an utterance that is still open when the stream ends", async () => {
    const { feed, sink } = rig();
    play(feed, silence(0.5));
    play(feed, tone(1.5));
    await feed.close();
    expect(sink.items).toHaveLength(1);
  });

  it("drops a blip too short to be speech", async () => {
    const { feed, sink } = rig();
    play(feed, silence(1));
    play(feed, tone(0.2));
    play(feed, silence(1));
    await feed.close();
    expect(sink.items).toEqual([]);
  });

  it("moves the audio clock as samples arrive, before the VAD has scored them", () => {
    const { feed, sink } = rig();
    feed.feed(silence(0.5));
    feed.feed(silence(0.5));
    expect(sink.clock).toEqual([0.5, 1]);
    expect(feed.audioSeconds).toBe(1);
  });

  it("reports a scoring failure and carries on with the audio after it", async () => {
    const { feed, sink, scorer, errors } = rig();
    scorer.failNext = true;
    play(feed, silence(0.1));
    await feed.close();
    expect(errors).toEqual(["Voice detection failed: scorer crashed"]);

    play(feed, tone(1.5));
    play(feed, silence(1));
    await feed.close();
    expect(sink.items).toHaveLength(1);
  });
});
