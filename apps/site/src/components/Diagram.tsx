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
 * page scroll. These are wide. The widest is about six times as wide as it
 * is tall, and at 390px of viewport it rendered 56 pixels tall, which is a
 * picture nobody can read.
 *
 * So the image carries a `minWidth` as well as a `maxWidth`. Below that
 * width it stops shrinking and the box scrolls instead. The page itself
 * never scrolls: the overflow belongs to the figure. Measured at 390px on
 * every page that carries one.
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
  /**
   * Width below which the figure scrolls instead of shrinking further.
   * Set it from the diagram's shape: a wide flowchart needs more than a
   * tall sequence diagram to stay readable.
   */
  minWidth?: number;
}

export function Diagram({ name, alt, caption, maxWidth = 980, minWidth = 560 }: DiagramProps) {
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
              minWidth,
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
