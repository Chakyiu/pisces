import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

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

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  };
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
export const DELETE = proxy;
