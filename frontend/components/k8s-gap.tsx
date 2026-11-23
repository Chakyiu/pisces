"use client";

import { Loading } from "./bits";
import { PageFrame, useConsole, type Crumb } from "./shell";

export function KubernetesGap({ title, crumbs }: { title: string; crumbs?: Crumb[] }) {
  const { refresh } = useConsole();
  return (
    <PageFrame title={title} crumbs={crumbs ?? [{ label: title }]} onRefresh={() => void refresh()}>
      <KubernetesGapBody title={title} />
    </PageFrame>
  );
}

export function KubernetesGapBody({ title }: { title: string }) {
  const { current, ready } = useConsole();
  if (!ready) return <Loading noun={title.toLowerCase()} />;
  if (!current) return <div className="state"><h2>Endpoint was not found.</h2></div>;
  if (current.kind !== "kubernetes") {
    return (
      <div className="state">
        <h2>{title} are a Kubernetes view</h2>
        <p>This endpoint is a Docker engine. Switch to a Kubernetes endpoint to use this nav.</p>
      </div>
    );
  }
  return (
    <div className="state placeholder-panel">
      <span className="badge warn"><i className="sq warn" />not in this build</span>
      <h2>Pisces can save this cluster, but cannot list {title.toLowerCase()} yet</h2>
      <p>The endpoint is saved as {current.name}. Lists and actions for {title.toLowerCase()} land in the next slice. Nothing was changed.</p>
    </div>
  );
}
