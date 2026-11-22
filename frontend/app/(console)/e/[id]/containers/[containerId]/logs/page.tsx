"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { ApiError, api } from "../../../../../../../lib/api";
import type { ContainerDetail, LogLine } from "../../../../../../../lib/types";
import { Icon } from "../../../../../../../components/bits";
import { DockerView } from "../../../../../../../components/gate";
import { PageFrame } from "../../../../../../../components/shell";

export default function ContainerLogsPage() {
  const params = useParams<{ id: string; containerId: string }>();
  const [name, setName] = useState("");
  const [reload, setReload] = useState(0);
  const list = `/e/${params.id}/containers`;
  const detail = `/e/${params.id}/containers/${encodeURIComponent(params.containerId)}`;
  const crumbs = name
    ? [{ label: "Containers", href: list }, { label: name, href: detail, mono: true }, { label: "Logs" }]
    : [{ label: "Containers", href: list }, { label: "Logs" }];
  return (
    <PageFrame title="Container logs" crumbs={crumbs} onRefresh={() => setReload((value) => value + 1)}>
      <DockerView noun="logs">
        {(endpoint) => (
          <Body
            endpointId={endpoint.id}
            containerId={decodeURIComponent(params.containerId)}
            reload={reload}
            onName={setName}
          />
        )}
      </DockerView>
    </PageFrame>
  );
}

function Body({
  endpointId,
  containerId,
  reload,
  onName,
}: {
  endpointId: string;
  containerId: string;
  reload: number;
  onName: (name: string) => void;
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

  useEffect(() => {
    const timer = setTimeout(() => setAppliedTail(Math.min(200, Math.max(1, tail || 1))), 300);
    return () => clearTimeout(timer);
  }, [tail]);

  useEffect(() => {
    let cancel = false;
    setStatus("loading");
    api<ContainerDetail>(`/api/endpoints/${endpointId}/containers/${encodeURIComponent(containerId)}`)
      .then((body) => { if (!cancel) onName(body.name); })
      .catch(() => undefined);
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
  }, [endpointId, containerId, appliedTail, reload, onName]);

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
    <section className="widget">
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
      </div>
    </section>
  );
}
