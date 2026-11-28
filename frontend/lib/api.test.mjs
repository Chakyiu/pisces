// `node --test lib/api.test.mjs` from frontend/.
import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, api } from "./api.ts";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("api returns a JSON body", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  assert.deepEqual(await api("/api/example", { timeoutMs: 1000 }), { ok: true });
});

test("api returns undefined for 204", async () => {
  globalThis.fetch = async () => new Response(null, { status: 204 });
  assert.equal(await api("/api/example", { method: "PUT", timeoutMs: 1000 }), undefined);
});

test("api surfaces an API error message", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: "deploy_failed", message: "Compose failed.", retryable: false } }), { status: 502 });
  await assert.rejects(api("/api/example", { timeoutMs: 1000 }), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.message, "Compose failed.");
    return true;
  });
});

test("api rejects when fetch never finishes", async () => {
  globalThis.fetch = () => new Promise(() => {});
  await assert.rejects(api("/api/example", { timeoutMs: 30, failureMessage: "Update timed out." }), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.message, "Update timed out.");
    return true;
  });
});
