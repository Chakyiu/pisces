"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ApiError, api } from "../../../../../../lib/api";
import { blank, portList, shortId, stamp } from "../../../../../../lib/format";
import type { ContainerDetail, LogLine } from "../../../../../../lib/types";
import { Badge, Dialog, ErrorState, Loading } from "../../../../../../components/bits";
import { DockerView, publishApiError } from "../../../../../../components/gate";
import { useConsole } from "../../../../../../components/shell";

export default function ContainerDetailPage() {
  const params = useParams<{ id: string; containerId: string }>();
  return (
    <DockerView noun="container">
      {(endpoint) => <Body endpointId={endpoint.id} endpointName={endpoint.name} containerId={decodeURIComponent(params.containerId)} />}
    </DockerView>
  );
}

function Body({ endpointId, endpointName, containerId }: { endpointId: string; endpointName: string; containerId: string }) {
  const router = useRouter();
  const { setHeader } = useConsole();
  const [detail, setDetail] = useState<ContainerDetail | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "missing">("loading");
  const [message, setMessage] = useState("");
  const [attempts, setAttempts] = useState(0);
  const [at, setAt] = useState<Date | undefined>();
  const [logs, setLogs] = useState<LogLine[] | null>(null);
  const [logState, setLogState] = useState<"loading" | "ready" | "error">("loading");
  const [logMessage, setLogMessage] = useState("");
  const [pending, setPending] = useState("");
  const [alert, setAlert] = useState("");
  const [confirm, setConfirm] = useState(false);

  async function load(retry: boolean) {
    if (retry) setAttempts((n) => n + 1);
    setStatus("loading");
    try {
      const body = await api<ContainerDetail>(`/api/endpoints/${endpointId}/containers/${encodeURIComponent(containerId)}`);
      setDetail(body);
      setStatus("ready");
      setHeader({ crumb: "Containers", href: `/e/${endpointId}/containers`, name: body.name });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "daemon_unreachable";
      publishApiError(code);
      setMessage(err instanceof ApiError ? err.message : "The engine did not answer within 10 seconds. Nothing on this page was changed.");
      setAt(new Date());
      setStatus(code === "not_found" ? "missing" : "error");
    }
  }

  async function loadLogs() {
    setLogState("loading");
    try {
      const body = await api<{ lines: LogLine[] }>(`/api/endpoints/${endpointId}/containers/${encodeURIComponent(containerId)}/logs?tail=200`);
      setLogs(body.lines);
      setLogState("ready");
    } catch (err) {
      setLogMessage(err instanceof ApiError ? err.message : "The engine did not answer.");
      setLogState("error");
    }
  }

  useEffect(() => { void load(false); void loadLogs(); }, [endpointId, containerId]);

  async function act(action: "start" | "stop" | "restart" | "remove") {
    setPending(action);
    setAlert("");
    try {
      await api(`/api/endpoints/${endpointId}/containers/${encodeURIComponent(containerId)}${action === "remove" ? "" : `/${action}`}`, {
        method: action === "remove" ? "DELETE" : "POST",
      });
      if (action === "remove") {
        router.push(`/e/${endpointId}/containers`);
        return;
      }
      await load(false);
    } catch (err) {
      const text = err instanceof ApiError ? err.message : "The engine did not answer.";
      if (err instanceof ApiError) publishApiError(err.code);
      setAlert(`${action[0].toUpperCase()}${action.slice(1)} failed. ${text}`);
    } finally {
      setPending("");
      setConfirm(false);
    }
  }

  if (status === "loading" && !detail) return <Loading noun="container" />;
  if (status === "missing") {
    return (
      <ErrorState
        title={message || `${containerId} was not found.`}
        message="The engine answered. This container is gone."
        attempts={0}
        onRetry={() => router.push(`/e/${endpointId}/containers`)}
      />
    );
  }
  if (status === "error" || !detail) {
    return (
      <ErrorState
        title={`Docker endpoint ${endpointName} is not responding.`}
        message={message}
        attempts={attempts}
        at={at}
        onRetry={() => void load(true)}
      />
    );
  }

  const running = detail.state === "running" || detail.state === "restarting";
  return (
    <>
      <div className="row-actions">
        <button className="btn tiny" type="button" disabled={Boolean(pending)} onClick={() => void act(running ? "stop" : "start")}>
          {pending === "stop" || pending === "start" ? `${running ? "Stopping" : "Starting"}…` : running ? "Stop" : "Start"}
        </button>
        <button className="btn tiny" type="button" disabled={Boolean(pending)} onClick={() => void act("restart")}>{pending === "restart" ? "Restarting…" : "Restart"}</button>
        <button className="btn tiny danger" type="button" disabled={Boolean(pending)} onClick={() => setConfirm(true)}>Remove</button>
      </div>
      {alert ? <div className="alert bad" role="alert">{alert}</div> : null}
      <div className="detail">
        <section className="facts">
          <h2>Container</h2>
          <Fact label="Name" value={detail.name} />
          <Fact label="ID" value={shortId(detail.id)} title={detail.id} mono />
          <Fact label="Image" value={detail.image} mono />
          <div className="fact"><span>State</span><Badge state={detail.state} /></div>
          <Fact label="Status" value={blank(detail.statusText)} />
          <Fact label="Command" value={blank(detail.command)} mono />
          <Fact label="Restart" value={detail.restartPolicy || "no"} />
          <Fact label="Ports" value={portList(detail.ports)} mono />
          <Fact label="Mounts" value={detail.mounts.length ? detail.mounts.map((mount) => `${mount.source} → ${mount.destination}${mount.mode.includes("ro") ? " ro" : ""}`).join("\n") : "None"} />
          <Fact label="Networks" value={detail.networks.length ? detail.networks.map((item) => `${item.name}${item.ip ? ` · ${item.ip}` : ""}`).join("\n") : "None"} />
          <Fact label="Env" value={detail.envCount ? `${detail.envCount} hidden` : "None"} />
          <Fact label="Created" value={stamp(detail.created)} mono />
        </section>
        <section className="logs">
          <header>
            <h2>Logs · Last 200 lines</h2>
            <button className="btn tiny" type="button" onClick={() => void loadLogs()}>Reload tail</button>
          </header>
          {logState === "loading" ? <p>Loading logs</p> : null}
          {logState === "error" ? <p>Logs didn’t load. {logMessage}</p> : null}
          {logState === "ready" && logs && logs.length === 0 ? <p>This container has not written anything yet.</p> : null}
          {logState === "ready" && logs?.map((line, index) => (
            <p key={index} className={`log-line ${line.stream}`}>
              {line.timestamp ? <span className="time">{line.timestamp} </span> : null}
              <span className="stream">{line.stream}</span>
              {line.text}
            </p>
          ))}
        </section>
      </div>
      {confirm ? (
        <Dialog title={`Remove ${detail.name}?`} onClose={() => setConfirm(false)}>
          <p>
            {running
              ? `${detail.name} is running. Removing it stops it and deletes the writable layer.`
              : `${detail.name} is ${detail.state}. Removing it deletes the writable layer.`}
            {" "}Named volumes stay on {endpointName}.
          </p>
          <div className="dialog-actions">
            <button className="btn" data-focus="first" type="button" onClick={() => setConfirm(false)}>Cancel</button>
            <button className="btn danger" type="button" disabled={pending === "remove"} onClick={() => void act("remove")}>
              {pending === "remove" ? "Removing…" : "Remove"}
            </button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

function Fact({ label, value, mono, title }: { label: string; value: string; mono?: boolean; title?: string }) {
  return (
    <div className="fact">
      <span>{label}</span>
      <strong className={mono ? "mono" : undefined} title={title ?? value} style={{ fontWeight: 400, whiteSpace: "pre-wrap" }}>{value}</strong>
    </div>
  );
}
