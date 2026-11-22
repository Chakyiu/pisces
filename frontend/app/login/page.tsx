"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ApiError, api } from "../../lib/api";
import { Gate, Icon } from "../../components/bits";
import { useSession } from "../../components/session";

export default function LoginPage() {
  const session = useSession();
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [usernameError, setUsernameError] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [rejected, setRejected] = useState(false);
  const [ended, setEnded] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setEnded(new URLSearchParams(window.location.search).get("ended") === "1" || (session.status === "out" && session.ended));
    if (session.status === "in") router.replace("/home");
  }, [session, router]);

  if (session.status === "checking" || session.status === "in") return <Gate title="Checking session" />;
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
      router.replace("/home");
    } catch (err) {
      if (err instanceof ApiError && err.code === "unauthorized") {
        setRejected(true);
        setEnded(false);
        setPassword("");
      }
      setPending(false);
    }
  }

  const passwordLabel = showPassword ? "Hide password" : "Show password";
  return (
    <div className="login">
      <div className="login-card">
        <div className="wordmark">Pisces</div>
        <h1>Sign in</h1>
        <p className="note">The console for the Docker engine on this machine, and for a Kubernetes context when one is available.</p>
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
              placeholder="Enter your username"
              autoComplete="username"
              disabled={pending}
              onBlur={() => setUsernameError(username.trim() ? "" : "Enter a username.")}
              onChange={(event) => setUsername(event.target.value)}
            />
            {usernameError ? <span className="field-error">{usernameError}</span> : null}
          </label>
          <label className="label">
            Password
            <span className="field-wrap">
              <input
                className="field"
                type={showPassword ? "text" : "password"}
                value={password}
                placeholder="Enter your password"
                autoComplete="current-password"
                disabled={pending}
                onBlur={() => setPasswordError(password ? "" : "Enter a password.")}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                className="icon-btn field-btn"
                type="button"
                aria-label={passwordLabel}
                title={passwordLabel}
                onClick={() => setShowPassword((value) => !value)}
              >
                <Icon name={showPassword ? "eye-off" : "eye"} />
              </button>
            </span>
            {passwordError ? <span className="field-error">{passwordError}</span> : null}
          </label>
          <button className="btn primary block" type="submit" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </button>
          <p className="note">This console has no sign-up. Use the account configured for the API.</p>
        </form>
      </div>
    </div>
  );
}
