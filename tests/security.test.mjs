import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { safeHttpUrl } from "../src/lib/security.ts";

test("untrusted addon URLs cannot become script or credentialed navigation", () => {
  assert.equal(safeHttpUrl("javascript:alert(1)"), null);
  assert.equal(safeHttpUrl("data:text/html,<script>alert(1)</script>"), null);
  assert.equal(safeHttpUrl("https://user:secret@example.com/video"), null);
  assert.equal(safeHttpUrl("https://example.com/video?id=1"), "https://example.com/video?id=1");
});

test("the Window auth bridge contains no bearer or refresh-token fields", async () => {
  const account = await readFile(new URL("../src/lib/account.ts", import.meta.url), "utf8");
  assert.doesNotMatch(
    account,
    /\b(?:accessToken|refreshToken|access_token|refresh_token|refresh-session)\b/,
  );
});

test("the document policy rejects inline and third-party scripts", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const policy = html.match(/Content-Security-Policy[^>]+content="([^"]+)"/)?.[1] ?? "";
  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /script-src-attr 'none'/);
  assert.doesNotMatch(policy.match(/script-src ([^;]+)/)?.[1] ?? "", /unsafe-inline|https?:/);
});
