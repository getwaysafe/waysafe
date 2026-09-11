import { StoryClient } from "./StoryClient";

/** D-43: the default seed is not arbitrary -- it's this decision's own
 * number, so a bare `/story` always replays the same take unless someone
 * explicitly asks for a different one. */
const DEFAULT_SEED = 43;

export default async function StoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const autoplay = params.autoplay === "1";
  const seedParam = Array.isArray(params.seed) ? params.seed[0] : params.seed;
  const parsedSeed = seedParam !== undefined ? Number.parseInt(seedParam, 10) : NaN;
  const seed = Number.isFinite(parsedSeed) ? parsedSeed : DEFAULT_SEED;

  return <StoryClient seed={seed} autoplay={autoplay} />;
}
