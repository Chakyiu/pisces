"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "../../../../lib/api";
import { age, bytes } from "../../../../lib/format";
import type { Overview, Page } from "../../../../lib/types";
import { Badge, ErrorState, Icon, Loading } from "../../../../components/bits";
import { usePaged } from "../../../../components/gate";
import { KubernetesGap } from "../../../../components/k8s-gap";
import { PageFrame, useConsole } from "../../../../components/shell";

export default function DashboardPage() {
  const { current, ready } = useConsole();
  if (!ready) {
    return (
      <PageFrame title="Dashboard" crumbs={[{ label: "Dashboard" }]}>
        <Loading noun="dashboard" />
      </PageFrame>
    );
  }
  if (!current) {
    return (
      <PageFrame title="Dashboard" crumbs={[{ label: "Dashboard" }]}>
        <ErrorState title="Endpoint was not found." message="It may have been removed." attempts={0} />
      </PageFrame>
    );
  }
  if (current.kind !== "docker") {
    return <KubernetesGap title="Dashboard" crumbs={[{ label: "Dashboard" }]} />;
  }
  return <OverviewBody id={current.id} name={current.name} />;
}

function OverviewBody({ id, name }: { id: string; name: string }) {
  const refreshRef = useRef<() => void>(() => {});
  const query = usePaged<never>(`/api/endpoints/${id}/overview`);
  const [stacks, setStacks] = useState<number | null>(null);
  const [pending, setPending] = useState(0);
  refreshRef.current = () => { void query.reload(); };
  const data = query.data as unknown as Overview | null;
  const counts = data && "counts" in data ? data.counts : null;
  const total = counts ? counts.containersRunning + counts.containersStopped : 0;
  useEffect(() => {
    let live = true;
    void api<Page<unknown>>(`/api/endpoints/${id}/stacks?limit=1`)
      .then((body) => { if (live) setStacks(body.total); })
      .catch(() => { if (live) setStacks(null); });
    void api<{ items: { status: string }[] }>("/api/proposals")
      .then((body) => { if (live) setPending(body.items.filter((item) => item.status === "pending").length); })
      .catch(() => { if (live) setPending(0); });
    return () => { live = false; };
  }, [id, query.data]);
  return (
    <PageFrame title="Dashboard" crumbs={[{ label: "Dashboard" }]} onRefresh={() => refreshRef.current()}>
      {query.status === "loading" && !data ? <Loading noun="overview" /> : null}
      {query.status === "error" ? (
        <ErrorState
          title={`Docker endpoint ${name} is not responding.`}
          message={query.message || "The engine did not answer within 10 seconds. Nothing on this page was changed."}
          attempts={query.attempts}
          at={query.at}
          onRetry={query.retry}
        />
      ) : null}
      {query.status !== "error" && data && "engine" in data && counts ? (
        <>
          {pending > 0 ? (
            <div className="alert info" role="status">
              <strong>
                <Link href="/ai-access/proposals">Review {pending} pending proposal{pending === 1 ? "" : "s"}</Link>
              </strong>
            </div>
          ) : null}
          <p className="engine-line">
            Engine {data.engine.version || "—"} · API {data.engine.apiVersion || "—"} · {data.engine.os || "—"} · {data.engine.cpus} CPUs · {bytes(data.engine.memoryBytes)}
          </p>
          <div className="tiles">
            <Link className="tile" href={`/e/${id}/containers`}>
              <span>Containers</span>
              <strong className="key">{total}</strong>
              <em>{counts.containersRunning} running · {counts.containersStopped} stopped</em>
            </Link>
            <Link className="tile" href={`/e/${id}/stacks`}>
              <span>Stacks</span>
              <strong>{stacks ?? "—"}</strong>
            </Link>
            <Link className="tile" href={`/e/${id}/images`}>
              <span>Images</span>
              <strong>{counts.images}</strong>
            </Link>
            <Link className="tile" href={`/e/${id}/networks`}>
              <span>Networks</span>
              <strong>{counts.networks}</strong>
            </Link>
            <Link className="tile" href={`/e/${id}/volumes`}>
              <span>Volumes</span>
              <strong>{counts.volumes}</strong>
            </Link>
          </div>
          {data.recentContainers?.length ? (
            <section className="widget">
              <div className="widget-head">
                <div className="widget-title">Recent containers</div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>State</th>
                      <th>Image</th>
                      <th>Created</th>
                      <th>Quick actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentContainers.map((item) => (
                      <tr key={item.id}>
                        <td className="name-cell" title={item.name}>
                          <Link className="name-link" href={`/e/${id}/containers/${encodeURIComponent(item.id)}`}>{item.name}</Link>
                        </td>
                        <td><Badge state={item.state} /></td>
                        <td className="mono name-cell" title={item.image}>{item.image}</td>
                        <td className="mono">{age(item.created)}</td>
                        <td>
                          <Link className="icon-btn" href={`/e/${id}/containers/${encodeURIComponent(item.id)}?tab=logs`} aria-label={`Logs ${item.name}`} title={`Logs ${item.name}`}>
                            <Icon name="logs" />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </PageFrame>
  );
}
