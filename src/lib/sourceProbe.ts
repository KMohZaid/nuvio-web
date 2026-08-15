import { planRemux, probeMatroska, verdictFor } from "./matroska";
import { assessPlayback } from "./playback";

/**
 * Playability of a stream, established by reading it rather than guessing.
 *
 * The filename lies — a release named "H 265-Kitsune" turned out to be AV1 —
 * so the only reliable answer comes from the container. But a probe costs a
 * range request against the debrid host, so results are cached per URL and
 * only requested for sources the cheap heuristic cannot already settle.
 */
export type SourceStatus = {
  state: "unknown" | "checking" | "playable" | "partial" | "unplayable";
  label: string;
  detail: string;
};

/** Tracks sit near the front; half a megabyte is plenty and costs little. */
const PROBE_BYTES = 512 * 1024;
const CONCURRENCY = 3;

const cache = new Map<string, SourceStatus>();
const listeners = new Set<() => void>();

const publish = () => {
  for (const listener of listeners) listener();
};

export function subscribeSourceProbes(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const statusFor = (url: string): SourceStatus | undefined =>
  cache.get(url);

export async function probeSource(url: string): Promise<void> {
  if (cache.has(url)) return;
  cache.set(url, {
    state: "checking",
    label: "Checking…",
    detail: "Reading the container.",
  });
  publish();
  try {
    const probe = await probeMatroska(url, PROBE_BYTES);
    if (probe.tracks.length === 0) {
      cache.set(url, {
        state: "unknown",
        label: "Unreadable",
        detail:
          "No track headers in the first 512 KB — the file may hide them behind a seek index.",
      });
      publish();
      return;
    }
    const plan = planRemux(probe.tracks);
    const video = plan.video ? verdictFor(plan.video) : null;
    const audio = plan.audio ? verdictFor(plan.audio) : null;
    const parts = [video?.label, audio?.label].filter(Boolean).join(" + ");

    if (video?.status === "blocked" || !plan.video || !plan.audio) {
      cache.set(url, {
        state: "unplayable",
        label: "Not playable",
        detail: plan.summary,
      });
    } else if (plan.needsAudioTranscode) {
      cache.set(url, {
        state: "partial",
        label: "Video only",
        detail: `${parts} — no decoder for this audio, so it would play silently.`,
      });
    } else {
      cache.set(url, {
        state: "playable",
        label: "Playable",
        // Naming the streams matters: this is the row you would pick, and the
        // channel count is the difference between stereo and surround.
        detail: `${parts}${plan.audio.channels ? ` ${plan.audio.channels}ch` : ""} — decodes here as-is.`,
      });
    }
  } catch (error) {
    cache.set(url, {
      state: "unknown",
      label: "Could not check",
      detail: error instanceof Error ? error.message : "Probe failed.",
    });
  }
  publish();
}

/**
 * Probes a batch of sources a few at a time.
 *
 * Deliberately not all at once: every probe is a request to the debrid host,
 * and those enforce concurrent-connection limits that a burst would trip —
 * which would fail the very sources it is trying to assess.
 */
export async function probeSources(urls: string[]): Promise<void> {
  const pending = urls.filter((url) => !cache.has(url));
  for (let cursor = 0; cursor < pending.length; cursor += CONCURRENCY)
    await Promise.all(
      pending.slice(cursor, cursor + CONCURRENCY).map(probeSource),
    );
}

/** Sources the extension already settles need no request at all. */
export function needsProbe(url: string, filename?: string): boolean {
  if (!/^https?:/i.test(url)) return false;
  return assessPlayback(url, filename).audioRisk;
}
