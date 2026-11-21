"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, api } from "../../../lib/api";
import { Dialog, Empty } from "../../../components/bits";
import { useConsole } from "../../../components/shell";

export default function EndpointsPage() {
  const { endpoints, ready, refresh, setHeader } = useConsole();
  const router = useRouter();
  const [dialog, setDialog] = useState<"docker" | "k8s" | null>(null);
  const [name, setName] = useState("local");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => { setHeader({ title: "Endpoints" }); }, [setHeader]);
  useEffect(() => {
    if (ready && endpoints.length > 0) router.replace(`/e/${endpoints[0].id}`);
  }, [ready, endpoints, router]);

  if (!ready || endpoints.length > 0) return <p className="note">Loading endpoints</p>;

  async function add() {
    setPending(true);
    setError("");
    try {
      const created = await api<{ id: string }>("/api/endpoints", {
        method: "POST",
        body: { kind: "docker", name: name.trim() || "local" },
      });
      await refresh();
      router.push(`/e/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "The endpoint could not be added.");
      setPending(false);
    }
  }

  return (
    <>
      <Empty
        title="No endpoint yet."
        body="Pisces needs a Docker engine or a Kubernetes context before it can show anything. This machine’s Docker engine is the usual first step."
        action={{ label: "Add Docker endpoint", primary: true, onClick: () => { setName("local"); setDialog("docker"); } }}
      />
      <button className="btn" type="button" onClick={() => setDialog("k8s")}>Add Kubernetes context</button>
      {dialog === "docker" ? (
        <Dialog title="Add Docker endpoint" onClose={() => setDialog(null)}>
          <label className="label">
            Name
            <input className="field" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="label">
            Engine
            <input className="field" readOnly value="This machine" />
          </label>
          {error ? <p className="field-error">{error}</p> : null}
          <div className="dialog-actions">
            <button className="btn" type="button" onClick={() => setDialog(null)}>Cancel</button>
            <button className="btn primary" type="button" disabled={pending} onClick={() => void add()}>{pending ? "Adding…" : "Add"}</button>
          </div>
        </Dialog>
      ) : null}
      {dialog === "k8s" ? (
        <Dialog title="Add Kubernetes context" onClose={() => setDialog(null)}>
          <p className="note">No Kubernetes context is visible until the server can list one. Add stays disabled.</p>
          <KubernetesContexts />
          <div className="dialog-actions">
            <button className="btn" data-focus="first" type="button" onClick={() => setDialog(null)}>Cancel</button>
            <button className="btn primary" type="button" disabled>Add</button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}

function KubernetesContexts() {
  const [text, setText] = useState("Loading contexts…");
  useEffect(() => {
    api<{ items: { name: string }[] }>("/api/kubernetes/contexts")
      .then((body) => setText(body.items.length === 0 ? "No Kubernetes context is visible to the server." : body.items.map((item) => item.name).join(", ")))
      .catch((err: unknown) => setText(err instanceof ApiError ? `Couldn’t load contexts. ${err.message}` : "Couldn’t load contexts."));
  }, []);
  return <p className="note">{text}</p>;
}
