/**
 * D-45: the one phone shell shared by frames 01, 02, 03, 05, and 07 --
 * copied dimension-for-dimension from `design/film-storyboard/` (390×820
 * screen inside a 410×840 shell, no fake iOS status bar, no fake keyboard).
 * Content -- balances, the activity badge, transaction rows, overlay
 * notifications -- is always passed in as props; nothing here reads real
 * data or `.env` values (see `FilmClient.tsx`'s own note on frame 02).
 */

import type { ReactNode } from "react";
import { CARD_LABEL, NOTIF_APP_NAME, PERSONA_GREETING, PERSONA_INITIAL, PERSONA_NAME, WALLET_LABEL } from "@/lib/film/constants";
import { IconCardTab, IconSecure } from "./icons";

export interface PhoneRow {
  key: string;
  icon: ReactNode;
  iconBg: string;
  iconColor: string;
  title: string;
  subtitle: string;
  amount: string;
  status?: { text: string; color: string };
  rowBg?: string;
}

export interface PhoneNotification {
  key: string;
  top: number;
  rotateDeg?: number;
  appIcon: ReactNode;
  appBg: string;
  ringColor?: string;
  time: string;
  title: string;
  message: string;
}

export interface ActivityBadge {
  label: string;
  icon: ReactNode;
  bg: string;
  color: string;
}

const THEME = {
  light: {
    screenBg: "#FFFFFF",
    screenColor: "#07111F",
    greetColor: "#64748B",
    avatarBg: "#E2E8F0",
    avatarColor: "#475569",
    balcardBg: "#07111F",
    balcardColor: "#FFFFFF",
    walletrowBg: "#EEF2F7",
    walletIconBg: "#E2E8F0",
    walletIconColor: "#475569",
    tabsBg: "#FFFFFF",
    tabsBorder: "#E2E8F0",
    tabOn: "#07111F",
    tabOff: "#94A3B8",
  },
  dark: {
    screenBg: "#07111F",
    screenColor: "#F1F5F9",
    greetColor: "#94A3B8",
    avatarBg: "#1E293B",
    avatarColor: "#94A3B8",
    balcardBg: "#0F1B2D",
    balcardColor: "#F1F5F9",
    walletrowBg: "#0C1729",
    walletIconBg: "#1E293B",
    walletIconColor: "#94A3B8",
    tabsBg: "#07111F",
    tabsBorder: "#1E293B",
    tabOn: "#F1F5F9",
    tabOff: "#94A3B8",
  },
} as const;

export function Phone({
  variant,
  cardBalance,
  cardBalanceColor,
  walletBalance,
  activityBadge,
  rows,
  notifications,
}: {
  variant: "light" | "dark";
  cardBalance: string;
  cardBalanceColor?: string;
  walletBalance: string;
  activityBadge?: ActivityBadge | null;
  rows: PhoneRow[];
  notifications?: PhoneNotification[];
}) {
  const t = THEME[variant];
  return (
    <div className="film-phone" style={{ left: 1300, top: 118 }}>
      <div className="film-screen" style={{ background: t.screenBg, color: t.screenColor }}>
        <div className="film-screen-top">
          <div>
            <div className="film-greet" style={{ color: t.greetColor }}>{PERSONA_GREETING}</div>
            <div className="film-name">{PERSONA_NAME}</div>
          </div>
          <div className="film-avatar" style={{ background: t.avatarBg, color: t.avatarColor }}>{PERSONA_INITIAL}</div>
        </div>

        <div className="film-balcard" style={{ background: t.balcardBg, color: t.balcardColor }}>
          <div className="film-balcard-lbl">
            <span>Available · {CARD_LABEL}</span>
            <IconCardTab size={18} color="#94A3B8" />
          </div>
          <div className="film-balcard-amt" style={{ color: cardBalanceColor ?? t.balcardColor }}>{cardBalance}</div>
          <div className="film-balcard-sub">Agent card · limit set by you</div>
        </div>

        <div className="film-walletrow" style={{ background: t.walletrowBg }}>
          <div>
            <div className="film-wallet-t" style={{ color: variant === "dark" ? "#94A3B8" : "#64748B" }}>{WALLET_LABEL}</div>
            <div className="film-wallet-v" style={{ color: t.screenColor }}>{walletBalance}</div>
          </div>
          <div className="film-wallet-icon" style={{ background: t.walletIconBg }}>
            <IconSecure size={18} color={t.walletIconColor} />
          </div>
        </div>

        <div className="film-section">
          <div className="film-section-h">Agent activity</div>
          {activityBadge ? (
            <div className="film-activity-badge" style={{ background: activityBadge.bg, color: activityBadge.color }}>
              {activityBadge.icon}
              {activityBadge.label}
            </div>
          ) : null}
        </div>

        <div className="film-rows">
          {rows.map((row) => (
            <div className="film-row" key={row.key} style={{ background: row.rowBg ?? "transparent" }}>
              <div className="film-row-ic" style={{ background: row.iconBg, color: row.iconColor }}>{row.icon}</div>
              <div className="film-row-tx">
                <div className="film-row-t1">{row.title}</div>
                <div className="film-row-t2">{row.subtitle}</div>
              </div>
              <div className="film-row-right">
                <div className="film-row-am">{row.amount}</div>
                {row.status ? <div className="film-row-st" style={{ color: row.status.color }}>{row.status.text}</div> : null}
              </div>
            </div>
          ))}
        </div>

        <div className="film-tabs" style={{ background: t.tabsBg, borderTopColor: t.tabsBorder }}>
          <TabIcon on color={t.tabOn} offColor={t.tabOff} label="Home" kind="home" />
          <TabIcon color={t.tabOff} label="Cards" kind="card" />
          <TabIcon color={t.tabOff} label="Agent" kind="agent" />
          <TabIcon color={t.tabOff} label="Activity" kind="activity" />
        </div>

        {(notifications ?? []).map((n) => (
          <div
            className="film-notif"
            key={n.key}
            style={{
              top: n.top,
              transform: n.rotateDeg ? `rotate(${n.rotateDeg}deg)` : undefined,
              boxShadow: n.ringColor
                ? `0 18px 40px -12px rgba(2,6,23,0.35), 0 0 0 1.5px ${n.ringColor} inset`
                : undefined,
            }}
          >
            <div className="film-notif-app" style={{ background: n.appBg }}>{n.appIcon}</div>
            <div className="film-notif-body">
              <div className="film-notif-meta">
                <span>{NOTIF_APP_NAME}</span>
                <span>{n.time}</span>
              </div>
              <div className="film-notif-ttl">{n.title}</div>
              <div className="film-notif-msg">{n.message}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TabIcon({ kind, label, color, offColor, on }: { kind: "home" | "card" | "agent" | "activity"; label: string; color: string; offColor?: string; on?: boolean }) {
  void offColor;
  const icon =
    kind === "home" ? (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 11.5 12 5l8 6.5" />
        <path d="M6 10v9h12v-9" />
      </svg>
    ) : kind === "card" ? (
      <IconCardTab color={color} />
    ) : kind === "agent" ? (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="5" y="7" width="14" height="11" rx="3" />
        <path d="M12 4v3" />
        <circle cx="9.5" cy="12.5" r="0.9" fill={color} />
        <circle cx="14.5" cy="12.5" r="0.9" fill={color} />
      </svg>
    ) : (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 7h14" />
        <path d="M5 12h14" />
        <path d="M5 17h9" />
      </svg>
    );
  return (
    <div className={`film-tab ${on ? "film-tab--on" : ""}`} style={{ color }}>
      {icon}
      <span>{label}</span>
    </div>
  );
}
