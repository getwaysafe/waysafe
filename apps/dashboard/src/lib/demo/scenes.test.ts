import { describe, expect, it } from "vitest";
import {
  SCENES,
  AUTOPLAY_PAUSE_MS,
  currentScene,
  goToScene,
  initialSceneState,
  isFirstScene,
  isLastScene,
  nextScene,
  prevScene,
} from "./scenes";

describe("demo scene state machine (D-42)", () => {
  it("starts on the mandate scene", () => {
    const state = initialSceneState();
    expect(currentScene(state).id).toBe("mandate");
    expect(isFirstScene(state)).toBe(true);
    expect(isLastScene(state)).toBe(false);
  });

  it("advances one scene at a time on nextScene, in the declared order", () => {
    let state = initialSceneState();
    const seen: string[] = [currentScene(state).id];
    for (let i = 0; i < SCENES.length - 1; i += 1) {
      state = nextScene(state);
      seen.push(currentScene(state).id);
    }
    expect(seen).toEqual(SCENES.map((s) => s.id));
  });

  it("never advances past the last scene", () => {
    let state = initialSceneState();
    for (let i = 0; i < SCENES.length + 5; i += 1) state = nextScene(state);
    expect(isLastScene(state)).toBe(true);
    expect(currentScene(state).id).toBe(SCENES[SCENES.length - 1]!.id);
  });

  it("never regresses past the first scene", () => {
    let state = initialSceneState();
    for (let i = 0; i < 5; i += 1) state = prevScene(state);
    expect(isFirstScene(state)).toBe(true);
    expect(currentScene(state).id).toBe("mandate");
  });

  it("next and prev are inverses at an interior scene", () => {
    let state = initialSceneState();
    state = nextScene(nextScene(state));
    const before = currentScene(state).id;
    state = prevScene(nextScene(state));
    expect(currentScene(state).id).toBe(before);
  });

  it("goToScene jumps directly to a named scene", () => {
    const state = goToScene(initialSceneState(), "bypass");
    expect(currentScene(state).id).toBe("bypass");
  });

  it("goToScene is a no-op for an unknown id", () => {
    const state = initialSceneState();
    // @ts-expect-error -- deliberately an invalid SceneId to prove the guard
    const result = goToScene(state, "not_a_real_scene");
    expect(result).toEqual(state);
  });

  it("includes the honestly-labeled card-rail placeholder scene, not a faked Stripe scene", () => {
    const cardRail = SCENES.find((s) => s.id === "card_rail");
    expect(cardRail).toBeDefined();
    expect(cardRail!.caption).toContain("pending Stripe sandbox activation");
    expect(cardRail!.caption).toContain("D-37");
  });

  it("every scene has a non-empty title and a one-line caption", () => {
    for (const scene of SCENES) {
      expect(scene.title.length).toBeGreaterThan(0);
      expect(scene.caption.length).toBeGreaterThan(0);
      expect(scene.caption).not.toContain("\n");
    }
  });

  it("autoplay pacing is the task's own ~4s figure", () => {
    expect(AUTOPLAY_PAUSE_MS).toBe(4000);
  });
});
