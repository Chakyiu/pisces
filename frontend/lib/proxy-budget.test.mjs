// `node --test lib/proxy-budget.test.mjs` from frontend/.
import assert from "node:assert/strict";
import test from "node:test";
import { proxyTimeoutMs } from "./proxy-budget.ts";

test("proposal confirm shares the compose-up budget", () => {
  assert.equal(proxyTimeoutMs("POST", "/proposals/01abc/confirm"), 310_000);
  assert.equal(proxyTimeoutMs("POST", "/proposals/01abc/reject"), 10_000);
  assert.equal(proxyTimeoutMs("GET", "/proposals"), 10_000);
});

test("stack routes keep the compose-up budget", () => {
  assert.equal(proxyTimeoutMs("POST", "/endpoints/e1/stacks"), 310_000);
  assert.equal(proxyTimeoutMs("PUT", "/endpoints/e1/stacks/demo"), 310_000);
  assert.equal(proxyTimeoutMs("DELETE", "/endpoints/e1/stacks/demo"), 310_000);
  assert.equal(proxyTimeoutMs("POST", "/endpoints/e1/stacks/demo/restart"), 310_000);
});

test("other calls keep their existing budgets", () => {
  assert.equal(proxyTimeoutMs("GET", "/endpoints/e1/containers/c1/logs/stream"), null);
  assert.equal(proxyTimeoutMs("GET", "/endpoints/e1/containers/c1/stats/stream"), null);
  assert.equal(proxyTimeoutMs("POST", "/endpoints/e1/containers/c1/duplicate"), 120_000);
  assert.equal(proxyTimeoutMs("POST", "/endpoints/e1/containers/c1/recreate"), 120_000);
  assert.equal(proxyTimeoutMs("POST", "/endpoints/e1/containers/c1/start"), 10_000);
});
