"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, api } from "../../../../../lib/api";
import { age, bytes, imageLabel, shortId } from "../../../../../lib/format";
import type { ImageItem } from "../../../../../lib/types";
import { Dialog, Empty, ErrorState, Icon, Loading } from "../../../../../components/bits";
import { DockerView, publishApiError, usePaged } from "../../../../../components/gate";
import { PageFrame } from "../../../../../components/shell";

function parsePort(raw: string): { host: number; container: number; protocol: string } | "empty" | null {
  const value = raw.trim();
  if (!value) return "empty";
  const single = /^(\d{1,5})$/.exec(value);
  if (single) {
    const port = Number(single[1]);
    if (port < 1 || port > 65535) return null;
    return { host: port, container: port, protocol: "tcp" };
  }
  const pair = /^(\d{1,5}):(\d{1,5})(?:\/(tcp|udp|sctp))?$/i.exec(value);
  if (!pair) return null;
  const host = Number(pair[1]);
  const container = Number(pair[2]);
  if (host < 1 || host > 65535 || container < 1 || container > 65535) return null;
  return { host, container, protocol: (pair[3] ?? "tcp").toLowerCase() };
}

export default function ImagesPage() {
  const refreshRef = useRef<{ current: () => void }>({ current: () => {} });
  return (
    <PageFrame title="Images" crumbs={[{ label: "Images" }]} onRefresh={() => refreshRef.current.current()}>
      <DockerView noun="images">{(endpoint) => <Body refreshRef={refreshRef.current} id={endpoint.id} name={endpoint.name} />}</DockerView>
    </PageFrame>
  );
}

function Body({ id, name, refreshRef }: { id: string; name: string; refreshRef: { current: () => void } }) {
  const router = useRouter();
  const query = usePaged<ImageItem>(`/api/endpoints/${id}/images?limit=50`);
  refreshRef.current = () => { void query.reload(); };
  const [picked, setPicked] = useState<Record<string, ImageItem>>({});
  const [run, setRun] = useState<ImageItem | null>(null);
  const [remove, setRemove] = useState<ImageItem[] | null>(null);
  const [containerName, setContainerName] = useState("");
  const [port, setPort] = useState("");
  const [portError, setPortError] = useState("");
  const [alert, setAlert] = useState("");
  const [pending, setPending] = useState("");

  const items = query.data?.items ?? [];
  const selected = items.filter((item) => picked[item.id]);
  const allChecked = items.length > 0 && selected.length === items.length;

  function toggle(item: ImageItem) {
    setPicked((prev) => {
      const next = { ...prev };
      if (next[item.id]) delete next[item.id];
      else next[item.id] = item;
      return next;
    });
  }

  async function start() {
    if (!run) return;
    const parsed = parsePort(port);
    if (parsed === null) {
      setPortError("Use host:container, a single port, or leave this empty.");
      return;
    }
    setPending("run");
    setAlert("");
    try {
      const created = await api<{ id: string }>(`/api/endpoints/${id}/containers`, {
        method: "POST",
        body: {
          image: imageLabel(run.tags) === "<none>:<none>" ? run.id : imageLabel(run.tags),
          name: containerName.trim() || undefined,
          ports: parsed === "empty" ? [] : [parsed],
        },
      });
      router.push(`/e/${id}/containers/${encodeURIComponent(created.id)}`);
    } catch (err) {
      if (err instanceof ApiError) publishApiError(err.code);
      setAlert(`Run failed. ${err instanceof ApiError ? err.message : "The engine did not answer."}`);
      setPending("");
    }
  }

  async function removeImages() {
    if (!remove) return;
    setPending("remove");
    setAlert("");
    try {
      for (const item of remove) {
        await api(`/api/endpoints/${id}/images/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      }
      setRemove(null);
      setPicked({});
      await query.reload();
    } catch (err) {
      if (err instanceof ApiError) publishApiError(err.code);
      setAlert(`Remove failed. ${err instanceof ApiError ? err.message : "The engine did not answer."}`);
    } finally {
      setPending("");
    }
  }

  return (
    <>
      {alert ? <div className="alert bad" role="alert">{alert}</div> : null}
      <section className="widget">
        <div className="widget-head">
          <div className="widget-title"><Icon name="images" /> Images</div>
          <div className="grow" />
          <button className="btn danger" type="button" disabled={Boolean(pending) || selected.length === 0} onClick={() => setRemove(selected)}>
            <Icon name="trash" /> Remove
          </button>
        </div>
        {query.status === "loading" && !query.data ? <Loading noun="images" /> : null}
        {query.status === "error" ? (
          <ErrorState title={`Docker endpoint ${name} is not responding.`} message={query.message} attempts={query.attempts} at={query.at} onRetry={query.retry} />
        ) : null}
        {query.status === "ready" && query.data?.items.length === 0 ? (
          <Empty title={`No images on ${name}.`} body="Images show up when the engine already has them. This version does not pull or build." action={{ label: "Refresh", primary: true, onClick: query.retry }} />
        ) : null}
        {query.data && query.data.items.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="col-check"><span className="check"><input type="checkbox" aria-label="Select all" checked={allChecked} onChange={() => setPicked(allChecked ? {} : Object.fromEntries(items.map((item) => [item.id, item])))} /></span></th>
                  <th>Tag</th>
                  <th>ID</th>
                  <th>Size</th>
                  <th>Age</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td className="col-check">
                      <span className="check">
                        <input type="checkbox" aria-label={`Select ${imageLabel(item.tags)}`} checked={Boolean(picked[item.id])} onChange={() => toggle(item)} />
                      </span>
                    </td>
                    <td className="mono name-cell" title={imageLabel(item.tags)}>{imageLabel(item.tags)}</td>
                    <td className="mono" title={item.id}>{shortId(item.id)}</td>
                    <td className="mono">{bytes(item.sizeBytes)}</td>
                    <td className="mono">{age(item.created)}</td>
                    <td>
                      <button className="btn" type="button" onClick={() => { setRun(item); setContainerName(""); setPort(""); setPortError(""); }}>
                        <Icon name="play" /> Run
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
      {run ? (
        <Dialog title="Run container" onClose={() => setRun(null)}>
          <label className="label">Image<input className="field" readOnly value={imageLabel(run.tags)} /></label>
          <label className="label">Name<input className="field" value={containerName} onChange={(event) => setContainerName(event.target.value)} /></label>
          <label className="label">
            Port
            <input className="field" placeholder="8080:80" value={port} onBlur={() => setPortError(parsePort(port) === null ? "Use host:container, a single port, or leave this empty." : "")} onChange={(event) => setPort(event.target.value)} />
            {portError ? <span className="field-error">{portError}</span> : null}
          </label>
          <div className="dialog-actions">
            <button className="btn" type="button" onClick={() => setRun(null)}>Cancel</button>
            <button className="btn primary" type="button" disabled={pending === "run"} onClick={() => void start()}>{pending === "run" ? "Running…" : "Run"}</button>
          </div>
        </Dialog>
      ) : null}
      {remove ? (
        <Dialog title={remove.length === 1 ? `Remove ${imageLabel(remove[0].tags)}?` : `Remove ${remove.length} images?`} onClose={() => setRemove(null)}>
          <p>{remove.length === 1 ? `Remove image ${imageLabel(remove[0].tags)}? This deletes it from the local engine.` : `Remove ${remove.length} images? This deletes them from the local engine.`}</p>
          <div className="dialog-actions">
            <button className="btn" data-focus="first" type="button" onClick={() => setRemove(null)}>Cancel</button>
            <button className="btn danger" type="button" disabled={pending === "remove"} onClick={() => void removeImages()}>{pending === "remove" ? "Removing…" : "Remove"}</button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
