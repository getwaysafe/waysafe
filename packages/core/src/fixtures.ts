import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompilerFixture } from "./compiler/fixture.js";

/** Fixed instant every fixture is compiled against, so expiries are stable. */
export const FIXTURE_NOW = new Date("2026-08-24T12:00:00.000Z");

const here = dirname(fileURLToPath(import.meta.url));

/** Walk up from this module until we find the repo's fixtures directory. */
function findFixtureDir(): string {
  let current = here;
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(current, "fixtures", "compiler");
    try {
      readdirSync(candidate);
      return candidate;
    } catch {
      current = resolve(current, "..");
    }
  }
  throw new Error("could not locate fixtures/compiler directory");
}

export function loadCompilerFixtures(dir = findFixtureDir()): CompilerFixture[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
      return {
        name: parsed.name as string,
        intent_text: parsed.intent_text as string,
        output: parsed.output,
      } satisfies CompilerFixture;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getFixture(name: string): CompilerFixture {
  const found = loadCompilerFixtures().find((f) => f.name === name);
  if (!found) throw new Error(`no compiler fixture named "${name}"`);
  return found;
}
