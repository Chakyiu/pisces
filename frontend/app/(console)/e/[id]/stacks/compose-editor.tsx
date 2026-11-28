"use client";

import { useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type KeyboardEvent } from "react";
import { applyComposeTab, composeForEditor } from "../../../../../lib/compose-yaml";
import { highlightCompose } from "../../../../../lib/compose-highlight";

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
  const highlight = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingSelection = useRef<{ start: number; end: number } | null>(null);
  const [copyState, setCopyState] = useState("");
  const [copyError, setCopyError] = useState("");
  const [fileError, setFileError] = useState("");
  const lineCount = Math.max(1, value.split("\n").length);
  const colored = useMemo(() => highlightCompose(value), [value]);

  function syncScroll() {
    const field = area.current;
    if (!field) return;
    if (gutter.current) gutter.current.scrollTop = field.scrollTop;
    if (highlight.current) highlight.current.style.transform = `translate(${-field.scrollLeft}px, ${-field.scrollTop}px)`;
  }

  useLayoutEffect(() => {
    const sel = pendingSelection.current;
    const field = area.current;
    if (!sel || !field) return;
    pendingSelection.current = null;
    field.selectionStart = sel.start;
    field.selectionEnd = sel.end;
  }, [value]);

  useLayoutEffect(() => {
    syncScroll();
  });

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Tab" || disabled) return;
    event.preventDefault();
    const next = applyComposeTab(event.currentTarget.value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd, event.shiftKey);
    pendingSelection.current = { start: next.selectionStart, end: next.selectionEnd };
    onChange(next.value);
  }

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
      onChange(composeForEditor(text));
    } catch {
      setFileError("Could not read that file.");
    }
  }

  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (disabled) return;
    const raw = event.clipboardData.getData("text");
    if (!raw.trim()) return;
    const normalized = composeForEditor(raw);
    if (normalized === raw) return;
    event.preventDefault();
    const field = area.current;
    if (!field) {
      onChange(normalized);
      return;
    }
    const start = field.selectionStart ?? value.length;
    const end = field.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + normalized + value.slice(end));
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
        <div className={disabled ? "compose-edit is-disabled" : "compose-edit"}>
          <div className="compose-highlight" aria-hidden="true">
            <div className="compose-highlight-inner" ref={highlight}>
              {colored.map((tokens, lineIndex) => (
                <div className="compose-line" key={lineIndex}>
                  {tokens.map((token, tokenIndex) => (
                    <span key={tokenIndex} className={token.type === "plain" ? undefined : `tok-${token.type}`}>{token.text}</span>
                  ))}
                </div>
              ))}
            </div>
          </div>
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
            onKeyDown={onKeyDown}
            onPaste={paste}
            onScroll={syncScroll}
          />
        </div>
      </div>
      <div className="compose-caption-row">
        <p id="compose-caption" className="help">Tab inserts spaces. Ctrl+F or ⌘F to search</p>
        <span className="help" role="status" aria-live="polite">{copyState || copyError}</span>
      </div>
      {fileError ? <p className="field-error" role="alert">{fileError}</p> : null}
      {error ? <p id="compose-error" className="field-error" role="alert">{error}</p> : null}
    </section>
  );
}
