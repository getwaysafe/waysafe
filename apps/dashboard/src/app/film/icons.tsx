/**
 * D-45: inline SVG icons, copied path-for-path from
 * `design/film-storyboard/` -- reproducing the reference exactly rather
 * than re-drawing approximations of it. Each icon takes only `size` and
 * `color`; the storyboard's own stroke width/linecap/linejoin values are
 * baked in per icon since they vary slightly by icon.
 */

import { useId } from "react";

interface IconProps {
  size?: number;
  color?: string;
}

/**
 * D-46: the real brand mark (`design/brand/waysafe-mark.svg`), inlined as a
 * component rather than an `<img>` -- two overlapping rounded squares (ink
 * `#1B1A17`/`#2D2C2A`) with the teal overlap (`#008389`), path-for-path
 * from the provided SVG. Fixed brand colors, not `currentColor` -- unlike
 * every other icon here, this one's palette is the brand's own and doesn't
 * change with the frame's light/dark accent. `useId` keeps the `clipPath`
 * id collision-free if the mark renders more than once on the page at
 * once (the notification icon and the "Waysafe on" pill both use it).
 */
export function IconWaysafeMark({ size = 24 }: { size?: number }) {
  const clipId = useId();
  return (
    <svg width={size} height={size * (256 / 304)} viewBox="0 0 304 256">
      <defs>
        <clipPath id={clipId}>
          <rect x="0" y="0" width="190" height="191" rx="34" />
        </clipPath>
      </defs>
      <rect x="0" y="0" width="190" height="191" rx="34" fill="#1B1A17" />
      <rect x="112" y="64" width="191" height="191" rx="34" fill="#2D2C2A" />
      <rect x="112" y="64" width="78" height="127" fill="#008389" clipPath={`url(#${clipId})`} />
    </svg>
  );
}

export function IconBed({ size = 20, color = "currentColor" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 18v-8" />
      <path d="M3 14h18v4" />
      <path d="M7 10.5V8h6a4 4 0 0 1 4 4v2" />
    </svg>
  );
}

export function IconBolt({ size = 20, color = "currentColor" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 3 5 14h6l-1 7 8-11h-6z" />
    </svg>
  );
}

export function IconCalendar({ size = 20, color = "currentColor" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="5" width="16" height="15" rx="2.5" />
      <path d="M4 10h16" />
      <path d="M8 3v4" />
      <path d="M16 3v4" />
    </svg>
  );
}

export function IconAlert({ size = 20, color = "currentColor" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 8v5" />
      <circle cx="12" cy="16" r="0.9" fill={color} />
    </svg>
  );
}

export function IconX({ size = 20, color = "currentColor" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 7l10 10" />
      <path d="M17 7 7 17" />
    </svg>
  );
}

/** The wallet/lock-swap glyph -- used for the wallet row icon and, in the
 * mandate card, the "signed" bullet. */
export function IconSecure({ size = 18, color = "currentColor" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="14" r="4" />
      <path d="M11 11.5 20 3" />
      <path d="M16.5 6.5 19 9" />
      <path d="M14 9l2 2" />
    </svg>
  );
}

/** The "robot head" glyph -- "Agent working" / "Waysafe on" pills, and the
 * Agent tab icon. */
export function IconRobot({ size = 14, color = "currentColor" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="7" width="14" height="11" rx="3" />
      <path d="M12 4v3" />
      <circle cx="9.5" cy="12.5" r="0.9" fill={color} />
      <circle cx="14.5" cy="12.5" r="0.9" fill={color} />
    </svg>
  );
}

/** The shield-check glyph -- the mandate card icon, and the Waysafe
 * notification app icon. */
export function IconShieldCheck({ size = 25, color = "#FFFFFF" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 5 6v6c0 4.2 3 7.4 7 9 4-1.6 7-4.8 7-9V6z" />
      <path d="m9.2 12.2 2 2 3.8-4" />
    </svg>
  );
}

/** A bare checkmark -- the "Verified independently" bar. */
export function IconCheck({ size = 22, color = "#22C55E" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 12.5 4 4 8-9" />
    </svg>
  );
}

/** The Harbor app's own notification-icon mark ("H"-like glyph). */
export function IconHarborMark({ size = 22, color = "#FFFFFF" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round">
      <path d="M5 18V6" />
      <path d="M19 18V6" />
      <path d="M5 12h14" />
    </svg>
  );
}

export function IconHome({ size = 24, color = "currentColor" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 11.5 12 5l8 6.5" />
      <path d="M6 10v9h12v-9" />
    </svg>
  );
}

export function IconCardTab({ size = 24, color = "currentColor" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="6" width="18" height="12" rx="2.5" />
      <path d="M3 10.5h18" />
      <path d="M7 14.5h3" />
    </svg>
  );
}

export function IconActivityTab({ size = 24, color = "currentColor" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 7h14" />
      <path d="M5 12h14" />
      <path d="M5 17h9" />
    </svg>
  );
}
