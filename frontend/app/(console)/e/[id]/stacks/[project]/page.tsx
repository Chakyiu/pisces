"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ApiError, api } from "../../../../../../lib/api";
import { age, portList } from "../../../../../../lib/format";
import type { Container, StackDetail } from "../../../../../../lib/types";
import { Badge, Dialog, ErrorState, Icon, Loading } from "../../../../../../components/bits";
import { DockerView, Pager, publishApiError } from "../../../../../../components/gate";
import { PageFrame } from "../../../../../../components/shell";
import { ComposeEditor } from "../compose-editor";
import { StackEnvEditor, stackEnvPayload } from "../stack-env-editor";
import type { EnvValue } from "../../../../../../lib/types";

const LOST_REQUEST = "The console lost the deploy request. Check the stack list before trying again. The engine may still be applying it.";
const MAX_BYTES = 1_048_576;
const isUp = (container: { state: string }) => container.state === "running" || container.state === "restarting";

function fileError(value: string) {
  if (!value.trim()) return "Stack file content is required";
  if (new TextEncoder().encode(value).byteLength > MAX_BYTES) return "This file is larger than 1 MB. Pisces accepts Compose files up to 1 MB.";
  return "";
}

function envFingerprint(rows: EnvValue[]) {
  return JSON.stringify(stackEnvPayload(rows));
}

type Tab = "stack" | "editor";

export default function StackDetailPage() {
  const { id, project } = useParams<{ id: string; project: string }>();
  const refreshRef = useRef<() => void>(() => {});
  const listHref = `/e/${id}/stacks`;
  return (
    <PageFrame
      title="Stack details"
      crumbs={[{ label: "Stacks", href: listHref }, { label: project, mono: true, translate: "no" }]}
      onRefresh={() => refreshRef.current()}
    >
      <DockerView noun="stack">{(endpoint) => <Body id={id} project={project} endpointName={endpoint.name} refreshRef={refreshRef} />}</DockerView>
    </PageFrame>
  );
}

function Body({ id, project, endpointName, refreshRef }: { id: string; project: string; endpointName: string; refreshRef: { current: () => void } }) {
  const router = useRouter();
  const [detail, setDetail] = useState<StackDetail | null>(null);
  const [compose, setCompose] = useState("");
  const [env, setEnv] = useState<EnvValue[]>([]);
  const [savedEnv, setSavedEnv] = useState("[]");
  const [tab, setTab] = useState<Tab>("stack");
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState("");
  const [attempts, setAttempts] = useState(0);
  const [errorAt, setErrorAt] = useState<Date>();
  const [alert, setAlert] = useState("");
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmUpdate, setConfirmUpdate] = useState(false);
  const [remove, setRemove] = useState(false);
  const [picked, setPicked] = useState<Record<string, Container>>({});
  const [offset, setOffset] = useState(0);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [pendingHref, setPendingHref] = useState("");
  const adopting = Boolean(detail && (detail.origin === "discovered" || !detail.hasFile));
  const envDirty = envFingerprint(env) !== savedEnv;
  const dirty = adopting
    ? Boolean((compose.trim() && !fileError(compose)) || envDirty)
    : Boolean(
        detail?.origin === "managed" &&
          detail.hasFile &&
          (compose !== (detail.compose ?? "") || envDirty),
      );
  const containers = detail?.containerDetails ?? [];
  const visible = containers.slice(offset, offset + 50);
  const selected = visible.filter((container) => picked[container.id]);
  const selectedRunning = selected.filter(isUp);
  const selectedStopped = selected.filter((container) => !isUp(container));
  const rowsRunning = containers.some(isUp);
  const rowsStopped = containers.some((container) => !isUp(container));
  const rows = detail?.containers ?? [];

  async function load(retry = false) {
    if (retry) setAttempts((value) => value + 1);
    setLoading(true);
    setError("");
    setNotFound(false);
    try {
      const value = await api<StackDetail>(`/api/endpoints/${id}/stacks/${encodeURIComponent(project)}`);
      setDetail(value);
      setCompose(value.compose ?? "");
      const loaded = value.env ?? [];
      setEnv(loaded);
      setSavedEnv(envFingerprint(loaded));
      setStatus(new URLSearchParams(window.location.search).get("deployed") === "1" ? `Deployed ${project}.` : "");
    } catch (err) {
      if (err instanceof ApiError && err.code === "not_found") {
        setNotFound(true);
      } else {
        const message = err instanceof ApiError ? err.message : "The engine did not answer.";
        if (err instanceof ApiError) publishApiError(err.code);
        setError(message);
        setErrorAt(new Date());
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setAttempts(0);
    void load();
    // load is a request trigger, keyed by endpoint/project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, project]);
  refreshRef.current = () => { void load(); };

  useEffect(() => {
    function readTab() {
      const requested = new URLSearchParams(window.location.search).get("tab");
      setTab(requested === "editor" ? "editor" : "stack");
    }
    readTab();
    window.addEventListener("popstate", readTab);
    return () => window.removeEventListener("popstate", readTab);
  }, []);

  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    function interceptLink(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.target === "_blank") return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || `${url.pathname}${url.search}` === `${window.location.pathname}${window.location.search}`) return;
      event.preventDefault();
      event.stopPropagation();
      setPendingHref(`${url.pathname}${url.search}${url.hash}`);
      setLeaveOpen(true);
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", interceptLink, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", interceptLink, true);
    };
  }, [dirty]);

  function chooseTab(next: Tab) {
    if (dirty) {
      setPendingHref(`/e/${id}/stacks/${encodeURIComponent(project)}?tab=${next}`);
      setLeaveOpen(true);
      return;
    }
    setTab(next);
    router.replace(`/e/${id}/stacks/${encodeURIComponent(project)}?tab=${next}`);
  }

  function tabKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next: Tab = event.key === "Home" || event.key === "ArrowLeft" ? "stack" : "editor";
    chooseTab(next);
    document.getElementById(`stack-tab-${next}`)?.focus();
  }

  async function perform(action: "start" | "stop" | "restart" | "remove", targets: Container[]) {
    setPending(action);
    setAlert("");
    try {
      for (const container of targets) {
        await api(`/api/endpoints/${id}/containers/${encodeURIComponent(container.id)}${action === "remove" ? "" : `/${action}`}`, {
          method: action === "remove" ? "DELETE" : "POST",
        });
      }
      setPicked({});
      setRemove(false);
      await load();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "The engine did not answer.";
      if (err instanceof ApiError) publishApiError(err.code);
      setAlert(`${action[0].toUpperCase()}${action.slice(1)} failed. ${message}`);
    } finally {
      setPending("");
    }
  }

  async function deleteStack() {
    const action = detail?.origin === "managed" ? "delete" : "remove";
    setPending(action);
    setAlert("");
    try {
      await api(`/api/endpoints/${id}/stacks/${encodeURIComponent(project)}`, { method: "DELETE", timeoutMs: 310_000, failureMessage: LOST_REQUEST });
      router.push(`/e/${id}/stacks`);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "The engine did not answer.";
      if (err instanceof ApiError) publishApiError(err.code);
      setAlert(`${action === "delete" ? "Delete" : "Remove containers"} failed. ${message}`);
    } finally {
      setPending("");
      setConfirmDelete(false);
    }
  }

  async function updateStack() {
    setPending("update");
    setAlert("");
    setStatus("");
    const slowTimer = window.setTimeout(() => setStatus("Taking longer than expected. Image pulls can take a minute."), 15_000);
    try {
      await api(`/api/endpoints/${id}/stacks/${encodeURIComponent(project)}`, {
        method: "PUT",
        body: { project, compose, env: stackEnvPayload(env) },
        timeoutMs: 310_000,
        failureMessage: LOST_REQUEST,
      });
      await load();
      setStatus(adopting ? `Replaced ${project}.` : `Updated ${project}.`);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "The engine did not answer.";
      if (err instanceof ApiError) publishApiError(err.code);
      setAlert(`${adopting ? "Replace" : "Update"} failed. ${message}`);
    } finally {
      window.clearTimeout(slowTimer);
      setPending("");
      setConfirmUpdate(false);
    }
  }

  if (loading && !detail && !error && !notFound) return <Loading noun="stack" />;
  if (error) return <ErrorState title={`Docker endpoint ${endpointName} is not responding.`} message={error} attempts={attempts} at={errorAt} onRetry={() => void load(true)} />;
  if (notFound) {
    return <div className="state"><h2>{project} was not found.</h2><p>This endpoint has no stack with that name.</p><Link className="btn primary" href={`/e/${id}/stacks`}>Back to stacks</Link></div>;
  }
  if (!detail) return <Loading noun="stack" />;

  const dirtyLeave = () => {
    if (pendingHref) router.push(pendingHref);
    setPendingHref("");
    setLeaveOpen(false);
  };

  return (
    <div className="stack-panel">
      {alert ? <div className="alert bad" role="alert">{alert}</div> : null}
      {status ? <div className="stack-status" role="status" aria-live="polite">{status}</div> : null}
      <div className="stack-tabs" role="tablist" aria-label="Stack views" onKeyDown={tabKey}>
        <button id="stack-tab-stack" className="stack-tab" type="button" role="tab" aria-selected={tab === "stack"} aria-controls="stack-panel-stack" onClick={() => chooseTab("stack")}>Stack</button>
        <button id="stack-tab-editor" className="stack-tab" type="button" role="tab" aria-selected={tab === "editor"} aria-controls="stack-panel-editor" onClick={() => chooseTab("editor")}>Editor</button>
      </div>
      {tab === "stack" ? (
        <section id="stack-panel-stack" className="stack-panel" role="tabpanel" aria-labelledby="stack-tab-stack">
          <section className="widget">
            <div className="widget-head">
              <div className="widget-title"><Icon name="stacks" /> Stack actions</div>
              <div className="grow" />
              <div className="bulk">
                <button className="btn" type="button" disabled={Boolean(pending) || !rowsStopped} onClick={() => void perform("start", rows.filter((item) => !isUp(item)).map((item) => containers.find((container) => container.id === item.id)).filter((item): item is Container => Boolean(item)))}>Start stack</button>
                <button className="btn" type="button" disabled={Boolean(pending) || !rowsRunning} onClick={() => void perform("stop", rows.filter(isUp).map((item) => containers.find((container) => container.id === item.id)).filter((item): item is Container => Boolean(item)))}>Stop stack</button>
                <button className="btn" type="button" disabled={Boolean(pending) || rows.length === 0} onClick={() => void perform("restart", rows.map((item) => containers.find((container) => container.id === item.id)).filter((item): item is Container => Boolean(item)))}>Restart stack</button>
                <button className="btn danger" type="button" disabled={Boolean(pending)} aria-label={`${detail.origin === "managed" ? "Delete stack" : "Remove containers"} ${project}`} onClick={() => setConfirmDelete(true)}>
                  {pending === "delete" || pending === "remove" ? (detail.origin === "managed" ? "Deleting…" : "Removing…") : detail.origin === "managed" ? "Delete stack" : "Remove containers"}
                </button>
              </div>
            </div>
            <div className="stack-facts">
              <div className="stack-fact"><span>Name</span><strong className="mono" translate="no">{detail.project}</strong></div>
              <div className="stack-fact"><span>Origin</span><strong>{detail.origin === "managed" ? "Managed" : "Discovered"}</strong></div>
              <div className="stack-fact"><span>State</span><strong><Badge state={detail.state} /></strong></div>
              <div className="stack-fact"><span>Containers</span><strong className="mono">{detail.running}/{detail.total}</strong></div>
              <div className="stack-fact"><span>Endpoint</span><strong>{endpointName}</strong></div>
              <div className="stack-fact"><span>Compose file</span><strong>{detail.hasFile ? "Stored" : "Not stored"}</strong></div>
            </div>
          </section>
          <section className="widget">
            <div className="widget-head">
              <div className="widget-title"><Icon name="containers" /> Containers</div>
              <div className="grow" />
              <div className="bulk">
                <button className="btn" type="button" disabled={Boolean(pending) || selectedStopped.length === 0} onClick={() => void perform("start", selectedStopped)}>Start</button>
                <button className="btn" type="button" disabled={Boolean(pending) || selectedRunning.length === 0} onClick={() => void perform("stop", selectedRunning)}>Stop</button>
                <button className="btn" type="button" disabled={Boolean(pending) || selected.length === 0} onClick={() => void perform("restart", selected)}>Restart</button>
                <button className="btn danger" type="button" disabled={Boolean(pending) || selected.length === 0} onClick={() => setRemove(true)}>Remove</button>
              </div>
            </div>
            {containers.length === 0 ? (
              <div className="state">
                <h2>No containers in {project}.</h2>
                <p>{detail.origin === "managed" ? `The Compose file is stored. Deploy has not left containers on ${endpointName}.` : "They may have been removed. Refresh the page."}</p>
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr><th className="col-check"><label className="check"><input type="checkbox" aria-label="Select all containers" checked={visible.length > 0 && selected.length === visible.length} onChange={(event) => setPicked((current) => { const next = { ...current }; if (event.target.checked) visible.forEach((item) => { next[item.id] = item; }); else visible.forEach((item) => { delete next[item.id]; }); return next; })} /></label></th><th>Name</th><th>State</th><th>Quick actions</th><th>Image</th><th>Created</th><th>Ports</th></tr></thead>
                  <tbody>{visible.map((item) => (
                    <tr key={item.id}>
                      <td className="col-check"><label className="check"><input type="checkbox" aria-label={`Select ${item.name}`} checked={Boolean(picked[item.id])} onChange={() => setPicked((current) => { const next = { ...current }; if (next[item.id]) delete next[item.id]; else next[item.id] = item; return next; })} /></label></td>
                      <td className="name-cell"><Link className="name-link" href={`/e/${id}/containers/${encodeURIComponent(item.id)}`}>{item.name}</Link></td>
                      <td><Badge state={item.state} /></td>
                      <td><Link className="icon-btn" href={`/e/${id}/containers/${encodeURIComponent(item.id)}?tab=logs`} aria-label="Logs" title="Logs"><Icon name="logs" /></Link></td>
                      <td className="mono name-cell" title={item.image}>{item.image}</td><td className="mono">{age(item.created)}</td><td className="mono">{portList(item.ports)}</td>
                    </tr>
                  ))}</tbody>
                </table>
                <Pager total={containers.length} offset={offset} noun="containers" nextCursor={offset + 50 < containers.length ? String(offset + 50) : null} onPrev={() => setOffset(Math.max(0, offset - 50))} onNext={() => setOffset(Math.min(containers.length - 1, offset + 50))} />
              </div>
            )}
          </section>
        </section>
      ) : (
        <section id="stack-panel-editor" className="stack-panel" role="tabpanel" aria-labelledby="stack-tab-editor">
          {adopting ? (
            <>
              <p className="stack-note">
                {detail.origin === "discovered"
                  ? <>Pisces found <span className="mono" translate="no">{project}</span> from container labels on {endpointName}. Paste a Compose file below to store it in Pisces and redeploy this stack. The stack name stays <span className="mono" translate="no">{project}</span>.</>
                  : <>Pisces has a record for {project} on {endpointName}, but the Compose file is missing. Paste a file below to store and redeploy it. The stack name stays <span className="mono" translate="no">{project}</span>.</>}
              </p>
              <ComposeEditor value={compose} onChange={setCompose} disabled={Boolean(pending)} error={compose.trim() && fileError(compose) ? fileError(compose) : ""} />
              <StackEnvEditor value={env} onChange={setEnv} disabled={Boolean(pending)} />
              <div className="stack-editor-actions">
                <button className="btn primary" type="button" disabled={Boolean(pending) || !dirty} onClick={() => setConfirmUpdate(true)}>
                  {pending === "update" ? (detail.origin === "discovered" ? "Replacing…" : "Deploying…") : detail.origin === "discovered" ? "Replace the stack" : "Deploy the stack"}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="stack-note">The stack name stays <span className="mono" translate="no">{project}</span>.</p>
              <ComposeEditor value={compose} onChange={setCompose} disabled={Boolean(pending)} />
              <StackEnvEditor value={env} onChange={setEnv} disabled={Boolean(pending)} />
              <div className="stack-editor-actions"><button className="btn primary" type="button" disabled={Boolean(pending) || !dirty} onClick={() => setConfirmUpdate(true)}>{pending === "update" ? "Updating…" : "Update the stack"}</button></div>
            </>
          )}
        </section>
      )}
      {confirmUpdate ? (
        <Dialog title={adopting ? (detail.origin === "discovered" ? `Replace ${project}?` : `Deploy ${project}?`) : `Update ${project}?`} onClose={() => setConfirmUpdate(false)}>
          <p>
            {adopting && detail.origin === "discovered"
              ? `Pisces will store this Compose file and redeploy ${project} on ${endpointName}, replacing the containers found from labels. Services that this file no longer defines are removed. Named volumes stay.`
              : `Pisces will redeploy this Compose file on ${endpointName}. Services that this file no longer defines are removed. Named volumes stay.`}
          </p>
          <div className="dialog-actions"><button className="btn" data-focus="first" type="button" onClick={() => setConfirmUpdate(false)}>Cancel</button><button className="btn primary" type="button" disabled={pending === "update"} onClick={() => void updateStack()}>{pending === "update" ? (adopting ? (detail.origin === "discovered" ? "Replacing…" : "Deploying…") : "Updating…") : adopting ? (detail.origin === "discovered" ? "Replace the stack" : "Deploy the stack") : "Update the stack"}</button></div>
        </Dialog>
      ) : null}
      {confirmDelete ? (
        <Dialog title={detail.origin === "managed" ? `Delete stack ${project}?` : `Remove containers in ${project}?`} onClose={() => setConfirmDelete(false)}>
          <p>{detail.origin === "managed"
            ? rows.length > 0
              ? `This removes the containers created by ${project} on ${endpointName} and deletes the Compose file Pisces stored. Named volumes stay.`
              : `This deletes the Compose file Pisces stored for ${project}. There are no containers to remove. Named volumes already on ${endpointName} stay.`
            : `Pisces did not create this stack. This stops and removes its containers on ${endpointName}. Named volumes stay. The Compose file, if it lives somewhere else, is not touched.`}</p>
          <div className="dialog-actions"><button className="btn" data-focus="first" type="button" onClick={() => setConfirmDelete(false)}>Cancel</button><button className="btn danger" type="button" disabled={Boolean(pending)} onClick={() => void deleteStack()}>{pending === "delete" ? "Deleting…" : pending === "remove" ? "Removing…" : detail.origin === "managed" ? "Delete stack" : "Remove containers"}</button></div>
        </Dialog>
      ) : null}
      {remove ? (
        <Dialog title={selected.length === 1 ? `Remove ${selected[0].name}?` : `Remove ${selected.length} containers?`} onClose={() => setRemove(false)}>
          <p>{selected.length === 1 ? `${selected[0].name} is ${selected[0].state}. Removing it deletes the writable layer. Named volumes stay on ${endpointName}.` : `Removing ${selected.length} containers deletes their writable layers. Named volumes stay on ${endpointName}.`}</p>
          <div className="dialog-actions"><button className="btn" data-focus="first" type="button" onClick={() => setRemove(false)}>Cancel</button><button className="btn danger" type="button" disabled={pending === "remove"} onClick={() => void perform("remove", selected)}>{pending === "remove" ? "Removing…" : "Remove"}</button></div>
        </Dialog>
      ) : null}
      {leaveOpen ? (
        <Dialog title="Leave this page?" onClose={() => { setLeaveOpen(false); setPendingHref(""); }}>
          <p>The edits have not been applied.</p>
          <div className="dialog-actions"><button className="btn" data-focus="first" type="button" onClick={() => { setLeaveOpen(false); setPendingHref(""); }}>Stay</button><button className="btn primary" type="button" onClick={dirtyLeave}>Leave</button></div>
        </Dialog>
      ) : null}
    </div>
  );
}
