"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ApiError, api } from "../../../lib/api";
import type { Endpoint } from "../../../lib/types";
import { Badge, Dialog, Empty, Icon, Loading } from "../../../components/bits";
import { DockerDialog, KubernetesDialog } from "../../../components/endpoint-dialogs";
import { PageFrame, useConsole } from "../../../components/shell";

type SortKey = "name" | "kind" | "status";

export default function HomePage() {
  const { endpoints, ready, refresh, down } = useConsole();
  const router = useRouter();
  const [dialog, setDialog] = useState<"docker" | "k8s" | null>(null);
  const [remove, setRemove] = useState<Endpoint | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("name");

  const rows = useMemo(() => {
    const query = q.trim().toLowerCase();
    const filtered = endpoints.filter((endpoint) => endpoint.name.toLowerCase().includes(query));
    const rank = (endpoint: Endpoint) => (down[endpoint.id] || endpoint.status === "down" ? "down" : "up");
    return filtered.sort((a, b) => {
      const by = sort === "kind" ? a.kind.localeCompare(b.kind) : sort === "status" ? rank(a).localeCompare(rank(b)) : 0;
      return by || a.name.localeCompare(b.name);
    });
  }, [endpoints, q, sort, down]);

  const up = endpoints.filter((endpoint) => !(down[endpoint.id] || endpoint.status === "down")).length;
  const downCount = endpoints.length - up;

  async function addDocker(name: string) {
    const created = await api<Endpoint>("/api/endpoints", { method: "POST", body: { kind: "docker", name } });
    await refresh();
    setDialog(null);
    router.push(`/e/${created.id}`);
  }

  async function addKubernetes(name: string, context: string) {
    const created = await api<Endpoint>("/api/endpoints", {
      method: "POST",
      body: { kind: "kubernetes", name, context },
    });
    await refresh();
    setDialog(null);
    router.push(`/e/${created.id}`);
  }

  async function removeEndpoint() {
    if (!remove) return;
    setPending(true);
    setError("");
    try {
      await api(`/api/endpoints/${remove.id}`, { method: "DELETE" });
      setRemove(null);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The endpoint could not be removed.");
    } finally {
      setPending(false);
    }
  }

  const actions = (
    <>
      <button className="btn primary" type="button" onClick={() => setDialog("docker")}>
        <Icon name="plus" /> Add Docker endpoint
      </button>
      <button className="btn" type="button" onClick={() => setDialog("k8s")}>
        <Icon name="plus" /> Add Kubernetes context
      </button>
    </>
  );

  return (
    <PageFrame title="Home" crumbs={[{ label: "Environments" }]} actions={actions} onRefresh={() => void refresh()}>
      {!ready ? <Loading noun="environments" /> : null}
      {ready && endpoints.length === 0 ? (
        <Empty
          title="No endpoint yet."
          body="Pisces needs a Docker engine or a Kubernetes context before it can show anything. This machine’s Docker engine is the usual first step."
          action={{ label: "Add Docker endpoint", primary: true, onClick: () => setDialog("docker") }}
        />
      ) : null}
      {ready && endpoints.length > 0 ? (
        <>
          <div className="summary">
            <span className="seg">{endpoints.length === 1 ? "1 environment" : `${endpoints.length} environments`}</span>
            <span className="seg ok"><i className="sq ok" /> Up {up}</span>
            <span className="seg bad"><i className="sq bad" /> Down {downCount}</span>
          </div>
          <section className="widget">
            <div className="widget-head">
              <div className="widget-title">Environments</div>
              <input className="field search" placeholder="Search environments..." value={q} onChange={(event) => setQ(event.target.value)} />
              <div className="grow" />
              <select className="select" aria-label="Sort environments" value={sort} onChange={(event) => setSort(event.target.value as SortKey)} style={{ width: 140 }}>
                <option value="name">Name</option>
                <option value="kind">Kind</option>
                <option value="status">Status</option>
              </select>
            </div>
            {rows.length === 0 ? (
              <Empty title={`No environments match “${q.trim()}”.`} body="The filter is hiding every environment." action={{ label: "Clear search", onClick: () => setQ("") }} />
            ) : rows.map((endpoint) => {
              const isDown = down[endpoint.id] || endpoint.status === "down";
              const kind = endpoint.kind === "kubernetes" ? "Kubernetes" : "Docker";
              return (
                <div className="env-card" key={endpoint.id}>
                  <Link href={`/e/${endpoint.id}`}>
                    <span className="platform-tile"><Icon name={endpoint.kind === "kubernetes" ? "kubernetes" : "docker"} /></span>
                    <span className="env-card-text">
                      <span className="env-card-line">
                        <span className="env-card-name" title={endpoint.name}>{endpoint.name}</span>
                        <Badge state={isDown ? "down" : "up"} />
                      </span>
                      <span className="kind">{kind}</span>
                    </span>
                  </Link>
                  <button className="btn danger" type="button" aria-label={`Remove ${endpoint.name}`} onClick={() => { setError(""); setRemove(endpoint); }}>
                    Remove
                  </button>
                </div>
              );
            })}
            {rows.length > 0 ? <p className="pager">{rows.length === 1 ? "1 environment" : `${rows.length} environments`}</p> : null}
          </section>
        </>
      ) : null}
      {error && !remove ? <p className="field-error">{error}</p> : null}
      {dialog === "docker" ? <DockerDialog onClose={() => setDialog(null)} onAdd={addDocker} /> : null}
      {dialog === "k8s" ? <KubernetesDialog onClose={() => setDialog(null)} onAdd={addKubernetes} /> : null}
      {remove ? (
        <Dialog title={`Remove endpoint ${remove.name}?`} onClose={() => setRemove(null)}>
          <p className="note">Pisces forgets the connection. It does not delete containers or cluster objects.</p>
          {error ? <p className="field-error">{error}</p> : null}
          <div className="dialog-actions">
            <button className="btn" data-focus="first" type="button" onClick={() => setRemove(null)}>Cancel</button>
            <button className="btn danger" type="button" disabled={pending} onClick={() => void removeEndpoint()}>
              {pending ? "Removing…" : "Remove"}
            </button>
          </div>
        </Dialog>
      ) : null}
    </PageFrame>
  );
}
