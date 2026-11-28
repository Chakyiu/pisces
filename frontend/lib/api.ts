const ENGINE_DOWN =
  "The engine did not answer within 10 seconds. Nothing on this page was changed.";
const API_DOWN =
  "The Pisces API did not answer within 10 seconds. Nothing on this page was changed.";

function fallbackMessage(path: string, failureMessage?: string) {
  if (failureMessage) return failureMessage;
  if (path === "/api/session" || path.startsWith("/api/session?")) return API_DOWN;
  return ENGINE_DOWN;
}

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
  timeoutMs?: number;
  failureMessage?: string;
};

export async function api<T>(path: string, options: Options = {}): Promise<T> {
  const ctrl = new AbortController();
  const timeoutMs = options.timeoutMs ?? 10_000;
  // Abort alone does not always reject a fetch whose body never ends. The
  // timer rejects on its own so Update cannot stay on "Updating…".
  let finished = false;
  let rejectTimed: ((error: ApiError) => void) | undefined;
  const timed = new Promise<never>((_, reject) => {
    rejectTimed = reject;
  });
  void timed.catch(() => {});
  const fail = (error: ApiError) => {
    if (finished) return;
    finished = true;
    ctrl.abort();
    rejectTimed?.(error);
  };
  const timer = setTimeout(() => {
    fail(new ApiError("daemon_unreachable", fallbackMessage(path, options.failureMessage), true));
  }, timeoutMs);
  const onParentAbort = () => fail(new ApiError("cancelled", "cancelled", false));
  options.signal?.addEventListener("abort", onParentAbort);

  const attempt = (async (): Promise<T> => {
    try {
      const res = await fetch(path, {
        method: options.method ?? "GET",
        credentials: "include",
        cache: "no-store",
        headers: options.body ? { "content-type": "application/json" } : undefined,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: ctrl.signal,
      });
      if (finished) throw new ApiError("daemon_unreachable", fallbackMessage(path, options.failureMessage), true);
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      if (finished) throw new ApiError("daemon_unreachable", fallbackMessage(path, options.failureMessage), true);
      const data = text ? (JSON.parse(text) as { error?: { code?: string; message?: string; retryable?: boolean } }) : {};
      if (res.status === 401) {
        const message = data.error?.message ?? "Sign in required.";
        if (!options.allow401) onUnauthorized(message);
        throw new ApiError("unauthorized", message, false);
      }
      if (!res.ok) {
        throw new ApiError(
          data.error?.code ?? "daemon_unreachable",
          data.error?.message ?? fallbackMessage(path),
          Boolean(data.error?.retryable),
        );
      }
      return data as T;
    } catch (err) {
      if (finished) {
        throw err instanceof ApiError
          ? err
          : new ApiError("daemon_unreachable", fallbackMessage(path, options.failureMessage), true);
      }
      if (err instanceof ApiError) throw err;
      if (options.signal?.aborted) throw new ApiError("cancelled", "cancelled", false);
      throw new ApiError("daemon_unreachable", fallbackMessage(path, options.failureMessage), true);
    }
  })();
  void attempt.catch(() => {});

  try {
    return await Promise.race([attempt, timed]);
  } finally {
    finished = true;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onParentAbort);
  }
}
