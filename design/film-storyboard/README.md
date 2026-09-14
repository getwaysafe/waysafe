# /film storyboard — reference frames

Ten 1920×1080 frames, one per beat group of `apps/dashboard/src/lib/film/phases.ts`.
Open any file in a browser at 1920×1080 (or zoom out) — they are plain HTML/CSS, no build step.
`/film` is built to match these frames exactly: composition, colors, type, phone UI, copy.

| File | Beats (phases.ts) | Background |
|---|---|---|
| 01-intro | intro | light |
| 02-compromise | compromise | dark |
| 03-drain-empty | drain, empty | dark |
| 04-replay-intro | replay-intro | light |
| 05-decline-card-1 | decline-card-1 | dark |
| 06-quote-decline-stablecoin | quote, decline-stablecoin | dark |
| 07-allow-fleet-glimpse | decline-card-2, allow, fleet-glimpse | light |
| 08-receipt-chain-verify | receipt, chain, verify | light |
| 09-aftermath | results | light |
| 10-endcard | endcard | dark |

The bottom-left strip on each frame (`01 / 10 · 0:00 – 0:04 · intro`) is storyboard chrome — it does NOT appear in the film.
The bottom-right honesty tag shown on each frame here does NOT appear per-frame in the film as of D-46 — the disclosure
moved to a single footnote on the end card instead (see DECISIONS.md D-46). These reference frames keep their own
per-frame tags as historical record of the layout; only their accent hex values were updated to match D-46's palette.

Palette: midnight `#07111F`, frosted white `#F7F9FC`, brand teal accent `#008389` on light frames / `#22B8BE` on
midnight frames (D-46; replaces the earlier cyan `#38BDF8`/glow `#29D3FF`), slate `#64748B` / `#94A3B8`,
hairline `#CBD5E1`, ALLOW `#22C55E`, STEP_UP `#F59E0B`, DENY `#EF4444`.
Type: Bricolage Grotesque (display), DM Sans (body), JetBrains Mono (codes, tags) — Google Fonts.
Brand mark: `design/brand/waysafe-mark.svg` (ink `#1B1A17`/`#2D2C2A`, teal `#008389`); full lockup:
`design/brand/waysafe-logo.png`.

Note: frame 10's own composition here (dark background, icon + wordmark) is left as originally designed —
only its accent hex values were updated. The real end card (D-46) diverges from this mockup on purpose: it
switched to the light background and the real brand lockup, superseding this frame's layout for that one beat.
