"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ApiError, api } from "../../lib/api";
import { Gate } from "../../components/bits";
import { useSession } from "../../components/session";

export default function LoginPage() {
  const session = useSession();
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [usernameError, setUsernameError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [rejected, setRejected] = useState(false);
  const [ended, setEnded] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setEnded(new URLSearchParams(window.location.search).get("ended") === "1" || (session.status === "out" && session.ended));
    if (session.status === "in") router.replace("/endpoints");
  }, [session, router]);

  if (session.status === "checking") return <Gate title="Checking session" />;
  if (session.status === "error") {
    return <Gate title="The API did not answer within 10 seconds." onRetry={() => void session.refresh()} />;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const nextUser = username.trim() ? "" : "Enter a username.";
    const nextPass = password ? "" : "Enter a password.";
    setUsernameError(nextUser);
    setPasswordError(nextPass);
    if (nextUser || nextPass) return;
    setPending(true);
    setRejected(false);
    try {
      const body = await api<{ username: string }>("/api/session", {
        method: "POST",
        body: { username: username.trim(), password },
        allow401: true,
      });
      session.signedIn(body.username);
      router.replace("/endpoints");
    } catch (err) {
      if (err instanceof ApiError && err.code === "unauthorized") {
        setRejected(true);
        setEnded(false);
        setPassword("");
      }
      setPending(false);
    }
  }

  return (
    <div className="login">
      <section className="login-brand">
        <div className="kind">Pisces</div>
        <h1>Sign in</h1>
        <p>The console for the Docker engine on this machine, and for a Kubernetes context when one is available.</p>
      </section>
      <section className="login-form">
        <form onSubmit={(event) => void submit(event)}>
          {rejected ? (
            <div className="alert bad" role="alert">
              <strong>Those credentials were rejected.</strong>
              <p>Check the username and password, then try again.</p>
            </div>
          ) : null}
          {ended && !rejected ? (
            <div className="alert" role="alert">
              <strong>Your session ended. Sign in again.</strong>
            </div>
          ) : null}
          <label className="label">
            Username
            <input
              className="field"
              value={username}
              autoComplete="username"
              disabled={pending}
              onBlur={() => setUsernameError(username.trim() ? "" : "Enter a username.")}
              onChange={(event) => setUsername(event.target.value)}
            />
            {usernameError ? <span className="field-error">{usernameError}</span> : null}
          </label>
          <label className="label">
            Password
            <input
              className="field"
              type="password"
              value={password}
              autoComplete="current-password"
              disabled={pending}
              onBlur={() => setPasswordError(password ? "" : "Enter a password.")}
              onChange={(event) => setPassword(event.target.value)}
            />
            {passwordError ? <span className="field-error">{passwordError}</span> : null}
          </label>
          <button className="btn primary block" type="submit" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </button>
          <p className="note">This console has no sign-up. Use the account configured for the API.</p>
        </form>
      </section>
    </div>
  );
}
