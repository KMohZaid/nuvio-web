export type SyncPreferenceType =
  | "string"
  | "boolean"
  | "int"
  | "float"
  | "string_set";

export type SyncPreferenceValue = {
  type: SyncPreferenceType;
  value: unknown;
};

/**
 * Nuvio's v3 settings blob deliberately mixes three feature shapes:
 * typed preference maps, raw payload objects, and JSON serialized as strings.
 * Keeping each feature unknown prevents one shape from being written over
 * another by accident.
 */
export type SettingsBlob = {
  version: number;
  features: Record<string, unknown>;
  [key: string]: unknown;
};

export const emptySettingsBlob = (): SettingsBlob => ({
  version: 3,
  features: {},
});

export const recordOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export type SyncPreferenceTypeMap = {
  string: string;
  boolean: boolean;
  int: number;
  float: number;
  string_set: string[];
};

/** Reads one exact typed preference. A mismatched type is ignored like Nuvio. */
export function blobTypedValue<T extends SyncPreferenceType>(
  blob: SettingsBlob | null,
  feature: string,
  key: string,
  type: T,
  fallback: SyncPreferenceTypeMap[T],
): SyncPreferenceTypeMap[T] {
  const entry = recordOf(recordOf(blob?.features?.[feature])[key]);
  const value = entry.value;
  if (entry.type !== type) return fallback;
  if (type === "boolean" && typeof value === "boolean")
    return value as SyncPreferenceTypeMap[T];
  if ((type === "int" || type === "float") && typeof value === "number")
    return value as SyncPreferenceTypeMap[T];
  if (type === "string" && typeof value === "string")
    return value as SyncPreferenceTypeMap[T];
  if (
    type === "string_set" &&
    Array.isArray(value) &&
    value.every((item) => typeof item === "string")
  )
    return value as SyncPreferenceTypeMap[T];
  return fallback;
}

/** Returns a new blob with one typed key changed and every unknown key intact. */
export function withBlobTypedValue<T extends SyncPreferenceType>(
  blob: SettingsBlob,
  feature: string,
  key: string,
  type: T,
  value: SyncPreferenceTypeMap[T],
): SettingsBlob {
  return {
    ...blob,
    version: typeof blob.version === "number" ? blob.version : 3,
    features: {
      ...blob.features,
      [feature]: {
        ...recordOf(blob.features?.[feature]),
        [key]: { type, value },
      },
    },
  };
}

/** Reads and shallow-merges one of Nuvio's JSON-string feature payloads. */
export function blobStringPayload<T extends Record<string, unknown>>(
  blob: SettingsBlob | null,
  feature: string,
  fallback: T,
): T {
  const raw = blob?.features?.[feature];
  if (typeof raw !== "string") return { ...fallback };
  try {
    return { ...fallback, ...recordOf(JSON.parse(raw)) } as T;
  } catch {
    return { ...fallback };
  }
}

/**
 * Patches a JSON-string feature without dropping fields added by newer Nuvio
 * clients. The feature remains a string in the outer blob by design.
 */
export function withBlobStringPayload(
  blob: SettingsBlob,
  feature: string,
  patch: Record<string, unknown>,
): SettingsBlob {
  const raw = blob.features?.[feature];
  let current: Record<string, unknown> = {};
  if (typeof raw === "string") {
    try {
      current = recordOf(JSON.parse(raw));
    } catch {
      // Replace only the malformed feature; the rest of the blob survives.
    }
  }
  return {
    ...blob,
    version: typeof blob.version === "number" ? blob.version : 3,
    features: {
      ...blob.features,
      [feature]: JSON.stringify({ ...current, ...patch }),
    },
  };
}

/** Changes one raw payload field (notifications are currently this shape). */
export function withBlobRawValue(
  blob: SettingsBlob,
  feature: string,
  key: string,
  value: unknown,
): SettingsBlob {
  return {
    ...blob,
    version: typeof blob.version === "number" ? blob.version : 3,
    features: {
      ...blob.features,
      [feature]: { ...recordOf(blob.features?.[feature]), [key]: value },
    },
  };
}

export function blobRawValue<T>(
  blob: SettingsBlob | null,
  feature: string,
  key: string,
  guard: (value: unknown) => value is T,
  fallback: T,
): T {
  const value = recordOf(blob?.features?.[feature])[key];
  return guard(value) ? value : fallback;
}
