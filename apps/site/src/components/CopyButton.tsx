"use client";

import { useState } from "react";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {});
      }}
      className="mono"
      style={{
        position: "absolute",
        top: 12,
        right: 12,
        background: "rgba(247,249,252,0.1)",
        color: "var(--frost)",
        border: "1px solid rgba(148,163,184,0.35)",
        borderRadius: 6,
        padding: "4px 10px",
        fontSize: "0.75rem",
        cursor: "pointer",
      }}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}
