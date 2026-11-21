"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError, api, setUnauthorizedHandler } from "../lib/api";

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
        message: err instanceof ApiError ? err.message : "The API did not answer within 10 seconds.",
      });
    }
  }

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setSession({ status: "out", ended: true });
      if (!window.location.pathname.startsWith("/login")) {
        window.location.assign("/login?ended=1");
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
