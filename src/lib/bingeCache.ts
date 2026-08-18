/**
 * The source a series was last watched from.
 *
 * A binge group names a release able to serve a whole run, so once one episode
 * has been played there is rarely a decision left to make for the next: the
 * same group means the same quality, the same audio and the same host. Nuvio
 * keeps this per series in `BingeGroupCacheRepository` for the same reason —
 * so continuing does not put a list of sources in front of you first.
 *
 * Kept on the device rather than synced. It describes what this browser can
 * reach and what it chose, which is not necessarily true of another.
 */

const KEY = "nuvio-web-binge-groups";
/** Enough for any plausible number of series on the go, and bounded. */
const LIMIT = 60;

type Entry = { group: string; at: number };

function read(): Record<string, Entry> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, Entry>)
      : {};
  } catch {
    return {};
  }
}

export function rememberBingeGroup(metaId: string, group?: string) {
  if (!metaId || !group) return;
  try {
    const all = read();
    all[metaId] = { group, at: Date.now() };
    // Oldest first out, so a long history cannot grow without bound.
    const entries = Object.entries(all).sort(
      (left, right) => (right[1]?.at ?? 0) - (left[1]?.at ?? 0),
    );
    localStorage.setItem(
      KEY,
      JSON.stringify(Object.fromEntries(entries.slice(0, LIMIT))),
    );
  } catch {
    // Without it, continuing asks which source to use, as it did before.
  }
}

export function bingeGroupFor(metaId: string): string | undefined {
  return read()[metaId]?.group;
}
