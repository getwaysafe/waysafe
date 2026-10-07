/**
 * A rendered diagram from `docs/diagrams/`, in the visitor's colour scheme.
 *
 * `<picture>` with a `prefers-color-scheme` source rather than two `<img>`s
 * and CSS: a browser picks exactly one source before any request is made, so
 * the scheme that is not shown is never downloaded.
 *
 * `alt` is required and should state the diagram's **one claim** — the thing
 * a reader who cannot see it still needs to know. Not "diagram of the card
 * path"; that tells a screen-reader user only that they are missing
 * something.
 *
 * The figure scrolls horizontally inside its own box rather than letting the
 * page scroll: these are wide, and at 390px a sequence diagram legibly
 * does not fit. `max-width: 100%` on the image keeps the common case
 * unscrolled.
 */

interface DiagramProps {
  /** Base name in `apps/site/public/diagrams`, e.g. "card". */
  name: string;
  /** The diagram's one claim, as a sentence. Required. */
  alt: string;
  /** Shown under the figure, for sighted readers. Optional. */
  caption?: React.ReactNode;
  /** Natural display width in px. The image never exceeds its container. */
  maxWidth?: number;
}

export function Diagram({ name, alt, caption, maxWidth = 980 }: DiagramProps) {
  return (
    <figure style={{ margin: "32px 0", maxWidth: "100%" }}>
      <div style={{ overflowX: "auto", maxWidth: "100%", WebkitOverflowScrolling: "touch" }}>
        <picture>
          <source srcSet={`/diagrams/${name}-dark.svg`} media="(prefers-color-scheme: dark)" />
          <img
            src={`/diagrams/${name}-light.svg`}
            alt={alt}
            loading="lazy"
            decoding="async"
            style={{
              display: "block",
              width: "100%",
              maxWidth,
              height: "auto",
              borderRadius: 10,
              border: "1px solid var(--hairline)",
            }}
          />
        </picture>
      </div>
      {caption ? (
        <figcaption
          className="muted"
          style={{ fontSize: "0.92rem", lineHeight: 1.6, marginTop: 10, maxWidth: 700 }}
        >
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}
