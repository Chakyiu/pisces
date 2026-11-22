"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ApiError, api } from "../../../../../../lib/api";
import { blank, portList, shortId, stamp } from "../../../../../../lib/format";
import type { ContainerDetail } from "../../../../../../lib/types";
import { Badge, Dialog, ErrorState, Icon, Loading } from "../../../../../../components/bits";
import { ContainerConsole } from "../../../../../../components/container-console";
import { DockerView, publishApiError } from "../../../../../../components/gate";
import { PageFrame } from "../../../../../../components/shell";

export default function ContainerDetailPage() {
  const params = useParams<{ id: string; containerId: string }>();
  const [name, setName] = useState("");
  const [reload, setReload] = useState(0);
  const crumbs = name
    ? [{ label: "Containers", href: `/e/${params.id}/containers` }, { label: name, mono: true }]
    : [{ label: "Containers" }];
  return (
    <PageFrame title="Container details" crumbs={crumbs} onRefresh={() => setReload((value) => value + 1)}>
      <DockerView noun="container">
        {(endpoint) => (
          <Body
            endpointId={endpoint.id}
            endpointName={endpoint.name}
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
  endpointName,
  containerId,
  reload,
  onName,
}: {
  endpointId: string;
  endpointName: string;
  containerId: string;
  reload: number;
  onName: (name: string) => void;
}) {
  const router = useRouter();
  const [detail, setDetail] = useState<ContainerDetail | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "missing">("loading");
  const [message, setMessage] = useState("");
  const [attempts, setAttempts] = useState(0);
  const [at, setAt] = useState<Date | undefined>();
  const [pending, setPending] = useState("");
  const [alert, setAlert] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);

  async function load(retry: boolean) {
    if (retry) setAttempts((n) => n + 1);
    setStatus("loading");
    try {
      const body = await api<ContainerDetail>(`/api/endpoints/${endpointId}/containers/${encodeURIComponent(containerId)}`);
      setDetail(body);
      setStatus("ready");
      onName(body.name);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "daemon_unreachable";
      publishApiError(code);
      setMessage(err instanceof ApiError ? err.message : "The engine did not answer within 10 seconds. Nothing on this page was changed.");
      setAt(new Date());
      setStatus(code === "not_found" ? "missing" : "error");
    }
  }

  useEffect(() => { void load(false); }, [endpointId, containerId, reload]);

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

  const isRunning = detail.state === "running" || detail.state === "restarting";
  const mounts = detail.mounts.length
    ? detail.mounts.map((mount) => `${mount.source} → ${mount.destination}${mount.mode.includes("ro") ? " ro" : ""}`).join("\n")
    : "None";
  const networks = detail.networks.length
    ? detail.networks.map((item) => `${item.name}${item.ip ? ` · ${item.ip}` : ""}`).join("\n")
    : "None";

  return (
    <div className="stack">
      {alert ? <div className="alert bad" role="alert">{alert}</div> : null}
      <section className="widget">
        <h2>Actions</h2>
        <div className="widget-pad">
          <div className="bulk">
            <button className="btn" type="button" disabled={Boolean(pending) || isRunning} onClick={() => void act("start")}>
              <Icon name="play" /> {pending === "start" ? "Starting…" : "Start"}
            </button>
            <button className="btn" type="button" disabled={Boolean(pending) || !isRunning} onClick={() => void act("stop")}>
              <Icon name="stop" /> {pending === "stop" ? "Stopping…" : "Stop"}
            </button>
            <button className="btn" type="button" disabled={Boolean(pending)} onClick={() => void act("restart")}>
              <Icon name="restart" /> {pending === "restart" ? "Restarting…" : "Restart"}
            </button>
            <button className="btn" type="button" title="Open container console" aria-expanded={consoleOpen} aria-controls="container-console" disabled={Boolean(pending) || !isRunning} onClick={() => setConsoleOpen((open) => !open)}>
              <Icon name="console" /> Console
            </button>
            <button className="btn danger" type="button" disabled={Boolean(pending)} onClick={() => setConfirm(true)}>
              <Icon name="trash" /> Remove
            </button>
          </div>
        </div>
      </section>
      {consoleOpen ? (
        <ContainerConsole
          endpointId={endpointId}
          containerId={containerId}
          running={isRunning}
          onClose={() => setConsoleOpen(false)}
        />
      ) : null}
      <section className="widget">
        <h2>Status</h2>
        <div className="facts">
          <Fact label="Name" value={detail.name} />
          <div className="fact"><span>State</span><Badge state={detail.state} /></div>
          <Fact label="Status" value={blank(detail.statusText)} />
        </div>
      </section>
      <section className="widget">
        <h2>Details</h2>
        <div className="facts">
          <Fact label="ID" value={shortId(detail.id)} title={detail.id} mono />
          <Fact label="Image" value={detail.image} mono />
          <Fact label="Command" value={blank(detail.command)} mono />
          <Fact label="Restart" value={detail.restartPolicy || "no"} />
          <Fact label="Ports" value={portList(detail.ports)} mono />
          <Fact label="Mounts" value={mounts} />
          <Fact label="Networks" value={networks} />
          <Fact label="Env" value={detail.envCount ? `${detail.envCount} hidden` : "None"} />
          <Fact label="Created" value={stamp(detail.created)} mono />
        </div>
      </section>
      {confirm ? (
        <Dialog title={`Remove ${detail.name}?`} onClose={() => setConfirm(false)}>
          <p>
            {isRunning
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
    </div>
  );
}

function Fact({ label, value, mono, title }: { label: string; value: string; mono?: boolean; title?: string }) {
  return (
    <div className="fact">
      <span>{label}</span>
      <strong className={mono ? "mono" : undefined} title={title ?? value}>{value}</strong>
    </div>
  );
}
