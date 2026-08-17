/**
 * Returns a canonical network URL or null. Addon metadata is untrusted, so it
 * must never be placed in a navigable href/location unless it passes here.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}
