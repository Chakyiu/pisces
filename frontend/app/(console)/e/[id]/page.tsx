"use client";

import { useEffect } from "react";
import Link from "next/link";
import { age, bytes, portList } from "../../../../lib/format";
import type { Overview } from "../../../../lib/types";
import { Badge, ErrorState, Loading } from "../../../../components/bits";
import { DockerView, usePaged } from "../../../../components/gate";
import { useConsole } from "../../../../components/shell";

export default function OverviewPage() {
  const { setHeader } = useConsole();
  useEffect(() => { setHeader({ title: "Overview" }); }, [setHeader]);
  return (
    <DockerView noun="overview">
      {(endpoint) => <OverviewBody id={endpoint.id} name={endpoint.name} />}
    </DockerView>
  );
}

function OverviewBody({ id, name }: { id: string; name: string }) {
  const query = usePaged<never>(`/api/endpoints/${id}/overview`);
  const data = query.data as unknown as Overview | null;
  if (query.status === "loading" && !data) return <Loading noun="overview" />;
  if (query.status === "error" || !data || !("engine" in data)) {
    return (
      <ErrorState
        title={`Docker endpoint ${name} is not responding.`}
        message={query.message || "The engine did not answer within 10 seconds. Nothing on this page was changed."}
        attempts={query.attempts}
        at={query.at}
        onRetry={query.retry}
      />
    );
  }
  const engine = data.engine;
  const counts = data.counts;
  return (
    <>
      <p className="engine-line">
        Engine {engine.version || "—"} · API {engine.apiVersion || "—"} · {engine.os || "—"} · {engine.cpus} CPUs · {bytes(engine.memoryBytes)}
      </p>
      <div className="tiles">
        <div className="tile key"><span>Running</span><strong>{counts.containersRunning}</strong></div>
        <div className="tile"><span>Stopped</span><strong>{counts.containersStopped}</strong></div>
        <div className="tile"><span>Images</span><strong>{counts.images}</strong></div>
        <div className="tile"><span>Volumes</span><strong>{counts.volumes}</strong></div>
        <div className="tile"><span>Networks</span><strong>{counts.networks}</strong></div>
      </div>
      <div>
        <h2 className="section-label">Latest containers</h2>
        {data.recentContainers.length === 0 ? (
          <p className="note">No containers on {name}.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Name</th><th>Image</th><th>State</th><th>Ports</th><th>Age</th></tr>
              </thead>
              <tbody>
                {data.recentContainers.map((item) => (
                  <tr key={item.id}>
                    <td className="name-cell" title={item.name}><Link href={`/e/${id}/containers/${encodeURIComponent(item.id)}`}>{item.name}</Link></td>
                    <td className="mono name-cell" title={item.image}>{item.image}</td>
                    <td><Badge state={item.state} /></td>
                    <td className="mono">{portList(item.ports)}</td>
                    <td className="mono">{age(item.created)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
