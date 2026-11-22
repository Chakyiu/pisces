"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ApiError, api } from "../../../../../../lib/api";
import { useConsole, PageFrame } from "../../../../../../components/shell";
import { Dialog, Loading } from "../../../../../../components/bits";
import { DockerView } from "../../../../../../components/gate";
import { ComposeEditor } from "../compose-editor";

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_BYTES = 1_048_576;
const LOST_REQUEST = "The console lost the deploy request. Check the stack list before trying again. The engine may still be applying it.";

function nameError(value: string) {
  if (!value.trim()) return "Stack name is required";
  if (value === "new") return "“new” is reserved. Pick another name.";
  if (value.length > 63) return "Use at most 63 characters.";
  if (!NAME_PATTERN.test(value)) return "Use lowercase letters, digits, hyphens, and underscores, and start with a letter or digit.";
  return "";
}

function fileError(value: string) {
  if (!value.trim()) return "Stack file content is required";
  if (new TextEncoder().encode(value).byteLength > MAX_BYTES) return "This file is larger than 1 MB. Pisces accepts Compose files up to 1 MB.";
  return "";
}

export default function NewStackPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { current } = useConsole();
  const endpoint = current?.id === id ? current : undefined;
  const endpointName = endpoint?.name ?? "this endpoint";
  const [name, setName] = useState("");
  const [compose, setCompose] = useState("");
  const [nameErrorText, setNameErrorText] = useState("");
  const [composeError, setComposeError] = useState("");
  const [alert, setAlert] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [slow, setSlow] = useState(false);
  const [leave, setLeave] = useState(false);
  const [failures, setFailures] = useState(0);
  const [lastAttempt, setLastAttempt] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const dirty = Boolean(name || compose);

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (dirty || busy.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  if (!endpoint) return <PageFrame title="Add stack" crumbs={[{ label: "Stacks" }, { label: "Add stack" }]}><Loading noun="endpoint" /></PageFrame>;
  if (endpoint.kind !== "docker") return <PageFrame title="Add stack" crumbs={[{ label: "Stacks" }, { label: "Add stack" }]}><DockerView noun="stack">{() => null}</DockerView></PageFrame>;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAlert("");
    const invalidName = nameError(name);
    const invalidFile = fileError(compose);
    setNameErrorText(invalidName);
    setComposeError(invalidFile);
    if (invalidName) {
      nameRef.current?.focus();
      return;
    }
    if (invalidFile) {
      document.querySelector<HTMLTextAreaElement>("[name='compose-file']")?.focus();
      return;
    }

    busy.current = true;
    setSubmitting(true);
    setSlow(false);
    const slowTimer = window.setTimeout(() => setSlow(true), 15_000);
    try {
      await api(`/api/endpoints/${id}/stacks`, {
        method: "POST",
        body: { project: name, compose },
        timeoutMs: 310_000,
        failureMessage: LOST_REQUEST,
      });
      router.push(`/e/${id}/stacks/${encodeURIComponent(name)}?tab=stack&deployed=1`);
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "The engine did not answer.";
      if (error instanceof ApiError && error.code === "conflict") {
        setNameErrorText(`A stack named ${name} is already on ${endpointName}.`);
        nameRef.current?.focus();
      } else {
        setAlert(`Deploy failed. ${message || "The engine did not answer."}`);
      }
      setFailures((count) => count + 1);
      setLastAttempt(new Date().toLocaleTimeString());
    } finally {
      window.clearTimeout(slowTimer);
      busy.current = false;
      setSubmitting(false);
      setSlow(false);
    }
  }

  return (
    <PageFrame title="Add stack" crumbs={[{ label: "Stacks", href: `/e/${id}/stacks` }, { label: "Add stack" }]}>
      {alert ? <div className="alert bad" role="alert">{alert}</div> : null}
      <form className="stack-form" onSubmit={(event) => void submit(event)} noValidate>
        <div className="stack-field-wrap">
          <label className="label" htmlFor="stack-name">Name</label>
          <input
            ref={nameRef}
            id="stack-name"
            className="field"
            name="stack-name"
            placeholder="e.g. mystack"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            value={name}
            disabled={submitting}
            aria-invalid={Boolean(nameErrorText)}
            aria-describedby={`stack-name-hint${nameErrorText ? " stack-name-error" : ""}`}
            onBlur={() => setNameErrorText(nameError(name))}
            onChange={(event) => {
              const value = event.target.value;
              setName(value);
              if (nameErrorText && !nameError(value)) setNameErrorText("");
            }}
          />
          <p id="stack-name-hint" className="help">Lowercase letters, digits, hyphens, and underscores. Must start with a letter or digit. Up to 63 characters.</p>
          {nameErrorText ? <p id="stack-name-error" className="field-error" role="alert">{nameErrorText}</p> : null}
        </div>
        <p className="stack-note">This stack will be deployed using <a href="https://docs.docker.com/compose/" target="_blank" rel="noreferrer">Docker Compose</a>.</p>
        <div className="stack-fact"><span>Build method</span><strong>Web editor</strong></div>
        <ComposeEditor
          value={compose}
          onChange={(value) => {
            setCompose(value);
            if (composeError && !fileError(value)) setComposeError("");
          }}
          disabled={submitting}
          error={composeError}
        />
        <div className="stack-status" role="status" aria-live="polite">
          {submitting && slow ? "Taking longer than expected. Image pulls can take a minute." : ""}
        </div>
        {failures >= 3 ? <p className="help">Last attempted: {lastAttempt} · {failures} retries</p> : null}
        <div className="stack-actions">
          <button className="btn" type="button" disabled={submitting} onClick={() => dirty ? setLeave(true) : router.push(`/e/${id}/stacks`)}>Cancel</button>
          <button className="btn primary" type="submit" disabled={submitting}>{submitting ? "Deploying…" : "Deploy the stack"}</button>
        </div>
      </form>
      {leave ? (
        <Dialog title="Leave this page?" onClose={() => setLeave(false)}>
          <p>The stack has not been deployed.</p>
          <div className="dialog-actions">
            <button className="btn" data-focus="first" type="button" onClick={() => setLeave(false)}>Stay</button>
            <Link className="btn primary" href={`/e/${id}/stacks`}>Leave</Link>
          </div>
        </Dialog>
      ) : null}
    </PageFrame>
  );
}
