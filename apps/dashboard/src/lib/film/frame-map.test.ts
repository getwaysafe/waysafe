import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BEATS } from "./phases";
import { FRAME_FOR_BEAT, frameForBeat } from "./frame-map";

describe("/film frame -> beat mapping (D-45)", () => {
  it("names a frame for every beat phases.ts defines", () => {
    for (const beat of BEATS) {
      expect(FRAME_FOR_BEAT[beat.id]).toBeDefined();
    }
  });

  it("frameForBeat matches the table for every beat", () => {
    for (const beat of BEATS) {
      expect(frameForBeat(beat.id)).toBe(FRAME_FOR_BEAT[beat.id]);
    }
  });

  it("groups beats onto frames exactly as design/film-storyboard/README.md documents", () => {
    const readme = readFileSync(join(process.cwd(), "design", "film-storyboard", "README.md"), "utf8");
    // Each row is "| file | beats (comma-separated) | background |" -- check
    // every beat this module says belongs to a frame is actually listed in
    // that frame's own README row.
    const rows = readme
      .split("\n")
      .filter((line) => line.startsWith("|") && line.includes("-"))
      .map((line) => line.split("|").map((cell) => cell.trim()));

    for (const beat of BEATS) {
      const frame = FRAME_FOR_BEAT[beat.id];
      const row = rows.find((r) => r[1] === frame);
      expect(row, `no README row for frame ${frame}`).toBeDefined();
      const beatsInRow = row![2]!.split(",").map((s) => s.trim());
      expect(beatsInRow).toContain(beat.id);
    }
  });

  it("every frame named in the mapping owns at least one beat", () => {
    const frames = new Set(Object.values(FRAME_FOR_BEAT));
    expect(frames.size).toBe(10);
  });
});
