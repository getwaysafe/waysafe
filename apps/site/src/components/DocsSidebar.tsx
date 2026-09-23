"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { DOCS_NAV } from "@/lib/docs-nav";

/**
 * Left sidebar on desktop, a disclosure menu on mobile. Client component
 * only because it needs `usePathname` to mark the current page and local
 * state for the mobile toggle -- everything it renders is static.
 */
export function DocsSidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const links = DOCS_NAV.map((item) => {
    const active = pathname === item.href;
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={() => setOpen(false)}
        aria-current={active ? "page" : undefined}
        style={{
          display: "block",
          padding: "7px 12px",
          borderRadius: 6,
          textDecoration: "none",
          fontSize: "0.95rem",
          lineHeight: 1.4,
          fontWeight: active ? 600 : 400,
          color: active ? "var(--ink)" : "var(--muted-ink, #55606b)",
          background: active ? "rgba(13,148,136,0.10)" : "transparent",
          borderLeft: active ? "2px solid var(--teal, #0d9488)" : "2px solid transparent",
        }}
      >
        {item.label}
      </Link>
    );
  });

  return (
    <>
      {/* Mobile: a real <details> disclosure, so it works with no JS too. */}
      <details
        className="docs-menu-mobile"
        open={open}
        onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
        style={{ marginBottom: 24 }}
      >
        <summary style={{ cursor: "pointer", fontWeight: 600, padding: "8px 0" }}>
          Documentation menu
        </summary>
        <nav style={{ marginTop: 8 }}>{links}</nav>
      </details>

      {/* Desktop: sticky sidebar. */}
      <nav className="docs-sidebar" aria-label="Documentation">
        <p
          className="kicker"
          style={{ marginBottom: 10, fontSize: "0.72rem", letterSpacing: "0.08em" }}
        >
          Documentation
        </p>
        {links}
      </nav>
    </>
  );
}
