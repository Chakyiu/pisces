"use client";

import { useEffect } from "react";
import { Loading } from "./bits";
import { useConsole } from "./shell";

export function KubernetesGap({ title }: { title: string }) {
  const { current, ready, setHeader } = useConsole();
  useEffect(() => { setHeader({ title }); }, [setHeader, title]);
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
