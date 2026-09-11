/**
 * D-43: a small deterministic PRNG for the `/story` simulation.
 *
 * `?seed=` has to reproduce the identical run byte-for-byte -- same agent
 * positions, same compromise order, same payment attempts, same decisions --
 * so nothing in `lib/story` may call `Math.random()`. mulberry32 is a
 * standard, tiny, well-tested 32-bit generator; it is not cryptographic and
 * doesn't need to be, since nothing here is a security boundary.
 */

export type Rng = () => number;

/** mulberry32: seed -> a `Rng` producing floats in [0, 1). */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [min, max), min inclusive, max exclusive. */
export function randInt(rng: Rng, min: number, max: number): number {
  return Math.floor(rng() * (max - min)) + min;
}

/** Float in [min, max). */
export function randFloat(rng: Rng, min: number, max: number): number {
  return rng() * (max - min) + min;
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[randInt(rng, 0, items.length)]!;
}

/** True with probability `p` (0..1). */
export function chance(rng: Rng, p: number): boolean {
  return rng() < p;
}
