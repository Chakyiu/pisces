"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ApiError, api } from "../lib/api";
import type { Endpoint, Page } from "../lib/types";
import { ErrorState, Loading } from "./bits";
import { useConsole } from "./shell";

export function DockerView({
  noun,
  children,
}: {
  noun: string;
  children: (endpoint: Endpoint) => ReactNode;
}) {
  const { current, ready, reportDown } = useConsole();
  if (!ready) return <Loading noun={noun} />;
  if (!current) {
    return <ErrorState title="Endpoint was not found." message="It may have been removed." attempts={0} onRetry={() => undefined} />;
  }
  if (current.kind !== "docker") {
    return (
      <div className="state">
        <h2>Kubernetes control is not in this build</h2>
        <p>This endpoint is saved. Workloads, pods, and services land in the next slice. Nothing was changed.</p>
      </div>
    );
  }
  return <DownReporter id={current.id} reportDown={reportDown}>{children(current)}</DownReporter>;
}

function DownReporter({ id, reportDown, children }: { id: string; reportDown: (id: string) => void; children: ReactNode }) {
  useEffect(() => {
    function onError(event: Event) {
      const detail = (event as CustomEvent<string>).detail;
      if (detail === "daemon_unreachable") reportDown(id);
    }
    window.addEventListener("pisces-api-error", onError);
    return () => window.removeEventListener("pisces-api-error", onError);
  }, [id, reportDown]);
  return children;
}

export function publishApiError(code: string) {
  window.dispatchEvent(new CustomEvent("pisces-api-error", { detail: code }));
}

export function usePaged<T>(path: string) {
  const [data, setData] = useState<Page<T> | null>(null);
  const [status, setStatus] = useState<"loading" | "error" | "ready">("loading");
  const [message, setMessage] = useState("");
  const [code, setCode] = useState("");
  const [attempts, setAttempts] = useState(0);
  const [at, setAt] = useState<Date | undefined>();

  async function load(retry: boolean) {
    const nextAttempts = retry ? attempts + 1 : attempts;
    if (retry) setAttempts(nextAttempts);
    setStatus("loading");
    try {
      const body = await api<Page<T>>(path);
      setData(body);
      setStatus("ready");
    } catch (err) {
      if (err instanceof ApiError && err.code === "cancelled") return;
      const nextCode = err instanceof ApiError ? err.code : "daemon_unreachable";
      publishApiError(nextCode);
      setCode(nextCode);
      setMessage(err instanceof ApiError ? err.message : "The engine did not answer within 10 seconds. Nothing on this page was changed.");
      setAt(new Date());
      setStatus("error");
    }
  }

  useEffect(() => {
    setAttempts(0);
    void load(false);
    // path is the cache key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return { data, status, message, code, attempts, at, retry: () => void load(true), reload: () => load(false) };
}

export function Pager({
  total,
  offset,
  noun,
  nextCursor,
  onPrev,
  onNext,
}: {
  total: number;
  offset: number;
  noun: string;
  nextCursor?: string | null;
  onPrev: () => void;
  onNext: () => void;
}) {
  if (total <= 50) return <p className="pager">{total} {noun}</p>;
  const end = Math.min(offset + 50, total);
  return (
    <p className="pager">
      {offset + 1}–{end} of {total}
      <button className="btn tiny" type="button" disabled={offset === 0} onClick={onPrev}>Previous</button>
      <button className="btn tiny" type="button" disabled={!nextCursor} onClick={onNext}>Next</button>
    </p>
  );
}

export function useGoto() {
  const router = useRouter();
  return (href: string) => router.push(href);
}
