"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "../../../../../lib/api";
import { age, imageLabel, portList } from "../../../../../lib/format";
import type { Container, ImageItem, Page } from "../../../../../lib/types";
import { listedNames, parsePort } from "../../../../../lib/ux";
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
  const [addOpen, setAddOpen] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => { setAppliedQ(q); setOffset(0); }, 200);
    return () => clearTimeout(timer);
  }, [q]);
  useEffect(() => { setPicked({}); }, [appliedQ, state, offset]);
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
      await query.reload();
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
          {selected.length > 0 ? <span className="note">{selected.length} selected</span> : null}
          <button className="btn primary" type="button" onClick={() => setAddOpen(true)}>
            <Icon name="plus" /> Add container
          </button>
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
              action={{ label: "Add container", primary: true, onClick: () => setAddOpen(true) }}
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
              : `Removing ${listedNames(remove.map((item) => item.name))} deletes their writable layers. Named volumes stay on ${name}.`}
          </p>
          <div className="dialog-actions">
            <button className="btn" data-focus="first" type="button" onClick={() => setRemove(null)}>Cancel</button>
            <button className="btn danger" type="button" disabled={pending === "remove"} onClick={() => void act(remove, "remove")}>
              {pending === "remove" ? "Removing…" : "Remove"}
            </button>
          </div>
        </Dialog>
      ) : null}
      {addOpen ? (
        <AddContainerDialog
          id={id}
          onClose={() => setAddOpen(false)}
          onCreated={(containerId) => router.push(`/e/${id}/containers/${encodeURIComponent(containerId)}`)}
        />
      ) : null}
    </>
  );
}

function AddContainerDialog({
  id,
  onClose,
  onCreated,
}: {
  id: string;
  onClose: () => void;
  onCreated: (containerId: string) => void;
}) {
  const [images, setImages] = useState<ImageItem[]>([]);
  const [image, setImage] = useState("");
  const [containerName, setContainerName] = useState("");
  const [port, setPort] = useState("");
  const [portError, setPortError] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let live = true;
    void api<Page<ImageItem>>(`/api/endpoints/${id}/images?limit=50`)
      .then((body) => { if (live) setImages(body.items); })
      .catch(() => { if (live) setImages([]); });
    return () => { live = false; };
  }, [id]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = parsePort(port);
    if (!image.trim()) {
      setError("Choose or type an image.");
      return;
    }
    if (parsed === null) {
      setPortError("Use host:container, a single port, or leave this empty.");
      return;
    }
    setPending(true);
    setError("");
    try {
      const created = await api<{ id: string }>(`/api/endpoints/${id}/containers`, {
        method: "POST",
        body: {
          image: image.trim(),
          name: containerName.trim() || undefined,
          ports: parsed === "empty" ? [] : [parsed],
        },
      });
      onCreated(created.id);
    } catch (err) {
      if (err instanceof ApiError) publishApiError(err.code);
      setError(err instanceof ApiError ? err.message : "The engine did not answer.");
      setPending(false);
    }
  }

  return (
    <Dialog title="Add container" onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <label className="label">
          Local images
          <select
            className="select"
            aria-label="Local images"
            value=""
            onChange={(event) => {
              const picked = images.find((item) => item.id === event.target.value);
              if (picked) setImage(imageLabel(picked.tags) === "<none>:<none>" ? picked.id : imageLabel(picked.tags));
            }}
          >
            <option value="">Choose an image on this engine</option>
            {images.map((item) => (
              <option key={item.id} value={item.id}>{imageLabel(item.tags)}</option>
            ))}
          </select>
        </label>
        <label className="label">
          Image
          <input className="field" data-focus="first" value={image} onChange={(event) => setImage(event.target.value)} />
        </label>
        <label className="label">
          Name
          <input className="field" value={containerName} onChange={(event) => setContainerName(event.target.value)} />
        </label>
        <label className="label">
          Port
          <input className="field" placeholder="8080:80" value={port} onBlur={() => setPortError(parsePort(port) === null ? "Use host:container, a single port, or leave this empty." : "")} onChange={(event) => setPort(event.target.value)} />
          {portError ? <span className="field-error">{portError}</span> : null}
        </label>
        {error ? <p className="field-error">{error}</p> : null}
        <div className="dialog-actions">
          <button className="btn" type="button" onClick={onClose}>Cancel</button>
          <button className="btn primary" type="submit" disabled={pending}>{pending ? "Running…" : "Run"}</button>
        </div>
      </form>
    </Dialog>
  );
}
