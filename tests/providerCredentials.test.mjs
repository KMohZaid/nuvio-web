import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeProviderCredentials,
  providerCredential,
  providerCredentialPayload,
  withProviderCredential,
} from "../src/lib/providerCredentials.ts";

test("credential updates retain unknown providers and fields", () => {
  const rows = decodeProviderCredentials([
    {
      provider: "tmdb",
      credential_json: { api_key: "old", future_scope: "keep" },
    },
    {
      provider: "future-provider",
      credential_json: { token: "do-not-drop" },
    },
  ]);
  const next = withProviderCredential(rows, "tmdb", "api_key", " new ");
  assert.equal(providerCredential(next, "TMDB", "api_key"), "new");
  assert.equal(next[0].credentialJson.future_scope, "keep");
  assert.equal(next[1].credentialJson.token, "do-not-drop");
  assert.deepEqual(providerCredentialPayload(next)[1], {
    provider: "future-provider",
    credential_json: { token: "do-not-drop" },
  });
});

test("a missing official provider is added without mutating the input", () => {
  const rows = decodeProviderCredentials([]);
  const next = withProviderCredential(rows, "animeskip", "client_id", "client");
  assert.equal(rows.length, 0);
  assert.equal(providerCredential(next, "animeskip", "client_id"), "client");
});
