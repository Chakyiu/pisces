"use client";

import { useId, useRef, useState, type ChangeEvent } from "react";
import type { EnvValue } from "../../../../../lib/types";

function parseDotenv(text: string): EnvValue[] {
  const rows: EnvValue[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equal = trimmed.indexOf("=");
    if (equal === -1) {
      rows.push({ key: trimmed, value: "" });
    } else {
      rows.push({ key: trimmed.slice(0, equal).trim(), value: trimmed.slice(equal + 1) });
    }
  }
  return rows;
}

function toDotenv(rows: EnvValue[]): string {
  return rows
    .filter((row) => row.key.trim())
    .map((row) => `${row.key}=${row.value}`)
    .join("\n");
}

export function StackEnvEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: EnvValue[];
  onChange: (value: EnvValue[]) => void;
  disabled?: boolean;
}) {
  const sectionId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [advanced, setAdvanced] = useState(false);
  const [bulk, setBulk] = useState(() => toDotenv(value));
  const [fileError, setFileError] = useState("");
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});

  function syncBulk(rows: EnvValue[]) {
    setBulk(toDotenv(rows));
  }

  function updateRow(index: number, patch: Partial<EnvValue>) {
    const next = value.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row));
    onChange(next);
    syncBulk(next);
  }

  function applyBulk(text: string) {
    const parsed = parseDotenv(text);
    onChange(parsed);
    setBulk(toDotenv(parsed));
    setRevealed({});
  }

  async function loadFile(event: ChangeEvent<HTMLInputElement>) {
    setFileError("");
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseDotenv(text);
      if (parsed.length === 0) {
        setFileError("No KEY=VALUE lines were found in that file.");
        return;
      }
      onChange(parsed);
      syncBulk(parsed);
      setRevealed({});
    } catch {
      setFileError("Could not read that file.");
    }
  }

  return (
    <section className="stack-env" aria-labelledby={sectionId}>
      <h2 id={sectionId} className="stack-env-title">Environment variables</h2>
      <p className="help stack-env-lead">
        You may use environment variables in your Compose file. Values set below are written to <span className="mono">stack.env</span> for{" "}
        <code className="mono">${"{"}VAR{"}"}</code> substitution during deploy. Services can also list <span className="mono">env_file: stack.env</span> in the Compose file.
      </p>
      <div className="alert info stack-env-callout" role="note">
        <strong>stack.env file</strong>
        <p className="help">When deploying from this web editor, Pisces creates <span className="mono">stack.env</span> from the variables you set below.</p>
      </div>
      <div className="stack-env-toolbar">
        <button className="btn linkish" type="button" disabled={disabled} onClick={() => setAdvanced((current) => !current)}>
          {advanced ? "Simple mode" : "Advanced mode"}
        </button>
        <p className="help">{advanced ? "Edit KEY=VALUE lines directly." : "Switch to advanced mode to copy and paste multiple variables."}</p>
      </div>
      {advanced ? (
        <label className="label">
          Environment file contents
          <textarea
            className="field stack-env-bulk"
            rows={8}
            spellCheck={false}
            disabled={disabled}
            value={bulk}
            onChange={(event) => {
              setBulk(event.target.value);
              applyBulk(event.target.value);
            }}
          />
        </label>
      ) : (
        <div className="edit-rows">
          {value.map((row, index) => (
            <div className="edit-row env-edit-row" key={index}>
              <input
                className="field"
                aria-label={`Environment variable ${index + 1} name`}
                placeholder="name"
                disabled={disabled}
                value={row.key}
                onChange={(event) => updateRow(index, { key: event.target.value })}
              />
              <input
                className="field"
                aria-label={`Environment variable ${index + 1} value`}
                placeholder="value"
                type={revealed[index] ? "text" : "password"}
                disabled={disabled}
                value={row.value}
                onChange={(event) => updateRow(index, { value: event.target.value })}
              />
              <button className="btn" type="button" disabled={disabled} onClick={() => setRevealed((current) => ({ ...current, [index]: !current[index] }))}>
                {revealed[index] ? "Hide" : "Reveal"}
              </button>
              <button
                className="btn"
                type="button"
                disabled={disabled}
                aria-label={`Remove environment variable ${index + 1}`}
                onClick={() => {
                  const next = value.filter((_, rowIndex) => rowIndex !== index);
                  onChange(next);
                  syncBulk(next);
                  setRevealed({});
                }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="stack-env-actions">
        <button
          className="btn"
          type="button"
          disabled={disabled}
          onClick={() => {
            const next = [...value, { key: "", value: "" }];
            onChange(next);
            syncBulk(next);
          }}
        >
          Add an environment variable
        </button>
        <button className="btn" type="button" disabled={disabled} onClick={() => fileInput.current?.click()}>
          Load variables from .env file
        </button>
        <input ref={fileInput} className="sr-only" type="file" accept=".env,text/plain" onChange={(event) => void loadFile(event)} />
      </div>
      {fileError ? <p className="field-error" role="alert">{fileError}</p> : null}
      <p className="help">Environment changes take effect after you deploy or update the stack.</p>
    </section>
  );
}

export function stackEnvPayload(rows: EnvValue[]): EnvValue[] {
  return rows.filter((row) => row.key.trim());
}