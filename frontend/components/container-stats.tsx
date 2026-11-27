"use client";

import { useEffect, useState } from "react";
import { bytes } from "../lib/format";

type Sample = {
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
};

type Rates = { rx: number; tx: number };

export function ContainerStats({
  endpointId,
  containerId,
}: {
  endpointId: string;
  containerId: string;
}) {
  const [sample, setSample] = useState<Sample | null>(null);
  const [rates, setRates] = useState<Rates | null>(null);
  const [status, setStatus] = useState<"loading" | "live" | "ended" | "error">("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const ctrl = new AbortController();
    let closed = false;
    let previous: { sample: Sample; at: number } | null = null;
    setSample(null);
    setRates(null);
    setStatus("loading");
    setMessage("");
    void readStats(
      `/api/endpoints/${encodeURIComponent(endpointId)}/containers/${encodeURIComponent(containerId)}/stats/stream`,
      ctrl.signal,
      (next) => {
        if (closed) return;
        const now = Date.now();
        if (previous) {
          const elapsed = (now - previous.at) / 1000;
          if (elapsed >= 0.2) {
            setRates({
              rx: Math.max(0, (next.networkRxBytes - previous.sample.networkRxBytes) / elapsed),
              tx: Math.max(0, (next.networkTxBytes - previous.sample.networkTxBytes) / elapsed),
            });
          }
        }
        previous = { sample: next, at: now };
        setSample(next);
        setStatus("live");
      },
      (text) => {
        if (closed) return;
        setMessage(text);
        setStatus("error");
      },
    ).then(() => {
      if (closed) return;
      setStatus((current) => (current === "error" ? "error" : "ended"));
    });
    return () => {
      closed = true;
      ctrl.abort();
    };
  }, [endpointId, containerId]);

  const memory = !sample
    ? "—"
    : sample.memoryLimitBytes > 0
      ? `${bytes(sample.memoryBytes)} / ${bytes(sample.memoryLimitBytes)} · ${((sample.memoryBytes / sample.memoryLimitBytes) * 100).toFixed(1)}%`
      : bytes(sample.memoryBytes);

  return (
    <section className="widget" id="container-stats" aria-label="Container stats">
      <h2>Stats</h2>
      <p className="note" role={status === "error" ? "alert" : "status"} style={{ margin: "8px 16px" }}>
        {status === "loading" ? "Waiting for the first sample…" : null}
        {status === "live" ? "Live — CPU, memory, and network update about once a second." : null}
        {status === "ended" ? "Stats ended — the container stopped or was removed." : null}
        {status === "error" ? message || "The stats stream ended." : null}
      </p>
      <div className="facts">
        <Fact label="CPU" value={sample ? `${sample.cpuPercent.toFixed(1)}%` : "—"} />
        <Fact label="Memory" value={memory} />
        <Fact label="Network in" value={sample ? traffic(sample.networkRxBytes, rates?.rx) : "—"} />
        <Fact label="Network out" value={sample ? traffic(sample.networkTxBytes, rates?.tx) : "—"} />
      </div>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="fact">
      <span>{label}</span>
      <strong className="mono" title={value}>{value}</strong>
    </div>
  );
}

function traffic(total: number, rate?: number): string {
  if (rate == null) return bytes(total);
  return `${bytes(total)} · ${perSecond(rate)}`;
}

function perSecond(value: number): string {
  if (value < 1) return "0 B/s";
  if (value < 1024) return `${Math.round(value)} B/s`;
  return `${bytes(value)}/s`;
}

// Same NDJSON follow as logs. `api()` aborts after 10 seconds, so this uses fetch directly.
async function readStats(
  path: string,
  signal: AbortSignal,
  onSample: (sample: Sample) => void,
  onError: (message: string) => void,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "include", cache: "no-store", signal });
  } catch {
    if (!signal.aborted) onError("The stats stream did not start.");
    return;
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    let message = "The stats stream did not start.";
    try {
      const body = JSON.parse(text) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // Not an error envelope; keep the generic message.
    }
    if (!signal.aborted) onError(message);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const handle = (raw: string): boolean => {
    if (!raw.trim()) return true;
    let event: { error?: boolean; message?: string } & Partial<Sample>;
    try {
      event = JSON.parse(raw);
    } catch {
      return true;
    }
    if (event.error) {
      if (!signal.aborted) onError(event.message ?? "The stats stream ended.");
      return false;
    }
    onSample({
      cpuPercent: event.cpuPercent ?? 0,
      memoryBytes: event.memoryBytes ?? 0,
      memoryLimitBytes: event.memoryLimitBytes ?? 0,
      networkRxBytes: event.networkRxBytes ?? 0,
      networkTxBytes: event.networkTxBytes ?? 0,
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
    if (!signal.aborted) onError("The stats stream ended unexpectedly.");
  }
}
