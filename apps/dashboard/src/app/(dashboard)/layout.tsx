import type { ReactNode } from "react";
import Link from "next/link";

const NAV = [
  { href: "/mandates", label: "Mandates" },
  { href: "/authorizations", label: "Authorizations" },
  { href: "/agents", label: "Agents & Keys" },
  { href: "/evidence", label: "Evidence" },
];

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <nav className="sidebar">
        <Link href="/mandates" className="brand">
          AgentPay
        </Link>
        <ul>
          {NAV.map((item) => (
            <li key={item.href}>
              <Link href={item.href}>{item.label}</Link>
            </li>
          ))}
        </ul>
        <ul style={{ marginTop: 24, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          <li>
            <form action="/logout" method="post">
              <button
                type="submit"
                style={{
                  all: "unset",
                  cursor: "pointer",
                  color: "var(--muted)",
                  padding: "6px 8px",
                  display: "block",
                }}
              >
                Log out
              </button>
            </form>
          </li>
        </ul>
      </nav>
      <main>{children}</main>
    </div>
  );
}
