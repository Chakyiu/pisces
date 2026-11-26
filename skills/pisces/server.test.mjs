import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openAudit } from "../mcp-audit.mjs";
import {
  assertSegment,
  dispatch,
  handleRpc,
  makeClient,
  parseApiError,
  resolveBaseUrl,
  resolveCredential,
} from "./server.mjs";

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "server.mjs");

test("resolveBaseUrl and resolveCredential", () => {
  assert.equal(resolveBaseUrl({}).href, "http://127.0.0.1:8787/");
  assert.throws(() => resolveBaseUrl({ PISCES_API_URL: "ftp://x" }), /http/);
  assert.throws(() => resolveCredential({}), /PISCES_AGENT_CREDENTIAL/);
  assert.throws(() => resolveCredential({ PISCES_AGENT_CREDENTIAL: "bad" }), /pisces_agent_/);
  const token = "pisces_agent_deadbeef";
  assert.equal(resolveCredential({ PISCES_AGENT_CREDENTIAL: token }), token);
});

test("assertSegment rejects path segments", () => {
  assert.throws(() => assertSegment("../x", "endpointId"), /not valid/);
  assert.equal(assertSegment("local", "endpointId"), "local");
});

test("parseApiError reads the Pisces envelope", () => {
  const message = parseApiError(
    403,
    Buffer.from(JSON.stringify({ error: { message: "The agent has no access." } })),
  );
  assert.match(message, /403/);
  assert.match(message, /no access/);
});

test("bad ids never reach the API", async () => {
  let called = false;
  await assert.rejects(
    () =>
      dispatch(
        async () => {
          called = true;
        },
        "pisces_container_start",
        { endpointId: "local", containerId: "../x" },
      ),
    /not valid/,
  );
  assert.equal(called, false);
});

test("dispatch maps lifecycle calls to proposals", async () => {
  const calls = [];
  const request = async (spec) => {
    calls.push(spec);
    if (spec.method === "POST" && spec.path.endsWith("/start")) {
      return { id: "prp_1", status: "pending", action: "start", expiresAt: 999 };
    }
    return {};
  };
  const result = await dispatch(request, "pisces_container_start", {
    endpointId: "local",
    containerId: "abc",
  });
  assert.equal(result.proposalId, "prp_1");
  assert.match(calls[0].path, /\/start$/);
});

test("tools/call writes an audit record and list does not", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pisces-mcp-audit-"));
  const logPath = path.join(dir, "pisces.jsonl");
  const audit = openAudit(
    {
      PISCES_MCP_AUDIT_LOG: logPath,
      PISCES_MCP_AUDIT_CONFIG: path.join(dir, "missing.json"),
    },
    "pisces",
    ["pisces_agent_testsecret"],
  );
  try {
    await handleRpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", clientInfo: { name: "tester", version: "1" } },
      },
      async () => ({}),
      audit,
    );
    const ok = await handleRpc(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "pisces_health", arguments: { endpointId: "local" } },
      },
      async () => ({ ok: true }),
      audit,
    );
    assert.notEqual(ok.result.isError, true);
    const bad = await handleRpc(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "pisces_health", arguments: { token: "pisces_agent_testsecret" } },
      },
      async () => {
        throw new Error("boom pisces_agent_testsecret");
      },
      audit,
    );
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /testsecret/);
    await handleRpc({ jsonrpc: "2.0", id: 4, method: "tools/list" }, async () => ({}), audit);
    const rows = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].outcome, "ok");
    assert.equal(rows[0].tool, "pisces_health");
    assert.equal(rows[0].args.endpointId, "local");
    assert.deepEqual(rows[0].client, { name: "tester", version: "1" });
    assert.equal(rows[1].outcome, "error");
    assert.equal(rows[1].args.token, "[REDACTED]");
    assert.equal(rows[1].error, "boom [REDACTED]");
    assert.equal(fs.readFileSync(logPath, "utf8").includes("testsecret"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stdio server talks to Pisces", async () => {
  const seen = [];
  function json(res, status, payload) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(payload));
  }
  const api = createServer(async (req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization ?? "" });
    const url = req.url ?? "";
    if (url === "/api/health") {
      json(res, 200, { ok: true });
      return;
    }
    if (url === "/api/endpoints") {
      json(res, 200, [{ id: "local", name: "local", kind: "docker" }]);
      return;
    }
    if (url.startsWith("/api/endpoints/local/containers/abc/start") && req.method === "POST") {
      json(res, 202, { id: "prp_9", status: "pending", action: "start", expiresAt: 1234 });
      return;
    }
    json(res, 500, { error: { message: `unexpected ${req.method} ${url}` } });
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${api.address().port}`;

  const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), "pisces-mcp-stdio-"));
  const client = mcpClient(base, auditDir);
  try {
    const init = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    assert.equal(init.result.serverInfo.name, "pisces-ai");
    client.notify("notifications/initialized");
    const listed = await client.request("tools/list");
    assert.ok(listed.result.tools.some((tool) => tool.name === "pisces_container_start"));

    const health = JSON.parse(await tool(client, "pisces_health", {}));
    assert.equal(health.ok, true);

    const endpoints = JSON.parse(await tool(client, "pisces_endpoints_list", {}));
    assert.equal(endpoints[0].id, "local");

    const proposal = JSON.parse(
      await tool(client, "pisces_container_start", { endpointId: "local", containerId: "abc" }),
    );
    assert.equal(proposal.proposalId, "prp_9");
    assert.match(seen[0].auth, /^Bearer pisces_agent_/);
  } finally {
    await client.stop();
    api.close();
    fs.rmSync(auditDir, { recursive: true, force: true });
  }
});

function mcpClient(baseUrl, auditDir) {
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PISCES_API_URL: baseUrl,
      PISCES_AGENT_CREDENTIAL: "pisces_agent_test",
      PISCES_MCP_AUDIT_LOG: path.join(auditDir, "audit.jsonl"),
      PISCES_MCP_AUDIT_CONFIG: path.join(auditDir, "missing.json"),
      PISCES_MCP_AUDIT_RETENTION_DAYS: "30",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  const waiters = new Map();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    out += chunk;
    let nl;
    while ((nl = out.indexOf("\n")) >= 0) {
      const line = out.slice(0, nl).trim();
      out = out.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const waiter = waiters.get(msg.id);
      if (!waiter) continue;
      waiters.delete(msg.id);
      waiter(msg);
    }
  });
  child.stderr.on("data", (chunk) => {
    err += chunk;
  });
  let next = 1;
  return {
    request(method, params) {
      const id = next++;
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new Error(`timed out on ${method}\nstderr: ${err}`));
        }, 5000);
        waiters.set(id, (msg) => {
          clearTimeout(timer);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg);
        });
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return response;
    },
    notify(method) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    },
    async stop() {
      child.kill();
      await Promise.race([
        once(child, "exit").catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    },
  };
}

async function tool(client, name, args) {
  const response = await client.request("tools/call", { name, arguments: args });
  assert.notEqual(response.result.isError, true, response.result?.content?.[0]?.text);
  return response.result.content[0].text;
}