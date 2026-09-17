import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Bricolage_Grotesque, DM_Sans, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { WaysafeMark } from "@/components/WaysafeMark";
import { CONTACT_EMAIL } from "@/lib/constants";
import { BUILD_SHA, BUILT_AT } from "@/lib/build-info";

export const metadata: Metadata = {
  title: "Waysafe — the rail-side authorization and evidence layer",
  description:
    "Waysafe decides whether an AI agent may take an economic action. The payment rail asks before money moves, and every decision is signed, chained, and independently verifiable.",
};

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
  variable: "--font-bricolage",
});
const dmSans = DM_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-dm-sans",
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-jetbrains-mono",
});

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${bricolage.variable} ${dmSans.variable} ${jetbrainsMono.variable}`}>
      <head
        dangerouslySetInnerHTML={{
          __html: `<!-- build: ${BUILD_SHA} @ ${BUILT_AT} -->`,
        }}
      />
      <body>
        <header
          style={{
            background: "var(--midnight)",
            color: "var(--frost)",
            position: "sticky",
            top: 0,
            zIndex: 10,
          }}
        >
          <div
            className="container"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              padding: "16px 24px",
              flexWrap: "wrap",
            }}
          >
            <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
              <WaysafeMark size={26} />
              <span className="display" style={{ fontSize: "1.1rem", color: "var(--frost)" }}>
                Waysafe
              </span>
            </Link>
            <nav style={{ display: "flex", gap: 20, fontSize: "0.95rem", fontWeight: 500 }}>
              <Link href="/docs" className="link" style={{ color: "var(--teal-on-dark)" }}>
                Docs
              </Link>
              <Link href="/proof" className="link" style={{ color: "var(--teal-on-dark)" }}>
                Proof
              </Link>
            </nav>
          </div>
        </header>
        <main>{children}</main>
        <footer className="section-dark" style={{ padding: "40px 0" }}>
          <div
            className="container"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 16,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <WaysafeMark size={20} />
              <span className="mono muted" style={{ fontSize: "0.85rem" }}>
                Waysafe™
              </span>
            </div>
            <div className="mono muted" style={{ fontSize: "0.85rem", display: "flex", gap: 20, flexWrap: "wrap" }}>
              <a href={`mailto:${CONTACT_EMAIL}`} className="link">
                {CONTACT_EMAIL}
              </a>
              <span>© {new Date().getFullYear()} Waysafe</span>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
