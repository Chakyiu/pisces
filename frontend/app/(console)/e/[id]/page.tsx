"use client";

import { useRef } from "react";
import Link from "next/link";
import { bytes } from "../../../../lib/format";
import type { Overview } from "../../../../lib/types";
import { ErrorState, Loading } from "../../../../components/bits";
import { usePaged } from "../../../../components/gate";
import { KubernetesGap } from "../../../../components/k8s-gap";
import { PageFrame, useConsole } from "../../../../components/shell";

export default function DashboardPage() {
  const { current, ready } = useConsole();
  if (!ready) {
    return (
      <PageFrame title="Dashboard" crumbs={[{ label: "Environment summary" }]}>
        <Loading noun="dashboard" />
      </PageFrame>
    );
  }
  if (!current) {
    return (
      <PageFrame title="Dashboard" crumbs={[{ label: "Environment summary" }]}>
        <ErrorState title="Endpoint was not found." message="It may have been removed." attempts={0} />
      </PageFrame>
    );
  }
  if (current.kind !== "docker") {
    return <KubernetesGap title="Dashboard" crumbs={[{ label: "Environment summary" }]} />;
  }
  return <OverviewBody id={current.id} name={current.name} />;
}

function OverviewBody({ id, name }: { id: string; name: string }) {
  const refreshRef = useRef<() => void>(() => {});
  const query = usePaged<never>(`/api/endpoints/${id}/overview`);
  refreshRef.current = () => { void query.reload(); };
  const data = query.data as unknown as Overview | null;
  const counts = data && "counts" in data ? data.counts : null;
  const total = counts ? counts.containersRunning + counts.containersStopped : 0;
  return (
    <PageFrame title="Dashboard" crumbs={[{ label: "Environment summary" }]} onRefresh={() => refreshRef.current()}>
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
          <p className="engine-line">
            Engine {data.engine.version || "—"} · API {data.engine.apiVersion || "—"} · {data.engine.os || "—"} · {data.engine.cpus} CPUs · {bytes(data.engine.memoryBytes)}
          </p>
          <div className="tiles">
            <Link className="tile" href={`/e/${id}/containers`}>
              <span>Containers</span>
              <strong className="key">{total}</strong>
              <em>{counts.containersRunning} running · {counts.containersStopped} stopped</em>
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
        </>
      ) : null}
    </PageFrame>
  );
}
