import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { KbBridgeClient } from "../dist/kbBridgeClient.js";
import { extractMediaAttachments, isMediaPlaceholder } from "../dist/messages.js";

test("extracts media paths and recognizes placeholders", () => {
  assert.deepEqual(extractMediaAttachments({ MediaPaths: ["/tmp/a.pdf"] }), [
    { localPath: "/tmp/a.pdf" },
  ]);
  assert.equal(isMediaPlaceholder("[file]"), true);
  assert.equal(isMediaPlaceholder("ordinary message"), false);
});

test("multipart upload sends bytes and source metadata without local path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kb-file-test-"));
  const path = join(dir, "sample.txt");
  await writeFile(path, "hello");
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (_url, init) => {
    captured = init;
    return new Response(JSON.stringify({ requestId: "r", taskId: 1, status: "RECEIVED", duplicate: false }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const client = new KbBridgeClient({ baseUrl: "http://kb", sharedSecret: "secret",
      requestTimeoutMs: 1000, query: { enabled: true, injectEmptyKbResponses: false },
      ingest: { autoCandidateEnabled: false, manualCommandPrefixes: [], manualSourceType: "ATTACHMENT",
        candidateSourceType: "ATTACHMENT", skipSelfMessages: true, fileCommandPrefixes: [],
        fileCancelCommands: [], fileIntentTtlMs: 1000,
        statusPolling: { enabled: false, intervalMs: 1000, maxDurationMs: 1000, maxConsecutiveErrors: 1 } },
      debug: false });
    await client.ingestFile({ requestId: "r", userId: "u", messageId: "m", filePath: path,
      fileName: "sample.txt", mimeType: "text/plain" });
    assert.equal(captured.headers["X-KB-File-Token"], "secret");
    assert.equal(captured.body.get("requestId"), "r");
    assert.equal(captured.body.get("file").name, "sample.txt");
    assert.equal(String(captured.body.get("file")), "[object File]");
    assert.equal([...captured.body.keys()].includes("filePath"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
