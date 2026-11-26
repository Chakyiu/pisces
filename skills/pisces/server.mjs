#!/usr/bin/env node
// Stdio MCP server for the Pisces agent API (proposals, redacted reads). No npm packages.
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { noteClient, openAudit, writeToolAudit } from "../mcp-audit.mjs";

const DEFAULT_BASE = "http://127.0.0.1:8787";
const AGENT_PREFIX = "pisces_agent_";
const MAX_TEXT = 48 * 1024;
const SUPPORTED_PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18"];

const endpointProp = {
  type: "string",
  description: "Pisces endpoint id from pisces_endpoints_list.",
};

const containerProp = {
  type: "string",
  description: "Container name or id.",
};

export const TOOLS = [
  {
    name: "pisces_health",
    description: "Confirm the Pisces API is reachable.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pisces_endpoints_list",
    description: "List Docker endpoints registered in Pisces.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pisces_endpoint_overview",
    description: "Summary counts for one endpoint.",
    inputSchema: {
      type: "object",
      properties: { endpointId: endpointProp },
      required: ["endpointId"],
    },
  },
  {
    name: "pisces_container_list",
    description:
      "List containers visible to the agent credential. Policy may hide rows or fields.",
    inputSchema: {
      type: "object",
      properties: {
        endpointId: endpointProp,
        q: { type: "string", description: "Optional name filter." },
        state: {
          type: "string",
          enum: ["", "running", "stopped"],
          description: "Filter by state.",
        },
        limit: {
          type: "integer",
          description: "Page size, 1 to 50. Defaults to 50.",
        },
      },
      required: ["endpointId"],
    },
  },
  {
    name: "pisces_container_get",
    description: "Inspect one container under the agent redaction rules.",
    inputSchema: {
      type: "object",
      properties: { endpointId: endpointProp, containerId: containerProp },
      required: ["endpointId", "containerId"],
    },
  },
  {
    name: "pisces_container_logs",
    description: "Tail container logs when policy allows.",
    inputSchema: {
      type: "object",
      properties: {
        endpointId: endpointProp,
        containerId: containerProp,
        tail: {
          type: "integer",
          description: "Last N lines, 1 to 2000. Defaults to 200.",
        },
      },
      required: ["endpointId", "containerId"],
    },
  },
  {
    name: "pisces_container_start",
    description: "Request start; creates a proposal the operator must confirm.",
    inputSchema: {
      type: "object",
      properties: { endpointId: endpointProp, containerId: containerProp },
      required: ["endpointId", "containerId"],
    },
  },
  {
    name: "pisces_container_stop",
    description: "Request stop; creates a proposal the operator must confirm.",
    inputSchema: {
      type: "object",
      properties: { endpointId: endpointProp, containerId: containerProp },
      required: ["endpointId", "containerId"],
    },
  },
  {
    name: "pisces_container_restart",
    description: "Request restart; creates a proposal the operator must confirm.",
    inputSchema: {
      type: "object",
      properties: { endpointId: endpointProp, containerId: containerProp },
      required: ["endpointId", "containerId"],
    },
  },
];

export function resolveBaseUrl(env = process.env) {
  const raw = env.PISCES_API_URL?.trim() || DEFAULT_BASE;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PISCES_API_URL must be an absolute http or https URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PISCES_API_URL must be http or https");
  }
  return url;
}

export function resolveCredential(env = process.env) {
  const token = env.PISCES_AGENT_CREDENTIAL?.trim();
  if (!token) {
    throw new Error("Set PISCES_AGENT_CREDENTIAL to the pisces_agent_… secret from AI Access");
  }
  if (!token.startsWith(AGENT_PREFIX)) {
    throw new Error("PISCES_AGENT_CREDENTIAL must start with pisces_agent_");
  }
  if (/[\r\n]/.test(token)) {
    throw new Error("PISCES_AGENT_CREDENTIAL must be a single line");
  }
  return token;
}

export function assertSegment(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  const text = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text) && !/^[a-f0-9]{12,64}$/i.test(text)) {
    throw new Error(`${label} is not valid`);
  }
  if (text.includes("..") || text.includes("/") || text.includes("\\")) {
    throw new Error(`${label} is not valid`);
  }
  return text;
}

function tailCount(value) {
  if (value == null) return "200";
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 2000) {
    throw new Error("tail must be an integer from 1 to 2000");
  }
  return String(number);
}

function limitCount(value) {
  if (value == null) return "50";
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 50) {
    throw new Error("limit must be an integer from 1 to 50");
  }
  return String(number);
}

export function parseApiError(status, body) {
  const text = body.toString("utf8").trim();
  if (!text) return `Pisces API ${status}`;
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message;
    if (typeof message === "string" && message.trim()) {
      return `Pisces API ${status}: ${message.trim()}`;
    }
  } catch {
    // plain text
  }
  return `Pisces API ${status}: ${text.slice(0, 500)}`;
}

export function piscesRequest(baseUrl, token, spec) {
  const target = new URL(spec.path, baseUrl);
  if (spec.query) {
    for (const [key, value] of Object.entries(spec.query)) {
      if (value != null && value !== "") target.searchParams.set(key, String(value));
    }
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  let payload;
  if (spec.json != null) {
    payload = JSON.stringify(spec.json);
    headers["Content-Type"] = "application/json";
  }
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      target,
      { method: spec.method, headers, timeout: spec.timeoutMs ?? 60_000 },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          const status = res.statusCode ?? 500;
          if (status >= 400) {
            reject(new Error(parseApiError(status, body)));
            return;
          }
          if (spec.raw) {
            resolve(body);
            return;
          }
          if (!body.length) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(body.toString("utf8")));
          } catch {
            reject(new Error(`Pisces API ${status} returned non-JSON`));
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("Pisces API request timed out"));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export function makeClient(baseUrl, token) {
  return (spec) => piscesRequest(baseUrl, token, spec);
}

export async function dispatch(request, name, args = {}) {
  switch (name) {
    case "pisces_health":
      return await request({ method: "GET", path: "/api/health" });
    case "pisces_endpoints_list":
      return await request({ method: "GET", path: "/api/endpoints" });
    case "pisces_endpoint_overview": {
      const endpointId = assertSegment(args.endpointId, "endpointId");
      return await request({ method: "GET", path: `/api/endpoints/${encodeURIComponent(endpointId)}/overview` });
    }
    case "pisces_container_list": {
      const endpointId = assertSegment(args.endpointId, "endpointId");
      const query = { limit: limitCount(args.limit), state: args.state ?? "", q: args.q ?? "" };
      return await request({
        method: "GET",
        path: `/api/endpoints/${encodeURIComponent(endpointId)}/containers`,
        query,
      });
    }
    case "pisces_container_get": {
      const endpointId = assertSegment(args.endpointId, "endpointId");
      const containerId = assertSegment(args.containerId, "containerId");
      return await request({
        method: "GET",
        path: `/api/endpoints/${encodeURIComponent(endpointId)}/containers/${encodeURIComponent(containerId)}`,
      });
    }
    case "pisces_container_logs": {
      const endpointId = assertSegment(args.endpointId, "endpointId");
      const containerId = assertSegment(args.containerId, "containerId");
      const body = await request({
        method: "GET",
        path: `/api/endpoints/${encodeURIComponent(endpointId)}/containers/${encodeURIComponent(containerId)}/logs`,
        query: { tail: tailCount(args.tail) },
      });
      const lines = Array.isArray(body?.lines)
        ? body.lines.map((line) => {
            const time = line?.time ? `[${line.time}] ` : "";
            const stream = line?.stream ? `${line.stream} ` : "";
            return `${time}${stream}${line?.text ?? ""}`;
          })
        : [];
      return lines.join("\n");
    }
    case "pisces_container_start":
    case "pisces_container_stop":
    case "pisces_container_restart": {
      const endpointId = assertSegment(args.endpointId, "endpointId");
      const containerId = assertSegment(args.containerId, "containerId");
      const action = name.slice("pisces_container_".length);
      const proposal = await request({
        method: "POST",
        path: `/api/endpoints/${encodeURIComponent(endpointId)}/containers/${encodeURIComponent(containerId)}/${action}`,
      });
      return {
        proposalId: proposal?.id ?? null,
        status: proposal?.status ?? "pending",
        action: proposal?.action ?? action,
        expiresAt: proposal?.expiresAt ?? null,
        message:
          "Queued for operator confirmation in Pisces. The change does not run until they approve.",
      };
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

export async function handleRpc(message, request, audit = null) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
  }
  const { id, method, params } = message;
  if (typeof method !== "string") {
    if (id == null) return null;
    return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request" } };
  }
  if (method.startsWith("notifications/")) return null;
  if (method === "initialize") {
    noteClient(audit, params?.clientInfo);
    const requested = params?.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : "2024-11-05";
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "pisces-ai", version: "0.1.0" },
        instructions:
          "Pisces agent API with proposal queue. Mutations return pending proposals; an operator confirms in the UI.",
      },
    };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (method === "tools/call") {
    const name = params?.name;
    const toolArgs =
      params?.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
        ? params.arguments
        : {};
    const startedAtMs = Date.now();
    if (typeof name !== "string" || !name) {
      const message = "tools/call needs a tool name";
      writeToolAudit(audit, { tool: "", args: toolArgs, startedAtMs, outcome: "error", error: message });
      return toolError(id, message);
    }
    try {
      const value = await dispatch(request, name, toolArgs);
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      writeToolAudit(audit, { tool: name, args: toolArgs, startedAtMs, outcome: "ok", error: null });
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: clip(text) }] },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeToolAudit(audit, { tool: name, args: toolArgs, startedAtMs, outcome: "error", error: message });
      return toolError(id, message);
    }
  }
  if (id == null) return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

function toolError(id, text) {
  return {
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text }], isError: true },
  };
}

function clip(text) {
  if (text.length <= MAX_TEXT) return text;
  return `${text.slice(0, MAX_TEXT)}\n… truncated ${text.length - MAX_TEXT} bytes`;
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function onLine(line, request, audit) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  const response = await handleRpc(message, request, audit);
  if (response) writeMessage(response);
}

function main() {
  const baseUrl = resolveBaseUrl();
  const token = resolveCredential();
  const request = makeClient(baseUrl, token);
  const audit = openAudit(process.env, "pisces", [token]);
  let buffer = "";
  let chain = Promise.resolve();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) break;
      const line = buffer.slice(0, nl).replace(/\r$/, "").trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      chain = chain.then(() => onLine(line, request, audit)).catch((err) => {
        process.stderr.write(`pisces-mcp: ${err.message}\n`);
      });
    }
  });
  process.stdin.on("end", () => {
    chain.finally(() => process.exit(0));
  });
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  const left = path.resolve(entry);
  const right = path.resolve(fileURLToPath(import.meta.url));
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

if (isDirectRun()) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`pisces-mcp: ${err.message}\n`);
    process.exit(1);
  }
}