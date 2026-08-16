export type ProviderCredentialRow = {
  provider: string;
  credentialJson: Record<string, unknown>;
};

const recordOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Decodes Supabase rows while retaining unknown providers and fields. */
export function decodeProviderCredentials(
  value: unknown,
): ProviderCredentialRow[] {
  if (!Array.isArray(value)) throw new Error("Invalid credential response.");
  return value.map((item) => {
    const row = recordOf(item);
    const provider = typeof row?.provider === "string" ? row.provider.trim() : "";
    const credentialJson = recordOf(row?.credential_json ?? row?.credentialJson);
    if (!provider || !credentialJson)
      throw new Error("Invalid provider credential row.");
    return { provider, credentialJson: { ...credentialJson } };
  });
}

export function providerCredential(
  rows: ProviderCredentialRow[],
  provider: string,
  field: string,
): string {
  const value = rows.find(
    (row) => row.provider.toLowerCase() === provider.toLowerCase(),
  )?.credentialJson[field];
  return typeof value === "string" ? value.trim() : "";
}

/** Updates one field without losing any other provider or credential field. */
export function withProviderCredential(
  rows: ProviderCredentialRow[],
  provider: string,
  field: string,
  value: string,
): ProviderCredentialRow[] {
  const normalized = value.trim();
  if (normalized.length > 16 * 1024 || /[\r\n]/.test(normalized))
    throw new Error("Provider credential is invalid.");
  let found = false;
  const next = rows.map((row) => {
    if (row.provider.toLowerCase() !== provider.toLowerCase())
      return { ...row, credentialJson: { ...row.credentialJson } };
    found = true;
    return {
      ...row,
      credentialJson: { ...row.credentialJson, [field]: normalized },
    };
  });
  if (!found)
    next.push({ provider, credentialJson: { [field]: normalized } });
  return next;
}

export const providerCredentialPayload = (rows: ProviderCredentialRow[]) =>
  rows.map((row) => ({
    provider: row.provider,
    credential_json: { ...row.credentialJson },
  }));
