const ENGINE_DOWN =
  "The engine did not answer within 10 seconds. Nothing on this page was changed.";

export class ApiError extends Error {
  code: string;
  retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.retryable = retryable;
  }
}

let onUnauthorized: (message: string) => void = () => {};

export function setUnauthorizedHandler(handler: (message: string) => void) {
  onUnauthorized = handler;
}

type Options = {
  method?: string;
  body?: unknown;
  allow401?: boolean;
  signal?: AbortSignal;
};

export async function api<T>(path: string, options: Options = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  const onParentAbort = () => ctrl.abort();
  options.signal?.addEventListener("abort", onParentAbort);
  try {
    const res = await fetch(path, {
      method: options.method ?? "GET",
      credentials: "include",
      cache: "no-store",
      headers: options.body ? { "content-type": "application/json" } : undefined,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: ctrl.signal,
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const data = text ? (JSON.parse(text) as { error?: { code?: string; message?: string; retryable?: boolean } }) : {};
    if (res.status === 401) {
      const message = data.error?.message ?? "Sign in required.";
      if (!options.allow401) onUnauthorized(message);
      throw new ApiError("unauthorized", message, false);
    }
    if (!res.ok) {
      throw new ApiError(
        data.error?.code ?? "daemon_unreachable",
        data.error?.message ?? ENGINE_DOWN,
        Boolean(data.error?.retryable),
      );
    }
    return data as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (options.signal?.aborted) throw new ApiError("cancelled", "cancelled", false);
    throw new ApiError("daemon_unreachable", ENGINE_DOWN, true);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onParentAbort);
  }
}
