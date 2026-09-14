import { describe, expect, it } from "vitest";
import { SAFE_REVERT_BALANCE_SUFFIX, SAFE_REVERT_GS020_LINE_1, SAFE_REVERT_GS020_LINE_2 } from "./constants";
import { ellipsize, formatSafeRevertLines } from "./safe-revert";

describe("/film Safe revert formatting (D-46)", () => {
  it("renders the fixed three-line GS020 explanation, with the real address shortened 6+4", () => {
    const lines = formatSafeRevertLines(
      "execution reverted: GS020: signatures data too short",
      "0x67c0dEaD00000000000000000000000000004DCc",
    );
    expect(lines).toEqual([
      SAFE_REVERT_GS020_LINE_1,
      SAFE_REVERT_GS020_LINE_2,
      `Safe 0x67c0…4DCc · ${SAFE_REVERT_BALANCE_SUFFIX}`,
    ]);
  });

  it("falls back to '…' for the address if the real Safe address hasn't arrived yet", () => {
    const lines = formatSafeRevertLines("GS020", null);
    expect(lines[2]).toBe(`Safe … · ${SAFE_REVERT_BALANCE_SUFFIX}`);
  });

  it("shows the real reason string on one line, ellipsized, when it is not GS020", () => {
    const longReason = "ContractFunctionExecutionError: a completely different revert this bypass case never expected to see, from real chain output";
    const lines = formatSafeRevertLines(longReason, "0x1234567890123456789012345678901234567890");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`→ reverted · ${ellipsize(longReason)}`);
    expect(lines[0]).not.toContain(SAFE_REVERT_GS020_LINE_1);
  });

  it("never renders the raw revert message unellipsized when it is long and not GS020", () => {
    const longReason = "x".repeat(200);
    const [line] = formatSafeRevertLines(longReason, null);
    expect(line!.length).toBeLessThan(longReason.length);
  });

  it("shows a real, non-crashing placeholder while the real result hasn't arrived", () => {
    expect(formatSafeRevertLines(null, null)).toEqual(["→ reverted · …"]);
  });

  it("ellipsize leaves short strings untouched and truncates long ones with a trailing ellipsis", () => {
    expect(ellipsize("short")).toBe("short");
    const long = "a".repeat(100);
    const result = ellipsize(long, 10);
    expect(result).toBe(`${"a".repeat(10)}…`);
  });
});
