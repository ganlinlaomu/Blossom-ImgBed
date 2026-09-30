import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  issueUploadToken,
  authenticateUploadToken,
  consumeBoundUploadToken,
} from "../functions/blossom/upload-token.js";
import {
  reserveUploadQuota,
  releaseUploadQuota,
} from "../functions/blossom/upload-quota.js";
import { readAndHashRequest } from "../functions/blossom/hash.js";
function environment() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(
    readFileSync(new URL("../database/init.sql", import.meta.url), "utf8"),
  );
  const img_d1 = {
    prepare(query) {
      let values = [];
      return {
        bind(...v) {
          values = v;
          return this;
        },
        async first() {
          return sql.prepare(query).get(...values);
        },
        async run() {
          return {
            meta: { changes: sql.prepare(query).run(...values).changes },
          };
        },
      };
    },
  };
  return { img_d1, sql };
}
const subject = "a".repeat(64),
  contentHash = "b".repeat(64);
test("content-bound capability is single-use even with concurrent consumption", async () => {
  const env = environment();
  try {
    const issued = await issueUploadToken(env, {
      subject,
      ttl: 60,
      contentHash,
      maxBytes: 100,
    });
    assert.equal(issued.bindingVersion, 1);
    const auth = await authenticateUploadToken(
      new Request("https://example.com/upload", {
        headers: { Authorization: `Bearer ${issued.token}` },
      }),
      env,
    );
    await assert.rejects(
      consumeBoundUploadToken(env, auth, "c".repeat(64), 10),
      /binding_mismatch/,
    );
    await assert.rejects(
      consumeBoundUploadToken(env, auth, contentHash, 101),
      /binding_mismatch/,
    );
    const results = await Promise.allSettled([
      consumeBoundUploadToken(env, auth, contentHash, 100),
      consumeBoundUploadToken(env, auth, contentHash, 100),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  } finally {
    env.sql.close();
  }
});
test("actual-byte reservations are atomic and release on the original date", async () => {
  const env = {
    ...environment(),
    HAINEI_DAILY_UPLOAD_COUNT: "1",
    HAINEI_DAILY_UPLOAD_BYTES: "100",
  };
  try {
    const results = await Promise.allSettled([
      reserveUploadQuota(env, subject, 80),
      reserveUploadQuota(env, subject, 80),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const date = results.find((r) => r.status === "fulfilled").value;
    await releaseUploadQuota(env, subject, 80, date);
    await reserveUploadQuota(env, subject, 100);
    await assert.rejects(reserveUploadQuota(env, subject, 1));
  } finally {
    env.sql.close();
  }
});
test("rejects a chunked body immediately when actual bytes exceed limit", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    pull(c) {
      c.enqueue(new Uint8Array(4));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    readAndHashRequest(
      new Request("https://x/upload", {
        method: "PUT",
        body: stream,
        duplex: "half",
      }),
      5,
    ),
    /file_too_large/,
  );
  assert.equal(cancelled, true);
});
