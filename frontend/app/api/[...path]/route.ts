import { NextRequest } from "next/server";
import { Agent } from "undici";
import { proxyTimeoutMs } from "../../../lib/proxy-budget";

export const dynamic = "force-dynamic";

// Node's fetch kills a response body after 5 minutes of silence, and a followed
// container is often quieter than that. Following gets its own dispatcher with
// both timeouts off; req.signal still ends it when the browser lets go.
const followDispatcher = new Agent({ bodyTimeout: 0, headersTimeout: 0 });

const API_DOWN = {
  error: {
    code: "daemon_unreachable",
    message: "The API did not answer within 10 seconds. Nothing on this page was changed.",
    retryable: true,
  },
};

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const base = process.env.PISCES_API_URL ?? "http://127.0.0.1:8787";
  const target = `${base}/api/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`;
  const headers = new Headers();
  const cookie = req.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  // An agent call can reach the API through this proxy too. The credential is
  // forwarded, never logged (nothing here logs headers).
  const authorization = req.headers.get("authorization");
  if (authorization) headers.set("authorization", authorization);
  // The Rust side compares Origin against Host for same-origin-only endpoints.
  // Behind this proxy the upstream Host is the loopback address, so the browser
  // host travels in x-forwarded-host.
  const origin = req.headers.get("origin");
  if (origin) headers.set("origin", origin);
  const host = req.headers.get("host");
  if (host) headers.set("x-forwarded-host", host);

  const pathname = `/${path.join("/")}`;
  const timeoutMs = proxyTimeoutMs(req.method, pathname);

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
  };
  if (timeoutMs === null) {
    // Tie the upstream stream to this request: when the browser aborts (Follow
    // off, navigation away) the Rust side must see the connection close too,
    // instead of following a container nobody is watching.
    init.signal = req.signal;
    (init as RequestInit & { dispatcher: Agent }).dispatcher = followDispatcher;
  } else {
    init.signal = AbortSignal.timeout(timeoutMs);
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch {
    return Response.json(API_DOWN, { status: 503 });
  }

  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    const name = key.toLowerCase();
    if (name === "set-cookie" || name === "content-length" || name === "content-encoding") return;
    out.append(key, value);
  });
  for (const setCookie of upstream.headers.getSetCookie?.() ?? []) {
    out.append("set-cookie", setCookie);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
