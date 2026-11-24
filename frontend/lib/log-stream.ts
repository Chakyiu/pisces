import type { LogLine } from "./types";

// Following logs is an NDJSON response that stays open, so it uses `fetch` read
// directly instead of `api()` — that helper aborts every call after 10 seconds.
type StreamOptions = {
  signal: AbortSignal;
  onOpen?: () => void;
  onLine: (line: LogLine) => void;
  onError: (message: string) => void;
};

export async function streamLogs(path: string, options: StreamOptions): Promise<void> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "include", cache: "no-store", signal: options.signal });
  } catch {
    if (!options.signal.aborted) options.onError("The log stream did not start.");
    return;
  }

  if (res.ok && res.body && !options.signal.aborted) options.onOpen?.();

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    let message = "The log stream did not start.";
    try {
      const body = JSON.parse(text) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // Not an error envelope; keep the generic message.
    }
    if (!options.signal.aborted) options.onError(message);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Returns false when the server sent its final error record.
  const handle = (raw: string): boolean => {
    if (!raw.trim()) return true;
    let event: { error?: boolean; message?: string } & Partial<LogLine>;
    try {
      event = JSON.parse(raw);
    } catch {
      return true;
    }
    if (event.error) {
      if (!options.signal.aborted) options.onError(event.message ?? "The log stream ended.");
      return false;
    }
    options.onLine({
      timestamp: event.timestamp ?? "",
      stream: event.stream ?? "stdout",
      text: event.text ?? "",
    });
    return true;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!handle(raw)) {
          await reader.cancel().catch(() => undefined);
          return;
        }
      }
    }
    handle(decoder.decode() + buffer);
  } catch {
    if (!options.signal.aborted) options.onError("The log stream ended unexpectedly.");
  }
}
