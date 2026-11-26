import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendAudit,
  noteClient,
  openAudit,
  redactArgs,
  resolveAuditConfig,
  writeToolAudit,
} from "./mcp-audit.mjs";

const DAY_MS = 86_400_000;

test("audit config defaults to 30 days and lets env override the file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pisces-audit-cfg-"));
  try {
    const missing = path.join(dir, "missing.json");
    const defaults = resolveAuditConfig({ PISCES_MCP_AUDIT_CONFIG: missing }, "pisces");
    assert.equal(defaults.retentionDays, 30);
    assert.equal(defaults.logPath, path.join(os.homedir(), ".pisces", "mcp-audit", "pisces.jsonl"));

    const configPath = path.join(dir, "mcp-audit.json");
    const fileLog = path.join(dir, "from-file.jsonl");
    fs.writeFileSync(configPath, JSON.stringify({ retentionDays: 7, logPath: fileLog }));
    const fromFile = resolveAuditConfig({ PISCES_MCP_AUDIT_CONFIG: configPath }, "docker");
    assert.equal(fromFile.retentionDays, 7);
    assert.equal(fromFile.logPath, path.resolve(fileLog));

    const fromEnv = resolveAuditConfig(
      {
        PISCES_MCP_AUDIT_CONFIG: configPath,
        PISCES_MCP_AUDIT_RETENTION_DAYS: "1",
        PISCES_MCP_AUDIT_LOG: path.join(dir, "from-env.jsonl"),
      },
      "pisces",
    );
    assert.equal(fromEnv.retentionDays, 1);
    assert.equal(fromEnv.logPath, path.resolve(path.join(dir, "from-env.jsonl")));

    fs.writeFileSync(configPath, "{");
    assert.throws(() => resolveAuditConfig({ PISCES_MCP_AUDIT_CONFIG: configPath }, "pisces"), /not JSON/);
    assert.throws(
      () =>
        resolveAuditConfig(
          { PISCES_MCP_AUDIT_CONFIG: missing, PISCES_MCP_AUDIT_RETENTION_DAYS: "nope" },
          "pisces",
        ),
      /retentionDays/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("redactArgs hides secret keys, agent tokens, and secret env values", () => {
  const out = redactArgs(
    {
      endpointId: "local",
      token: "pisces_agent_abc",
      nested: { password: "x" },
      env: ["PATH=/bin", "API_TOKEN=sekrit", "NOTE=pisces_agent_abc"],
      q: "hello pisces_agent_zzz",
    },
    ["pisces_agent_abc"],
  );
  assert.equal(out.endpointId, "local");
  assert.equal(out.token, "[REDACTED]");
  assert.equal(out.nested.password, "[REDACTED]");
  assert.deepEqual(out.env, ["PATH=/bin", "API_TOKEN=[REDACTED]", "NOTE=[REDACTED]"]);
  assert.equal(out.q, "hello [REDACTED]");
});

test("appendAudit drops lines older than retention and broken lines", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pisces-audit-purge-"));
  const logPath = path.join(dir, "audit.jsonl");
  const now = Date.parse("2026-11-26T00:00:00.000Z");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      logPath,
      [
        JSON.stringify({ tool: "old", finishedAt: new Date(now - 31 * DAY_MS).toISOString() }),
        JSON.stringify({ tool: "recent", finishedAt: new Date(now - DAY_MS).toISOString() }),
        "not json",
        "",
      ].join("\n"),
    );
    appendAudit(logPath, { tool: "new", finishedAt: new Date(now).toISOString() }, 30, now);
    assert.deepEqual(readTools(logPath), ["recent", "new"]);

    const later = now + 1;
    appendAudit(logPath, { tool: "latest", finishedAt: new Date(later).toISOString() }, 0, later);
    assert.deepEqual(readTools(logPath), ["latest"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeToolAudit records the call without the credential", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pisces-audit-write-"));
  const logPath = path.join(dir, "pisces.jsonl");
  try {
    const audit = openAudit(
      {
        PISCES_MCP_AUDIT_LOG: logPath,
        PISCES_MCP_AUDIT_CONFIG: path.join(dir, "missing.json"),
        PISCES_MCP_AUDIT_RETENTION_DAYS: "30",
      },
      "pisces",
      ["pisces_agent_testsecret"],
    );
    noteClient(audit, { name: "tester", version: "1", token: "do-not-keep" });
    writeToolAudit(audit, {
      tool: "pisces_health",
      args: { token: "pisces_agent_testsecret", endpointId: "local" },
      startedAtMs: Date.now() - 5,
      outcome: "error",
      error: "boom pisces_agent_testsecret",
    });
    const row = JSON.parse(fs.readFileSync(logPath, "utf8"));
    assert.equal(row.server, "pisces");
    assert.equal(row.tool, "pisces_health");
    assert.equal(row.outcome, "error");
    assert.equal(row.args.token, "[REDACTED]");
    assert.equal(row.args.endpointId, "local");
    assert.equal(row.error, "boom [REDACTED]");
    assert.deepEqual(row.client, { name: "tester", version: "1" });
    assert.equal(typeof row.startedAt, "string");
    assert.equal(typeof row.finishedAt, "string");
    assert.equal(Number.isInteger(row.durationMs), true);
    assert.equal(fs.readFileSync(logPath, "utf8").includes("testsecret"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function readTools(logPath) {
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line).tool);
}
