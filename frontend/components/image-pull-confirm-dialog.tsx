"use client";

import { useState } from "react";
import { Dialog } from "./bits";

export function ImagePullConfirmDialog({
  title,
  intro,
  confirmLabel,
  pending,
  onClose,
  onConfirm,
}: {
  title: string;
  intro: string;
  confirmLabel: string;
  pending: boolean;
  onClose: () => void;
  onConfirm: (repull: boolean) => void;
}) {
  const [repull, setRepull] = useState(false);

  return (
    <Dialog title={title} onClose={onClose}>
      <p>{intro}</p>
      <div className="pull-choices" role="radiogroup" aria-label="Image source">
        <label className="pull-choice">
          <input type="radio" name="image-source" checked={!repull} onChange={() => setRepull(false)} />
          <span>
            <strong>Use the image already on the host</strong>
            <span className="help">Skip pulling and deploy with what Docker already has locally.</span>
          </span>
        </label>
        <label className="pull-choice">
          <input type="radio" name="image-source" checked={repull} onChange={() => setRepull(true)} />
          <span>
            <strong>Repull images</strong>
            <span className="help">Pull the latest image from the registry before deploying.</span>
          </span>
        </label>
      </div>
      <div className="dialog-actions">
        <button className="btn" data-focus="first" type="button" onClick={onClose}>Cancel</button>
        <button className="btn primary" type="button" disabled={pending} onClick={() => onConfirm(repull)}>
          {pending ? `${confirmLabel}…` : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}