"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../lib/api";
import { streamLogs } from "../lib/log-stream";
import type { ContainerDetail, LogLine } from "../lib/types";
import { Icon } from "./bits";

export const CONTAINER_LOGS_SECTION_ID = "container-logs";

export function ContainerLogs({
  endpointId,
  containerId,
  reload,
  onName,
  defaultFollow = false,
  sectionId = CONTAINER_LOGS_SECTION_ID,
}: {
  endpointId: string;
  containerId: string;
  reload: number;
  onName?: (name: string) => void;
  defaultFollow?: boolean;
  sectionId?: string;
}) {
  const [lines, setLines] = useState<LogLine[] | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [wrap, setWrap] = useState(true);
  const [stamps, setStamps] = useState(true);
  const [q, setQ] = useState("");
  const [tail, setTail] = useState(200);
  const [appliedTail, setAppliedTail] = useState(200);
  const [copied, setCopied] = useState("");
  const [follow, setFollow] = useState(defaultFollow);
  const [followState, setFollowState] = useState<"live" | "ended" | "error">("live");
  const [followMessage, setFollowMessage] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setAppliedTail(Math.min(200, Math.max(1, tail || 1))), 300);
    return () => clearTimeout(timer);
  }, [tail]);

  useEffect(() => {
    let cancel = false;
    api<ContainerDetail>(`/api/endpoints/${endpointId}/containers/${encodeURIComponent(containerId)}`)
      .then((body) => { if (!cancel) onName?.(body.name); })
      .catch(() => undefined);
    return () => { cancel = true; };
  }, [endpointId, containerId, reload, onName]);

  useEffect(() => {
    // While following, the stream owns the pane: a reload must not replace the
    // lines it has been appending with a fresh one-shot snapshot.
    if (follow) return;
    let cancel = false;
    setStatus("loading");
    api<{ lines: LogLine[] }>(`/api/endpoints/${endpointId}/containers/${encodeURIComponent(containerId)}/logs?tail=${appliedTail}`)
      .then((body) => {
        if (cancel) return;
        setLines(body.lines);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancel) return;
        setMessage(err instanceof ApiError ? err.message : "The engine did not answer.");
        setStatus("error");
      });
    return () => { cancel = true; };
  }, [endpointId, containerId, appliedTail, reload, follow]);

  useEffect(() => {
    if (!follow) return;
    const ctrl = new AbortController();
    let closed = false;
    let queued: LogLine[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let opened: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      if (closed || queued.length === 0) return;
      const next = queued;
      queued = [];
      setStatus("ready");
      setLines((prev) => {
        const merged = [...(prev ?? []), ...next];
        return merged.length > 2000 ? merged.slice(-2000) : merged;
      });
    };
    const reveal = () => {
      if (closed) return;
      setStatus("ready");
      setLines((prev) => prev ?? []);
    };
    setLines(null);
    setStatus("loading");
    setFollowState("live");
    setFollowMessage("");
    // tail matches the Lines control. Docker sends that history, then keeps the
    // socket open, so follow starts with context instead of an empty pane.
    void streamLogs(
      `/api/endpoints/${endpointId}/containers/${encodeURIComponent(containerId)}/logs/stream?tail=${appliedTail}`,
      {
        signal: ctrl.signal,
        onOpen: () => {
          if (closed) return;
          opened = setTimeout(reveal, 300);
        },
        onLine: (line) => {
          queued.push(line);
          if (!timer) timer = setTimeout(flush, 200);
        },
        onError: (text) => {
          if (closed) return;
          flush();
          setFollowMessage(text);
          setFollowState("error");
          reveal();
        },
      },
    ).then(() => {
      if (closed) return;
      flush();
      setFollowState((state) => (state === "error" ? "error" : "ended"));
      reveal();
    });
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (opened) clearTimeout(opened);
      ctrl.abort();
    };
  }, [follow, endpointId, containerId, appliedTail, reload]);

  useEffect(() => {
    if (follow) endRef.current?.scrollIntoView({ block: "nearest" });
  }, [lines, follow]);

  const query = q.trim().toLowerCase();
  const shown = (lines ?? []).filter((line) => !query || `${line.timestamp} ${line.stream} ${line.text}`.toLowerCase().includes(query));

  async function copy() {
    const text = (lines ?? []).map((line) => `${line.timestamp ? `${line.timestamp} ` : ""}${line.stream} ${line.text}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied("Copied.");
    } catch {
      setCopied("Copy failed.");
    }
  }

  return (
    <section id={sectionId} className="widget">
      <h2><span className="widget-title"><Icon name="logs" /> Log viewer settings</span></h2>
      <div className="setting">
        <span>Wrap lines</span>
        <button className={wrap ? "switch on" : "switch"} type="button" role="switch" aria-checked={wrap} aria-label="Wrap lines" onClick={() => setWrap((value) => !value)}><i /></button>
      </div>
      <div className="setting">
        <span>Display timestamps</span>
        <button className={stamps ? "switch on" : "switch"} type="button" role="switch" aria-checked={stamps} aria-label="Display timestamps" onClick={() => setStamps((value) => !value)}><i /></button>
      </div>
      <label className="setting">
        <span>Search</span>
        <input className="field" placeholder="Filter..." value={q} onChange={(event) => setQ(event.target.value)} style={{ maxWidth: 280 }} />
      </label>
      <label className="setting">
        <span>Lines</span>
        <input className="field" type="number" min={1} max={200} value={tail} onChange={(event) => setTail(Number(event.target.value))} style={{ maxWidth: 120 }} />
      </label>
      <div className="setting">
        <span>Follow</span>
        <button className={follow ? "switch on" : "switch"} type="button" role="switch" aria-checked={follow} aria-label="Follow new log lines" onClick={() => setFollow((value) => !value)}><i /></button>
      </div>
      {follow ? (
        <p className="note" role="status" style={{ margin: "0 16px 8px" }}>
          {followState === "error"
            ? `Follow stopped: ${followMessage}`
            : followState === "ended"
              ? "Follow ended — the container stopped or was removed."
              : "Following — new lines appear as the container writes them."}
        </p>
      ) : null}
      <div className="setting">
        <span>Actions</span>
        <span>
          <button className="btn" type="button" onClick={() => void copy()}><Icon name="copy" /> Copy</button>
          {copied ? <span className="note" style={{ marginLeft: 12 }}>{copied}</span> : null}
        </span>
      </div>
      <div className={wrap ? "log-pane wrap" : "log-pane"}>
        {status === "loading" && !lines ? <p>Loading logs</p> : null}
        {status === "error" ? <p>Logs didn’t load. {message}</p> : null}
        {status === "ready" && lines && lines.length === 0 ? <p>This container has not written anything yet.</p> : null}
        {status === "ready" && lines && lines.length > 0 && shown.length === 0 ? <p>No log line matching the ‘{q}’ filter</p> : null}
        {shown.map((line, index) => (
          <p key={index} className={`log-line ${line.stream}`}>
            {stamps && line.timestamp ? <span className="time">{line.timestamp} </span> : null}
            <span className="stream">{line.stream}</span>
            {line.text}
          </p>
        ))}
        <div ref={endRef} />
      </div>
    </section>
  );
}