export function normalizePluginManifestUrl(raw: string): string {
  const input = raw.trim();
  if (!input) throw new Error("Enter a plugin repository URL.");
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const parsed = new URL(withScheme);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error("Plugin repository must be a public HTTP or HTTPS URL.");
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  if (!parsed.pathname.endsWith("/manifest.json"))
    parsed.pathname += "/manifest.json";
  return parsed.toString();
}
