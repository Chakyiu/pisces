"use client";

import { useRef, useState } from "react";

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
  const [copyState, setCopyState] = useState("");
  const [copyError, setCopyError] = useState("");
  const lineCount = Math.max(1, value.split("\n").length);

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
          <h2 id="compose-heading">Web editor</h2>
          <p className="help">Define or paste the content of your Docker Compose file here.</p>
        </div>
        <button className="btn" type="button" disabled={!value || disabled} title={value ? "Copy Compose file" : "Nothing to copy"} onClick={() => void copy()}>
          Copy
        </button>
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
      {error ? <p id="compose-error" className="field-error" role="alert">{error}</p> : null}
    </section>
  );
}
