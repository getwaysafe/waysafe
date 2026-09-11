import { FilmClient } from "./FilmClient";

/** D-44: no particular significance beyond being this decision's own
 * number, matching /story's convention of defaulting `?seed=` to the
 * decision that built the page. */
const DEFAULT_SEED = 44;

export default async function FilmPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const autoplay = params.autoplay === "1";
  const seedParam = Array.isArray(params.seed) ? params.seed[0] : params.seed;
  const parsedSeed = seedParam !== undefined ? Number.parseInt(seedParam, 10) : NaN;
  const seed = Number.isFinite(parsedSeed) ? parsedSeed : DEFAULT_SEED;

  return <FilmClient seed={seed} autoplay={autoplay} />;
}
