"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../../../../lib/api";
import type { Network } from "../../../../../lib/types";
import { Dialog, Empty, ErrorState, Icon, Loading } from "../../../../../components/bits";
import { DockerView, Pager, publishApiError, usePaged } from "../../../../../components/gate";
import { PageFrame, useConsole } from "../../../../../components/shell";

export default function NetworksPage() {
  const { current, ready } = useConsole();
  const refreshRef = useRef<(() => void) | null>(null);
  // Only hand PageFrame a handler once DockerView renders Body; until then the
  // header Refresh would call nothing.
  const mounted = ready && current?.kind === "docker";
  return (
    <PageFrame
      title="Networks"
      crumbs={[{ label: "Networks" }]}
      onRefresh={mounted ? () => refreshRef.current?.() : undefined}
    >
      <DockerView noun="networks">{(endpoint) => <Body refreshRef={refreshRef} id={endpoint.id} name={endpoint.name} />}</DockerView>
    </PageFrame>
  );
}

function Body({ id, name, refreshRef }: { id: string; name: string; refreshRef: { current: (() => void) | null } }) {
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState("");
  const [offset, setOffset] = useState(0);
  const [create, setCreate] = useState(false);
  const [networkName, setNetworkName] = useState("");
  const [driver, setDriver] = useState("bridge");
  const [picked, setPicked] = useState<Record<string, Network>>({});
  const [remove, setRemove] = useState<Network[] | null>(null);
  const [alert, setAlert] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => { setApplied(q); setOffset(0); }, 200);
    return () => clearTimeout(timer);
  }, [q]);
  const query = usePaged<Network>(`/api/endpoints/${id}/networks?q=${encodeURIComponent(applied)}&limit=50${offset ? `&cursor=${offset}` : ""}`);
  refreshRef.current = () => { void query.reload(); };
  const items = query.data?.items ?? [];
  const selected = items.filter((item) => picked[item.name]);
  const blocked = selected.filter((item) => !item.removable);
  const allChecked = items.length > 0 && selected.length === items.length;

  async function createNetwork() {
    setPending(true);
    setAlert("");
    try {
      await api(`/api/endpoints/${id}/networks`, { method: "POST", body: { name: networkName.trim(), driver: driver.trim() || "bridge" } });
      setCreate(false);
      await query.reload();
    } catch (err) {
      if (err instanceof ApiError) publishApiError(err.code);
      setAlert(err instanceof ApiError ? err.message : "Create failed.");
    } finally {
      setPending(false);
    }
  }

  async function removeNetworks() {
    if (!remove) return;
    setPending(true);
    setAlert("");
    try {
      for (const item of remove) {
        await api(`/api/endpoints/${id}/networks/${encodeURIComponent(item.name)}`, { method: "DELETE" });
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

  const removeTitle = blocked.length > 0 ? `${blocked.map((item) => item.name).join(", ")} cannot be removed.` : undefined;

  return (
    <>
      {alert ? <div className="alert bad" role="alert">{alert}</div> : null}
      <section className="widget">
        <div className="widget-head">
          <div className="widget-title"><Icon name="networks" /> Networks</div>
          <input className="field search" placeholder="name" value={q} onChange={(event) => setQ(event.target.value)} />
          <div className="grow" />
          <button className="btn primary" type="button" onClick={() => { setNetworkName(""); setDriver("bridge"); setCreate(true); }}>
            <Icon name="plus" /> Create network
          </button>
          <button className="btn danger" type="button" disabled={pending || selected.length === 0 || blocked.length > 0} title={removeTitle} onClick={() => setRemove(selected)}>
            <Icon name="trash" /> Remove
          </button>
        </div>
        {query.status === "loading" && !query.data ? <Loading noun="networks" /> : null}
        {query.status === "error" ? <ErrorState title={`Docker endpoint ${name} is not responding.`} message={query.message} attempts={query.attempts} at={query.at} onRetry={query.retry} /> : null}
        {query.status === "ready" && query.data?.items.length === 0 ? (
          applied
            ? <Empty title={`No networks match “${applied}”.`} body="The filter is hiding every network." action={{ label: "Clear search", onClick: () => setQ("") }} />
            : <Empty title="No networks reported." body="The engine returned an empty network list." />
        ) : null}
        {query.data && query.data.items.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="col-check"><label className="check"><input type="checkbox" aria-label="Select all" checked={allChecked} onChange={() => setPicked(allChecked ? {} : Object.fromEntries(items.map((item) => [item.name, item])))} /></label></th>
                  <th>Name</th><th>Driver</th><th>Scope</th><th>Subnet</th><th>Containers</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.name}>
                    <td className="col-check">
                      <label className="check">
                        <input
                          type="checkbox"
                          aria-label={`Select ${item.name}`}
                          checked={Boolean(picked[item.name])}
                          title={item.removable ? undefined : `${item.name} cannot be removed.`}
                          onChange={() => setPicked((prev) => { const next = { ...prev }; if (next[item.name]) delete next[item.name]; else next[item.name] = item; return next; })}
                        />
                      </label>
                    </td>
                    <td>{item.name}</td>
                    <td className="mono">{item.driver}</td>
                    <td>{item.scope || "—"}</td>
                    <td className="mono">{item.subnet || "—"}</td>
                    <td className="mono">{item.containerCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager total={query.data.total} offset={offset} noun="networks" nextCursor={query.data.nextCursor} onPrev={() => setOffset(Math.max(0, offset - 50))} onNext={() => query.data?.nextCursor && setOffset(Number(query.data.nextCursor))} />
          </div>
        ) : null}
      </section>
      {create ? (
        <Dialog title="Create network" onClose={() => setCreate(false)}>
          <label className="label">Name<input className="field" value={networkName} onChange={(event) => setNetworkName(event.target.value)} /></label>
          <label className="label">Driver<input className="field" value={driver} onChange={(event) => setDriver(event.target.value)} /></label>
          <div className="dialog-actions">
            <button className="btn" type="button" onClick={() => setCreate(false)}>Cancel</button>
            <button className="btn primary" type="button" disabled={pending || !networkName.trim()} onClick={() => void createNetwork()}>{pending ? "Creating…" : "Create"}</button>
          </div>
        </Dialog>
      ) : null}
      {remove ? (
        <Dialog title={remove.length === 1 ? `Remove network ${remove[0].name}?` : `Remove ${remove.length} networks?`} onClose={() => setRemove(null)}>
          <p>{remove.length === 1 ? `Remove network ${remove[0].name}? Containers attached to it must be disconnected first.` : `Remove ${remove.length} networks? Containers attached to them must be disconnected first.`}</p>
          <div className="dialog-actions">
            <button className="btn" data-focus="first" type="button" onClick={() => setRemove(null)}>Cancel</button>
            <button className="btn danger" type="button" disabled={pending} onClick={() => void removeNetworks()}>{pending ? "Removing…" : "Remove"}</button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
