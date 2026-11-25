"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./bits";

type Connection = { shell: string; user: string };
type Status = "disconnected" | "connecting" | "connected" | "disconnecting" | "error";

export function ContainerConsole({
  endpointId,
  containerId,
  running,
  onClose,
}: {
  endpointId: string;
  containerId: string;
  running: boolean;
  onClose: () => void;
}) {
  const terminalHost = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const [shell, setShell] = useState("sh");
  const [user, setUser] = useState("default");
  const [connection, setConnection] = useState<Connection | null>(null);
  const [status, setStatus] = useState<Status>("disconnected");
  const [error, setError] = useState("");

  useEffect(() => {
    const host = terminalHost.current;
    if (!host) return;

    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      scrollback: 3000,
      theme: { background: "#0b1120", foreground: "#e8f0fe", cursor: "#ffb800" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    term.element?.setAttribute("aria-label", "Container terminal");
    fit.fit();
    term.writeln("Select a shell and connect to start a session.");
    terminal.current = term;
    fitAddon.current = fit;

    const sendResize = () => {
      const current = socket.current;
      if (current?.readyState === WebSocket.OPEN) {
        current.send(JSON.stringify({ type: "resize", width: term.cols, height: term.rows }));
      }
    };
    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      sendResize();
    });
    resizeObserver.observe(host);
    const input = term.onData((data) => {
      const current = socket.current;
      if (current?.readyState === WebSocket.OPEN && new Blob([data]).size <= 32 * 1024) {
        current.send(JSON.stringify({ type: "input", data }));
      }
    });

    return () => {
      input.dispose();
      resizeObserver.disconnect();
      const current = socket.current;
      socket.current = null;
      if (current && current.readyState < WebSocket.CLOSING) current.close(1000, "Console closed");
      fit.dispose();
      term.dispose();
      terminal.current = null;
      fitAddon.current = null;
    };
  }, []);

  useEffect(() => {
    if (!connection || !running) return;
    const term = terminal.current;
    const fit = fitAddon.current;
    if (!term || !fit) return;

    setStatus("connecting");
    setError("");
    term.writeln(`\r\nConnecting to ${connection.shell === "sh" ? "/bin/sh" : `/bin/${connection.shell}`}…`);

    const query = new URLSearchParams({ shell: connection.shell, user: connection.user });
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    const path = `/api/endpoints/${encodeURIComponent(endpointId)}/containers/${encodeURIComponent(containerId)}/console?${query}`;
    const current = new WebSocket(`${scheme}//${window.location.host}${path}`);
    current.binaryType = "arraybuffer";
    socket.current = current;
    let serverFailure = false;
    let connectionFailure = false;

    current.onopen = () => {
      setStatus("connected");
      term.writeln("Connected. Use Disconnect to end the session.");
      fit.fit();
      current.send(JSON.stringify({ type: "resize", width: term.cols, height: term.rows }));
      term.focus();
    };
    current.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
      if (typeof event.data === "string") {
        serverFailure = true;
        const message = event.data.trim();
        setError(message);
        setStatus("error");
        term.writeln(`\r\n${message}`);
        current.close(1011, "Console could not start");
      } else {
        term.write(new Uint8Array(event.data));
      }
    };
    current.onerror = () => {
      if (!serverFailure) {
        connectionFailure = true;
        setError("The console connection failed. Check your session and container, then try again.");
        setStatus("error");
      }
    };
    current.onclose = () => {
      if (socket.current === current) socket.current = null;
      if (serverFailure || connectionFailure) return;
      setStatus("disconnected");
      term.writeln("\r\n[Console disconnected]");
    };

    return () => {
      current.onopen = null;
      current.onmessage = null;
      current.onerror = null;
      current.onclose = null;
      if (socket.current === current) socket.current = null;
      if (current.readyState < WebSocket.CLOSING) current.close(1000, "Console closed");
    };
  }, [connection, endpointId, containerId, running]);

  useEffect(() => {
    if (running) return;
    const current = socket.current;
    if (current && current.readyState < WebSocket.CLOSING) {
      setStatus("disconnecting");
      current.close(1000, "Container stopped");
    }
  }, [running]);

  function connect() {
    setError("");
    setStatus("connecting");
    setConnection({ shell, user });
  }

  function disconnect() {
    setStatus("disconnecting");
    const current = socket.current;
    if (current && current.readyState < WebSocket.CLOSING) current.close(1000, "User disconnected");
    else setStatus("disconnected");
  }

  return (
    <section className="widget console-widget" id="container-console" aria-label="Container console">
      <div className="widget-head">
        <h2 className="widget-title"><Icon name="console" /> Console</h2>
        <div className="console-controls">
          <label className="console-choice">
            <span>Shell</span>
            <select className="select" value={shell} disabled={status === "connecting" || status === "connected" || status === "disconnecting"} onChange={(event) => setShell(event.target.value)}>
              <option value="sh">/bin/sh</option>
              <option value="bash">/bin/bash</option>
              <option value="ash">/bin/ash</option>
            </select>
          </label>
          <label className="console-choice">
            <span>User</span>
            <select className="select" value={user} disabled={status === "connecting" || status === "connected" || status === "disconnecting"} onChange={(event) => setUser(event.target.value)}>
              <option value="default">Container default</option>
              <option value="root">root</option>
            </select>
          </label>
          {status === "connected" || status === "connecting" || status === "disconnecting" ? (
            <button className="btn danger" type="button" title="Disconnect console" disabled={status === "disconnecting"} onClick={disconnect}>
              <Icon name="stop" /> {status === "connecting" ? "Cancel" : status === "disconnecting" ? "Disconnecting…" : "Disconnect"}
            </button>
          ) : (
            <button className="btn primary" type="button" title="Connect console" disabled={!running} onClick={connect}>
              <Icon name="play" /> Connect
            </button>
          )}
          <button className="btn" type="button" title="Close console" onClick={onClose}>Close</button>
        </div>
      </div>
      {user === "root" ? <p className="note" role="status">Running shell as root</p> : null}
      <div className="console-status" role={error ? "alert" : "status"} aria-live="polite">
        {error || (status === "connected" ? "Connected" : status === "connecting" ? "Connecting…" : status === "disconnecting" ? "Disconnecting…" : running ? "Disconnected" : "Start the container to use the console.")}
      </div>
      <div className="console-terminal" ref={terminalHost} />
    </section>
  );
}
