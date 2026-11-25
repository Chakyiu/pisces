"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError, api, setUnauthorizedHandler } from "../lib/api";
import { safeNextPath } from "../lib/ux";

function loginHref(ended: boolean): string {
  if (typeof window === "undefined" || window.location.pathname.startsWith("/login")) {
    return ended ? "/login?ended=1" : "/login";
  }
  const next = safeNextPath(`${window.location.pathname}${window.location.search}${window.location.hash}`);
  const params = new URLSearchParams();
  if (ended) params.set("ended", "1");
  if (next) params.set("next", next);
  const query = params.toString();
  return query ? `/login?${query}` : "/login";
}

export type Session =
  | { status: "checking" }
  | { status: "in"; username: string }
  | { status: "out"; ended: boolean }
  | { status: "error"; message: string };

type SessionValue = Session & { refresh: () => Promise<void>; signOut: () => void; signedIn: (username: string) => void };

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>({ status: "checking" });

  async function refresh() {
    setSession({ status: "checking" });
    try {
      const body = await api<{ username: string }>("/api/session", { allow401: true });
      setSession({ status: "in", username: body.username });
    } catch (err) {
      if (err instanceof ApiError && err.code === "unauthorized") {
        setSession({ status: "out", ended: err.message.includes("session ended") });
        return;
      }
      setSession({
        status: "error",
        message: err instanceof ApiError ? err.message : "The Pisces API did not answer within 10 seconds.",
      });
    }
  }

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setSession({ status: "out", ended: true });
      if (!window.location.pathname.startsWith("/login")) {
        window.location.assign(loginHref(true));
      }
    });
    void refresh();
  }, []);

  const value: SessionValue = {
    ...session,
    refresh,
    signedIn(username: string) {
      setSession({ status: "in", username });
    },
    signOut() {
      setSession({ status: "out", ended: false });
    },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("session missing");
  return value;
}
