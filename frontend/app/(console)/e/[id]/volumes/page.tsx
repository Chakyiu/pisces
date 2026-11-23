"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../../../../lib/api";
import { stamp } from "../../../../../lib/format";
import type { Volume } from "../../../../../lib/types";
import { Dialog, Empty, ErrorState, Icon, Loading } from "../../../../../components/bits";
import { DockerView, Pager, publishApiError, usePaged } from "../../../../../components/gate";
import { PageFrame, useConsole } from "../../../../../components/shell";

export default function VolumesPage() {
  const { current, ready } = useConsole();
  const refreshRef = useRef<(() => void) | null>(null);
  // Only hand PageFrame a handler once DockerView renders Body; until then the
  // header Refresh would call nothing.
  const mounted = ready && current?.kind === "docker";
  return (
    <PageFrame
      title="Volumes"
      crumbs={[{ label: "Volumes" }]}
      onRefresh={mounted ? () => refreshRef.current?.() : undefined}
    >
      <DockerView noun="volumes">{(endpoint) => <Body refreshRef={refreshRef} id={endpoint.id} name={endpoint.name} />}</DockerView>
    </PageFrame>
  );
}

function Body({ id, name, refreshRef }: { id: string; name: string; refreshRef: { current: (() => void) | null } }) {
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState("");
  const [offset, setOffset] = useState(0);
  const [create, setCreate] = useState(false);
  const [volumeName, setVolumeName] = useState("");
  const [driver, setDriver] = useState("local");
  const [picked, setPicked] = useState<Record<string, Volume>>({});
  const [remove, setRemove] = useState<Volume[] | null>(null);
  const [alert, setAlert] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => { setApplied(q); setOffset(0); }, 200);
    return () => clearTimeout(timer);
  }, [q]);
  const query = usePaged<Volume>(`/api/endpoints/${id}/volumes?q=${encodeURIComponent(applied)}&limit=50${offset ? `&cursor=${offset}` : ""}`);
  refreshRef.current = () => { void query.reload(); };
  const items = query.data?.items ?? [];
  const selected = items.filter((item) => picked[item.name]);
  const allChecked = items.length > 0 && selected.length === items.length;

  async function createVolume() {
    setPending(true);
    setAlert("");
    try {
      await api(`/api/endpoints/${id}/volumes`, { method: "POST", body: { name: volumeName.trim(), driver: driver.trim() || "local" } });
      setCreate(false);
      await query.reload();
    } catch (err) {
      if (err instanceof ApiError) publishApiError(err.code);
      setAlert(err instanceof ApiError ? err.message : "Create failed.");
    } finally {
      setPending(false);
    }
  }

  async function removeVolumes() {
    if (!remove) return;
    setPending(true);
    setAlert("");
    try {
      for (const item of remove) {
        await api(`/api/endpoints/${id}/volumes/${encodeURIComponent(item.name)}`, { method: "DELETE" });
      }
      setRemove(null);
      setPicked({});
      await query.reload();
    } catch (err) {
      if (err instanceof ApiError) publishApiError(err.code);
      setAlert(`Remove failed. ${err instanceof ApiError ? err.message : "The engine did not answer."}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      {alert ? <div className="alert bad" role="alert">{alert}</div> : null}
      <section className="widget">
        <div className="widget-head">
          <input className="field search" placeholder="name" value={q} onChange={(event) => setQ(event.target.value)} />
          <div className="grow" />
          <button className="btn primary" type="button" onClick={() => { setVolumeName(""); setDriver("local"); setCreate(true); }}>
            <Icon name="plus" /> Create volume
          </button>
          <button className="btn danger" type="button" disabled={pending || selected.length === 0} onClick={() => setRemove(selected)}>
            <Icon name="trash" /> Remove
          </button>
        </div>
        {query.status === "loading" && !query.data ? <Loading noun="volumes" /> : null}
        {query.status === "error" ? <ErrorState title={`Docker endpoint ${name} is not responding.`} message={query.message} attempts={query.attempts} at={query.at} onRetry={query.retry} /> : null}
        {query.status === "ready" && query.data?.items.length === 0 ? (
          applied
            ? <Empty title={`No volumes match “${applied}”.`} body="The filter is hiding every volume." action={{ label: "Clear search", onClick: () => setQ("") }} />
            : <Empty title={`No volumes on ${name}.`} body="Create one to give a container storage that outlives it." />
        ) : null}
        {query.data && query.data.items.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="col-check"><label className="check"><input type="checkbox" aria-label="Select all" checked={allChecked} onChange={() => setPicked(allChecked ? {} : Object.fromEntries(items.map((item) => [item.name, item])))} /></label></th>
                  <th>Name</th><th>Driver</th><th>Mountpoint</th><th>Created</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.name}>
                    <td className="col-check"><label className="check"><input type="checkbox" aria-label={`Select ${item.name}`} checked={Boolean(picked[item.name])} onChange={() => setPicked((prev) => { const next = { ...prev }; if (next[item.name]) delete next[item.name]; else next[item.name] = item; return next; })} /></label></td>
                    <td className="name-cell" title={item.name}>{item.name}</td>
                    <td className="mono">{item.driver}</td>
                    <td className="mono name-cell" title={item.mountpoint}>{item.mountpoint}</td>
                    <td className="mono">{stamp(item.created)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager total={query.data.total} offset={offset} noun="volumes" nextCursor={query.data.nextCursor} onPrev={() => setOffset(Math.max(0, offset - 50))} onNext={() => query.data?.nextCursor && setOffset(Number(query.data.nextCursor))} />
          </div>
        ) : null}
      </section>
      {create ? (
        <Dialog title="Create volume" onClose={() => setCreate(false)}>
          <label className="label">Name<input className="field" value={volumeName} onChange={(event) => setVolumeName(event.target.value)} /></label>
          <label className="label">Driver<input className="field" value={driver} onChange={(event) => setDriver(event.target.value)} /></label>
          <div className="dialog-actions">
            <button className="btn" type="button" onClick={() => setCreate(false)}>Cancel</button>
            <button className="btn primary" type="button" disabled={pending || !volumeName.trim()} onClick={() => void createVolume()}>{pending ? "Creating…" : "Create"}</button>
          </div>
        </Dialog>
      ) : null}
      {remove ? (
        <Dialog title={remove.length === 1 ? `Remove volume ${remove[0].name}?` : `Remove ${remove.length} volumes?`} onClose={() => setRemove(null)}>
          <p>{remove.length === 1 ? `Remove volume ${remove[0].name}? Containers using it must be stopped first.` : `Remove ${remove.length} volumes? Containers using them must be stopped first.`}</p>
          <div className="dialog-actions">
            <button className="btn" data-focus="first" type="button" onClick={() => setRemove(null)}>Cancel</button>
            <button className="btn danger" type="button" disabled={pending} onClick={() => void removeVolumes()}>{pending ? "Removing…" : "Remove"}</button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
