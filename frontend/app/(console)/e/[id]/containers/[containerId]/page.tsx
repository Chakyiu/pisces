"use client";

import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ApiError, api } from "../../../../../../lib/api";
import { blank, portList, stamp } from "../../../../../../lib/format";
import type { ContainerDetail } from "../../../../../../lib/types";
import { Badge, Dialog, ErrorState, Icon, Loading } from "../../../../../../components/bits";
import { ContainerAiAccess } from "../../../../../../components/container-ai-access";
import { ContainerConsole } from "../../../../../../components/container-console";
import { CONTAINER_LOGS_SECTION_ID, ContainerLogs } from "../../../../../../components/container-logs";
import { ContainerDuplicateDialog } from "../../../../../../components/container-duplicate-dialog";
import { ContainerSettingsDialog } from "../../../../../../components/container-settings-dialog";
import { DockerView, publishApiError } from "../../../../../../components/gate";
import { PageFrame } from "../../../../../../components/shell";

type ContainerTab = "logs" | "inspect" | "stats" | "console" | "attach";

const CONTAINER_TABS: ContainerTab[] = ["inspect", "logs", "console", "stats", "attach"];

function tabFromQuery(raw: string | null): ContainerTab | null {
  if (raw === "logs" || raw === "inspect" || raw === "stats" || raw === "console" || raw === "attach") return raw;
  if (raw === "details") return "inspect";
  return null;
}

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
  const searchParams = useSearchParams();
  const [detail, setDetail] = useState<ContainerDetail | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "missing">("loading");
  const [message, setMessage] = useState("");
  const [attempts, setAttempts] = useState(0);
  const [at, setAt] = useState<Date | undefined>();
  const [pending, setPending] = useState("");
  const [alert, setAlert] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recreateOpen, setRecreateOpen] = useState(false);
  const [tab, setTab] = useState<ContainerTab>(() => tabFromQuery(searchParams.get("tab")) ?? "inspect");
  const keptScroll = useRef<number | null>(null);

  const detailPath = `/e/${endpointId}/containers/${encodeURIComponent(containerId)}`;

  function chooseTab(next: ContainerTab) {
    keptScroll.current = window.scrollY;
    setTab(next);
    router.replace(next === "inspect" ? detailPath : `${detailPath}?tab=${next}`, { scroll: false });
  }

  function tabKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = CONTAINER_TABS.indexOf(tab);
    let next: ContainerTab;
    if (event.key === "Home") next = CONTAINER_TABS[0];
    else if (event.key === "End") next = CONTAINER_TABS[CONTAINER_TABS.length - 1];
    else if (event.key === "ArrowLeft") next = CONTAINER_TABS[Math.max(0, index - 1)];
    else next = CONTAINER_TABS[Math.min(CONTAINER_TABS.length - 1, index + 1)];
    chooseTab(next);
    document.getElementById(`container-tab-${next}`)?.focus();
  }

  useLayoutEffect(() => {
    const y = keptScroll.current;
    if (y == null) return;
    const urlTab = tabFromQuery(searchParams.get("tab")) ?? "inspect";
    if (urlTab !== tab) return;
    // Next still sets scrollTop to 0 on a search-param replace when scroll is false.
    const frame = requestAnimationFrame(() => {
      if (window.scrollY !== y) window.scrollTo(0, y);
      keptScroll.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [tab, searchParams]);

  useLayoutEffect(() => {
    if (status !== "ready") return;
    const apply = () => {
      // Old log links used #container-logs. The logs view no longer uses that id, so the hash cannot scroll the page.
      if (window.location.hash === `#${CONTAINER_LOGS_SECTION_ID}`) {
        setTab("logs");
        return;
      }
      setTab(tabFromQuery(searchParams.get("tab")) ?? "inspect");
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, [status, searchParams]);

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

  async function recreate() {
    setPending("recreate");
    setAlert("");
    setRecreateOpen(false);
    try {
      const created = await api<{ id: string; name: string }>(
        `/api/endpoints/${endpointId}/containers/${encodeURIComponent(containerId)}/recreate`,
        { method: "POST", timeoutMs: 120_000 },
      );
      // The old container is gone: replace it in history so Back does not land there.
      router.replace(`/e/${endpointId}/containers/${encodeURIComponent(created.id)}`);
    } catch (err) {
      const text = err instanceof ApiError ? err.message : "The engine did not answer.";
      if (err instanceof ApiError) publishApiError(err.code);
      setAlert(`Recreate failed. ${text}`);
    } finally {
      setPending("");
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
        retryLabel="Back to containers"
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
      <div className="command-bar">
        <div className="identity">
          <strong className="mono" title={detail.name}>{detail.name}</strong>
          <Badge state={detail.state} />
        </div>
        <div className="bulk" aria-label="Actions">
          <button className="btn" type="button" disabled={Boolean(pending) || isRunning} onClick={() => void act("start")}>
            <Icon name="play" /> {pending === "start" ? "Starting…" : "Start"}
          </button>
          <button className="btn" type="button" disabled={Boolean(pending) || !isRunning} onClick={() => void act("stop")}>
            <Icon name="stop" /> {pending === "stop" ? "Stopping…" : "Stop"}
          </button>
          <button className="btn" type="button" disabled={Boolean(pending)} onClick={() => void act("restart")}>
            <Icon name="restart" /> {pending === "restart" ? "Restarting…" : "Restart"}
          </button>
          <button className="btn danger" type="button" disabled={Boolean(pending)} onClick={() => setConfirm(true)}>
            <Icon name="trash" /> Remove
          </button>
          <button className="btn" type="button" disabled={Boolean(pending)} onClick={() => setRecreateOpen(true)}>
            <Icon name="refresh" /> {pending === "recreate" ? "Recreating…" : "Recreate"}
          </button>
          <button className="btn" type="button" disabled={Boolean(pending)} onClick={() => setSettingsOpen(true)}>
            Edit name / restart
          </button>
          <button className="btn" type="button" disabled={Boolean(pending)} onClick={() => setEditOpen(true)}>
            <Icon name="copy" /> Duplicate/Edit
          </button>
        </div>
      </div>
      <div className="stack-tabs" role="tablist" aria-label="Container views" onKeyDown={tabKey}>
        {CONTAINER_TABS.map((key) => (
          <button
            key={key}
            id={`container-tab-${key}`}
            className={`stack-tab${key === "stats" || key === "attach" ? " soon" : ""}`}
            type="button"
            role="tab"
            aria-selected={tab === key}
            aria-controls={`container-panel-${key}`}
            onClick={() => chooseTab(key)}
          >
            {key === "logs" ? <><Icon name="logs" /> Logs</> : null}
            {key === "inspect" ? <><Icon name="eye" /> Inspect</> : null}
            {key === "stats" ? <>Stats <span className="nav-soon">soon</span></> : null}
            {key === "console" ? <><Icon name="console" /> Console</> : null}
            {key === "attach" ? <>Attach <span className="nav-soon">soon</span></> : null}
          </button>
        ))}
      </div>
      <section
        id="container-panel-inspect"
        className="stack-panel"
        role="tabpanel"
        aria-labelledby="container-tab-inspect"
        hidden={tab !== "inspect"}
      >
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
            <Fact label="ID" value={detail.id} mono />
            <Fact label="Image" value={detail.image} mono />
            <Fact label="Command" value={blank(detail.command)} mono />
            <Fact label="Entrypoint" value={blank(detail.entrypoint)} mono />
            <Fact label="Restart" value={`${detail.restartPolicy || "no"}${detail.restartMaximumRetryCount == null ? "" : ` · ${detail.restartMaximumRetryCount} retries`}`} />
            <Fact label="Ports" value={portList(detail.ports)} mono />
            <Fact label="Mounts" value={mounts} />
            <Fact label="Networks" value={networks} />
            <MaskedEnvironment items={detail.env} />
            <Fact label="Labels" value={detail.labels.length ? detail.labels.map(({ key, value }) => `${key} = ${value}`).join("\n") : "None"} mono />
            <Fact label="Image ID" value={detail.imageId} mono />
            <Fact label="Created" value={stamp(detail.created)} mono />
            <Fact label="Started" value={stamp(detail.started)} mono />
          </div>
        </section>
        <ContainerAiAccess endpointId={endpointId} containerId={detail.id} containerName={detail.name} />
      </section>
      <section
        id="container-panel-logs"
        className="stack-panel"
        role="tabpanel"
        aria-labelledby="container-tab-logs"
        hidden={tab !== "logs"}
      >
        {tab === "logs" ? (
          <ContainerLogs
            endpointId={endpointId}
            containerId={containerId}
            reload={reload}
            defaultFollow={isRunning}
            sectionId="container-log-view"
          />
        ) : null}
      </section>
      <section
        id="container-panel-stats"
        className="stack-panel"
        role="tabpanel"
        aria-labelledby="container-tab-stats"
        hidden={tab !== "stats"}
      >
        {tab === "stats" ? (
          <ContainerViewSoon
            title="Container stats are not available yet"
            body="Live CPU, memory, and network charts for this container are not in this Pisces build. Use Inspect for container metadata or Logs for output."
          />
        ) : null}
      </section>
      <section
        id="container-panel-console"
        className="stack-panel"
        role="tabpanel"
        aria-labelledby="container-tab-console"
        hidden={tab !== "console"}
      >
        {tab === "console" ? (
          isRunning ? (
            <ContainerConsole
              endpointId={endpointId}
              containerId={containerId}
              running={isRunning}
              onClose={() => chooseTab("inspect")}
            />
          ) : (
            <div className="state">
              <h2>Console needs a running container</h2>
              <p>{detail.name} is {detail.state}. Start it, then open Console again.</p>
              <button className="btn" type="button" disabled={Boolean(pending)} onClick={() => void act("start")}>
                <Icon name="play" /> {pending === "start" ? "Starting…" : "Start"}
              </button>
            </div>
          )
        ) : null}
      </section>
      <section
        id="container-panel-attach"
        className="stack-panel"
        role="tabpanel"
        aria-labelledby="container-tab-attach"
        hidden={tab !== "attach"}
      >
        {tab === "attach" ? (
          <ContainerViewSoon
            title="Attach is not available yet"
            body="Streaming attach to a running process stdin is not in this Pisces build. Use Console for an interactive shell when the container is running."
          />
        ) : null}
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
      {recreateOpen ? (
        <Dialog title={`Recreate ${detail.name}?`} onClose={() => setRecreateOpen(false)}>
          <p>
            A new container is built from {detail.name}’s current config and the image already on this machine. It does not pull from a registry
            {isRunning ? `; ${detail.name} is stopped first` : ""}. The writable layer is discarded
            and the container id changes. Named volumes and custom networks carry over. Use Duplicate/Edit to pull a new image.
          </p>
          <div className="dialog-actions">
            <button className="btn" data-focus="first" type="button" onClick={() => setRecreateOpen(false)}>Cancel</button>
            <button className="btn danger" type="button" onClick={() => void recreate()}>
              Recreate
            </button>
          </div>
        </Dialog>
      ) : null}
      {settingsOpen ? (
        <ContainerSettingsDialog
          endpointId={endpointId}
          containerId={containerId}
          name={detail.name}
          restartPolicy={detail.restartPolicy}
          retryCount={detail.restartMaximumRetryCount}
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false);
            void load(false);
          }}
        />
      ) : null}
      {editOpen ? (
        <ContainerDuplicateDialog
          endpointId={endpointId}
          containerId={containerId}
          onClose={() => setEditOpen(false)}
          onCreated={(created) => {
            setEditOpen(false);
            router.push(`/e/${endpointId}/containers/${encodeURIComponent(created.id)}`);
          }}
        />
      ) : null}
    </div>
  );
}

function ContainerViewSoon({ title, body }: { title: string; body: string }) {
  return (
    <div className="state placeholder-panel">
      <span className="badge warn"><i className="sq warn" />not in this build</span>
      <h2>{title}</h2>
      <p>{body}</p>
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

function MaskedEnvironment({ items }: { items: ContainerDetail["env"] }) {
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});
  const allRevealed = items.length > 0 && items.every((_, index) => revealed[index]);
  const toggleAll = () => {
    if (allRevealed) {
      setRevealed({});
      return;
    }
    setRevealed(Object.fromEntries(items.map((_, index) => [index, true])));
  };
  return (
    <div className="fact fact-multiline">
      <span>Env</span>
      <div className="env-block">
        {items.length ? (
          <>
            <div className="env-bulk">
              <button
                className="btn"
                type="button"
                aria-label={allRevealed ? "Hide all environment" : "Reveal all environment"}
                onClick={toggleAll}
              >
                {allRevealed ? "Hide all environment" : "Reveal all environment"}
              </button>
            </div>
            <div className="env-list">
              {items.map(({ key, value }, index) => (
                <div className="env-row" key={`${key}-${index}`}>
                  <code>{key}</code>
                  <code className="env-value">{revealed[index] ? value || "(empty)" : "••••••••"}</code>
                  <button className="btn" type="button" aria-label={`${revealed[index] ? "Hide" : "Reveal"} ${key}`} onClick={() => setRevealed((current) => ({ ...current, [index]: !current[index] }))}>
                    {revealed[index] ? "Hide" : "Reveal"}
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : (
          <strong>None</strong>
        )}
      </div>
    </div>
  );
}
