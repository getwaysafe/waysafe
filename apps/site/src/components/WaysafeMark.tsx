/**
 * The real brand mark (`design/brand/waysafe-mark.svg`), inlined path-for-
 * path rather than loaded as an `<img>` -- two overlapping rounded squares
 * (ink `#1B1A17`/`#2D2C2A`) with the teal overlap (`#008389`), fixed brand
 * colors regardless of the section's own light/dark accent. A fixed
 * `clipPath` id is safe here (unlike a component with per-instance dynamic
 * content) since the clipped shape never varies between instances.
 */
export function WaysafeMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size * (256 / 304)} viewBox="0 0 304 256" aria-hidden="true">
      <defs>
        <clipPath id="waysafe-mark-clip">
          <rect x="0" y="0" width="190" height="191" rx="34" />
        </clipPath>
      </defs>
      <rect x="0" y="0" width="190" height="191" rx="34" fill="#1B1A17" />
      <rect x="112" y="64" width="191" height="191" rx="34" fill="#2D2C2A" />
      <rect x="112" y="64" width="78" height="127" fill="#008389" clipPath="url(#waysafe-mark-clip)" />
    </svg>
  );
}
