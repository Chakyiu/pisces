"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "../../../../../lib/api";
import { age, portList } from "../../../../../lib/format";
import type { Container } from "../../../../../lib/types";
import { Badge, Dialog, Empty, ErrorState, Icon, Loading } from "../../../../../components/bits";
import { AiAccessBadge } from "../../../../../components/container-ai-access";
import { DockerView, Pager, publishApiError, usePaged } from "../../../../../components/gate";
import { PageFrame, useConsole } from "../../../../../components/shell";

const STATES = ["all", "created", "running", "paused", "restarting", "exited", "dead"];

function stopped(item: Container) {
  return item.state !== "running" && item.state !== "restarting";
}
function running(item: Container) {
  return item.state === "running" || item.state === "restarting";
}

export default function ContainersPage() {
  const { current, ready } = useConsole();
  const refreshRef = useRef<(() => void) | null>(null);
  // Only hand PageFrame a handler once DockerView renders Body; until then the
  // header Refresh would call nothing.
  const mounted = ready && current?.kind === "docker";
  return (
    <PageFrame
      title="Containers"
      crumbs={[{ label: "Containers" }]}
      onRefresh={mounted ? () => refreshRef.current?.() : undefined}
    >
      <DockerView noun="containers">{(endpoint) => <Body refreshRef={refreshRef} id={endpoint.id} name={endpoint.name} />}</DockerView>
    </PageFrame>
  );
}

function Body({ id, name, refreshRef }: { id: string; name: string; refreshRef: { current: (() => void) | null } }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [state, setState] = useState("all");
  const [appliedQ, setAppliedQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [picked, setPicked] = useState<Record<string, Container>>({});
  const [pending, setPending] = useState("");
  const [alert, setAlert] = useState("");
  const [remove, setRemove] = useState<Container[] | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => { setAppliedQ(q); setOffset(0); }, 200);
    return () => clearTimeout(timer);
  }, [q]);
  const cursor = offset ? `&cursor=${offset}` : "";
  const query = usePaged<Container>(
    `/api/endpoints/${id}/containers?q=${encodeURIComponent(appliedQ)}&state=${encodeURIComponent(state)}${cursor}&limit=50`,
  );
  refreshRef.current = () => { void query.reload(); };

  const items = query.data?.items ?? [];
  const selected = items.filter((item) => picked[item.id]);
  const allChecked = items.length > 0 && selected.length === items.length;

  function toggle(item: Container) {
    setPicked((prev) => {
      const next = { ...prev };
      if (next[item.id]) delete next[item.id];
      else next[item.id] = item;
      return next;
    });
  }

  function toggleAll() {
    setPicked((prev) => {
      const next = { ...prev };
      if (allChecked) items.forEach((item) => delete next[item.id]);
      else items.forEach((item) => { next[item.id] = item; });
      return next;
    });
  }

  async function act(targets: Container[], action: "start" | "stop" | "restart" | "remove") {
    setPending(action);
    setAlert("");
    try {
      for (const container of targets) {
        await api(`/api/endpoints/${id}/containers/${encodeURIComponent(container.id)}${action === "remove" ? "" : `/${action}`}`, {
          method: action === "remove" ? "DELETE" : "POST",
        });
      }
      setRemove(null);
      setPicked({});
      await query.reload();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "The engine did not answer.";
      if (err instanceof ApiError) publishApiError(err.code);
      const label = action[0].toUpperCase() + action.slice(1);
      setAlert(`${label} failed. ${message}`);
    } finally {
      setPending("");
    }
  }

  const filtered = Boolean(appliedQ) || (state !== "all" && state !== "");
  const startTargets = selected.filter(stopped);
  const stopTargets = selected.filter(running);
  const label = (action: string, busy: string, idle: string) => (pending === action ? busy : idle);

  return (
    <>
      {alert ? <div className="alert bad" role="alert">{alert}</div> : null}
      <section className="widget">
        <div className="widget-head">
          <input className="field search" placeholder="name or image" value={q} onChange={(event) => setQ(event.target.value)} />
          <select className="select" aria-label="State" value={state} onChange={(event) => { setState(event.target.value); setOffset(0); }} style={{ width: 140 }}>
            {STATES.map((item) => <option key={item} value={item}>{item === "all" ? "All" : item}</option>)}
          </select>
          <div className="grow" />
          <div className="bulk">
            <button className="btn" type="button" disabled={Boolean(pending) || startTargets.length === 0} onClick={() => void act(startTargets, "start")}>
              <Icon name="play" /> {label("start", "Starting…", "Start")}
            </button>
            <button className="btn" type="button" disabled={Boolean(pending) || stopTargets.length === 0} onClick={() => void act(stopTargets, "stop")}>
              <Icon name="stop" /> {label("stop", "Stopping…", "Stop")}
            </button>
            <button className="btn" type="button" disabled={Boolean(pending) || selected.length === 0} onClick={() => void act(selected, "restart")}>
              <Icon name="restart" /> {label("restart", "Restarting…", "Restart")}
            </button>
            <button className="btn danger" type="button" disabled={Boolean(pending) || selected.length === 0} onClick={() => setRemove(selected)}>
              <Icon name="trash" /> Remove
            </button>
          </div>
        </div>
        {query.status === "loading" && !query.data ? <Loading noun="containers" /> : null}
        {query.status === "error" ? (
          <ErrorState title={`Docker endpoint ${name} is not responding.`} message={query.message} attempts={query.attempts} at={query.at} onRetry={query.retry} />
        ) : null}
        {query.status === "ready" && query.data && query.data.items.length === 0 ? (
          filtered ? (
            <Empty title={`No containers match “${appliedQ || state}”.`} body="The filter is hiding every container." action={{ label: "Clear search", onClick: () => { setQ(""); setState("all"); } }} />
          ) : (
            <Empty
              title={`No containers on ${name}.`}
              body="The engine is up. Nothing is running or stopped. Start one from an image already on the machine."
              action={{ label: "Go to images", primary: true, onClick: () => router.push(`/e/${id}/images`) }}
            />
          )
        ) : null}
        {query.data && query.data.items.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="col-check"><label className="check"><input type="checkbox" aria-label="Select all" checked={allChecked} onChange={toggleAll} /></label></th>
                  <th>Name</th>
                  <th>State</th>
                  <th>AI access</th>
                  <th>Quick actions</th>
                  <th>Image</th>
                  <th>Created</th>
                  <th>Ports</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td className="col-check">
                      <label className="check">
                        <input type="checkbox" aria-label={`Select ${item.name}`} checked={Boolean(picked[item.id])} onChange={() => toggle(item)} />
                      </label>
                    </td>
                    <td className="name-cell" title={item.name}>
                      <Link className="name-link" href={`/e/${id}/containers/${encodeURIComponent(item.id)}`}>{item.name}</Link>
                    </td>
                    <td><Badge state={item.state} /></td>
                    <td><AiAccessBadge access={item.aiAccess} /></td>
                    <td>
                      <Link className="icon-btn" href={`/e/${id}/containers/${encodeURIComponent(item.id)}#container-logs`} aria-label="Logs" title="Logs">
                        <Icon name="logs" />
                      </Link>
                    </td>
                    <td className="mono name-cell" title={item.image}>{item.image}</td>
                    <td className="mono">{age(item.created)}</td>
                    <td className="mono">{portList(item.ports)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager
              total={query.data.total}
              offset={offset}
              noun="containers"
              nextCursor={query.data.nextCursor}
              onPrev={() => setOffset(Math.max(0, offset - 50))}
              onNext={() => query.data?.nextCursor && setOffset(Number(query.data.nextCursor))}
            />
          </div>
        ) : null}
      </section>
      {remove ? (
        <Dialog title={remove.length === 1 ? `Remove ${remove[0].name}?` : `Remove ${remove.length} containers?`} onClose={() => setRemove(null)}>
          <p>
            {remove.length === 1
              ? `${remove[0].state === "running" ? `${remove[0].name} is running. Removing it stops it and deletes the writable layer.` : `${remove[0].name} is ${remove[0].state}. Removing it deletes the writable layer.`} Named volumes stay on ${name}.`
              : `Removing ${remove.length} containers deletes their writable layers. Named volumes stay on ${name}.`}
          </p>
          <div className="dialog-actions">
            <button className="btn" data-focus="first" type="button" onClick={() => setRemove(null)}>Cancel</button>
            <button className="btn danger" type="button" disabled={pending === "remove"} onClick={() => void act(remove, "remove")}>
              {pending === "remove" ? "Removing…" : "Remove"}
            </button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
