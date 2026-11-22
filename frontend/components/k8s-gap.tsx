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
    <div className="state">
      <h2>Kubernetes control is not in this build</h2>
      <p>The endpoint is saved. Lists and actions for {title.toLowerCase()} land in the next slice. Nothing was changed.</p>
    </div>
  );
}
