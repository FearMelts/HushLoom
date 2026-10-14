import { describe, expect, it } from "vitest";
import { captionLines, demoSvg } from "@/server/ai/providers/demo";

describe("the demo placeholder caption", () => {
  it("wraps at spaces into two lines and ends a longer prompt with an ellipsis", () => {
    const lines = captionLines("adult woman lounging on a velvet chaise at golden hour, silk robe, warm film grain, soft focus", 37);
    expect(lines).toEqual(["adult woman lounging on a velvet", "chaise at golden hour, silk robe,…"]);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(37);
  });

  it("keeps a short prompt whole and cuts a word longer than a line", () => {
    expect(captionLines("short one", 37)).toEqual(["short one"]);
    const cut = captionLines(`${"x".repeat(50)} tail`, 20);
    expect(cut).toEqual(["x".repeat(20), `${"x".repeat(19)}…`]);
  });

  it("starts below the top 16% and keeps the watermark inside a 9:16 frame", () => {
    const svg = demoSvg("a quiet lakeside cabin at dusk", 1, 720, 1280);
    const y = Number(/<tspan x="\d+" y="(\d+)"/.exec(svg)![1]);
    expect(y).toBeGreaterThan(1280 * 0.16);
    const mark = Number(/font-weight="700" font-size="(\d+)"/.exec(svg)![1]);
    // 30 characters at about 0.72 em each, plus letter spacing, inside 90% of the width.
    expect(30 * 0.72 * mark + 60).toBeLessThanOrEqual(720 * 0.9);
  });
});
