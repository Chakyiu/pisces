"use client";

import { useRef, useState, type ChangeEvent } from "react";

export function ComposeEditor({
  value,
  onChange,
  disabled = false,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  error?: string;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLPreElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [copyState, setCopyState] = useState("");
  const [copyError, setCopyError] = useState("");
  const [fileError, setFileError] = useState("");
  const lineCount = Math.max(1, value.split("\n").length);

  async function loadFile(event: ChangeEvent<HTMLInputElement>) {
    setFileError("");
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      if (!text.trim()) {
        setFileError("The file was empty.");
        return;
      }
      onChange(text);
    } catch {
      setFileError("Could not read that file.");
    }
  }

  async function copy() {
    setCopyError("");
    try {
      await navigator.clipboard.writeText(value);
      setCopyState("Copied");
      window.setTimeout(() => setCopyState(""), 2000);
    } catch {
      setCopyError("Couldn’t copy. Select the file and copy it yourself.");
    }
  }

  return (
    <section className="compose-editor" aria-labelledby="compose-heading">
      <div className="compose-editor-head">
        <div>
          <h2 id="compose-heading">Compose YAML</h2>
          <p className="help">Define or paste your stack as Docker Compose YAML here.</p>
        </div>
        <div className="compose-editor-actions">
          <button className="btn" type="button" disabled={disabled} onClick={() => fileInput.current?.click()}>
            Load YAML file
          </button>
          <button className="btn" type="button" disabled={!value || disabled} title={value ? "Copy Compose file" : "Nothing to copy"} onClick={() => void copy()}>
            Copy
          </button>
          <input ref={fileInput} className="sr-only" type="file" accept=".yml,.yaml,text/yaml,text/plain" onChange={(event) => void loadFile(event)} />
        </div>
      </div>
      <p className="help compose-docs">You can get more information about the Compose file format in the <a href="https://docs.docker.com/compose/compose-file/" target="_blank" rel="noreferrer">official documentation</a>.</p>
      <p id="compose-hint" className="help">This form does not upload a build directory. Set stack environment variables in the section below; Pisces writes <span className="mono">stack.env</span> for deploy. Images must be ones the engine can pull.</p>
      <div className="compose-well">
        <pre className="compose-gutter" aria-hidden="true" ref={gutter}>{Array.from({ length: lineCount }, (_, index) => index + 1).join("\n")}</pre>
        <textarea
          ref={area}
          className="compose-area"
          name="compose-file"
          aria-labelledby="compose-heading"
          aria-describedby={`compose-caption compose-hint${error ? " compose-error" : ""}`}
          aria-invalid={Boolean(error)}
          autoComplete="off"
          spellCheck={false}
          lang="yaml"
          data-language="yaml"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onScroll={(event) => { if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop; }}
        />
      </div>
      <div className="compose-caption-row">
        <p id="compose-caption" className="help">Ctrl+F or ⌘F to search</p>
        <span className="help" role="status" aria-live="polite">{copyState || copyError}</span>
      </div>
      {fileError ? <p className="field-error" role="alert">{fileError}</p> : null}
      {error ? <p id="compose-error" className="field-error" role="alert">{error}</p> : null}
    </section>
  );
}
