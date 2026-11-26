// JSONL audit log for the stdio MCP servers. No npm packages.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 3650;
const DAY_MS = 86_400_000;
const SECRET_KEY = /token|password|passwd|secret|credential|authorization|api[-_]?key|bearer/i;
const AGENT_TOKEN = /pisces_agent_[A-Za-z0-9._-]+/g;

export function resolveAuditConfig(env, server) {
  if (typeof server !== "string" || !/^[a-z0-9_-]+$/.test(server)) {
    throw new Error("MCP audit server name is not valid");
  }
  const configPath =
    stringValue(env.PISCES_MCP_AUDIT_CONFIG) || path.join(os.homedir(), ".pisces", "mcp-audit.json");
  const file = readConfig(configPath);
  return {
    server,
    configPath,
    retentionDays: retentionFrom(env.PISCES_MCP_AUDIT_RETENTION_DAYS, file.retentionDays),
    logPath: resolveLogPath(env.PISCES_MCP_AUDIT_LOG, file.logPath, server),
  };
}

export function openAudit(env, server, secrets = []) {
  return {
    ...resolveAuditConfig(env, server),
    client: null,
    secrets: secrets.filter((secret) => typeof secret === "string" && secret.length >= 12),
  };
}

export function noteClient(audit, info) {
  if (!audit) return;
  if (!info || typeof info !== "object" || Array.isArray(info)) {
    audit.client = null;
    return;
  }
  const name = typeof info.name === "string" ? info.name.slice(0, 200) : "";
  const version = typeof info.version === "string" ? info.version.slice(0, 80) : "";
  audit.client = name || version ? { name, version } : null;
}

export function redactArgs(value, secrets = []) {
  return walk(value, "");

  function walk(node, key) {
    if (key && SECRET_KEY.test(key)) return "[REDACTED]";
    if (typeof node === "string") return redactText(node, secrets);
    if (Array.isArray(node)) return node.map((item) => walk(item, ""));
    if (node && typeof node === "object") {
      const out = {};
      for (const [childKey, child] of Object.entries(node)) out[childKey] = walk(child, childKey);
      return out;
    }
    return node;
  }
}

export function redactText(text, secrets = []) {
  const env = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(text);
  if (env && SECRET_KEY.test(env[1])) return `${env[1]}=[REDACTED]`;
  let out = text.replace(AGENT_TOKEN, "[REDACTED]");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 12 && out.includes(secret)) {
      out = out.split(secret).join("[REDACTED]");
    }
  }
  return out;
}

// shortcut: one writer per log file; two processes rewriting the same path can drop a line.
export function appendAudit(logPath, record, retentionDays, now = Date.now()) {
  const line = `${JSON.stringify(record)}\n`;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  if (!fs.existsSync(logPath)) {
    fs.appendFileSync(logPath, line);
    return;
  }
  const cutoff = now - retentionDays * DAY_MS;
  const kept = [];
  let rewrite = false;
  for (const raw of fs.readFileSync(logPath, "utf8").split("\n")) {
    const trimmed = raw.replace(/\r$/, "").trim();
    if (!trimmed) continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      rewrite = true;
      continue;
    }
    const when = Date.parse(row?.finishedAt || row?.startedAt || "");
    if (Number.isFinite(when) && when >= cutoff) kept.push(JSON.stringify(row));
    else rewrite = true;
  }
  if (!rewrite) {
    fs.appendFileSync(logPath, line);
    return;
  }
  kept.push(JSON.stringify(record));
  replaceFile(logPath, `${kept.join("\n")}\n`);
}

export function writeToolAudit(audit, event) {
  if (!audit?.logPath) return;
  const now = Date.now();
  const startedAtMs = Number.isFinite(event.startedAtMs) ? event.startedAtMs : now;
  const record = {
    id: crypto.randomUUID(),
    server: audit.server,
    tool: typeof event.tool === "string" ? event.tool : "",
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(now).toISOString(),
    durationMs: Math.max(0, now - startedAtMs),
    outcome: event.outcome === "ok" ? "ok" : "error",
    error: event.error == null ? null : redactText(String(event.error), audit.secrets),
    args: redactArgs(event.args ?? {}, audit.secrets),
    client: audit.client ?? null,
  };
  try {
    appendAudit(audit.logPath, record, audit.retentionDays, now);
  } catch (err) {
    process.stderr.write(`mcp-audit: ${err.message}\n`);
  }
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) return {};
  let text;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    throw new Error(`Cannot read MCP audit config ${configPath}: ${err.message}`);
  }
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    throw new Error(`MCP audit config ${configPath} is not JSON`);
  }
  if (!file || typeof file !== "object" || Array.isArray(file)) {
    throw new Error(`MCP audit config ${configPath} must be a JSON object`);
  }
  return file;
}

function retentionFrom(envValue, fileValue) {
  const raw = stringValue(envValue) ? envValue : (fileValue ?? DEFAULT_RETENTION_DAYS);
  const days = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(days) || days < 0 || days > MAX_RETENTION_DAYS) {
    throw new Error("MCP audit retentionDays must be an integer from 0 to 3650");
  }
  return days;
}

function resolveLogPath(envValue, fileValue, server) {
  const raw = stringValue(envValue) || (typeof fileValue === "string" ? fileValue.trim() : "");
  if (raw) return path.resolve(raw);
  return path.join(os.homedir(), ".pisces", "mcp-audit", `${server}.jsonl`);
}

function replaceFile(logPath, body) {
  const tmp = `${logPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body);
  try {
    if (process.platform === "win32" && fs.existsSync(logPath)) fs.rmSync(logPath, { force: true });
    fs.renameSync(tmp, logPath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(logPath, body);
    if (!fs.existsSync(logPath)) throw err;
  }
}
