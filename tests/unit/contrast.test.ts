import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WCAG 2.x contrast computed from the hex values in globals.css, so a token change that drops
 * text below AA fails here before it reaches a screen.
 */
const css = readFileSync(path.resolve(__dirname, "../../src/app/globals.css"), "utf8");

function token(name: string): string {
  const m = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`));
  if (!m) throw new Error(`--color-${name} is not defined in globals.css`);
  return m[1]!;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const AA = 4.5;

describe("design token contrast", () => {
  it("computes the WCAG reference values", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  it("keeps the quietest text (bone-500) at AA on every surface it sits on", () => {
    // Hints, timestamps, placeholders and tab labels at 10.5-13 px sit on these surfaces.
    for (const surface of ["ink-950", "ink-900", "ink-850", "ink-800"]) {
      expect(contrast(token("bone-500"), token(surface)), `bone-500 on ${surface}`).toBeGreaterThanOrEqual(AA);
    }
  });

  it("keeps every text token at AA on the page and panel backgrounds", () => {
    const text = ["bone-50", "bone-100", "bone-200", "bone-300", "bone-400", "bone-500", "ember-200", "ember-300", "ember-400", "brass-300", "brass-400", "sage-300", "sage-400", "iris-300", "iris-400", "danger-400"];
    for (const fg of text) {
      for (const bg of ["ink-950", "ink-900"]) {
        expect(contrast(token(fg), token(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(AA);
      }
    }
  });

  it("keeps dark text readable on the filled badges and the ember button", () => {
    for (const fill of ["ember-500", "ember-400", "brass-400", "sage-400", "iris-400", "bone-50", "bone-200"]) {
      expect(contrast(token("ink-950"), token(fill)), `ink-950 on ${fill}`).toBeGreaterThanOrEqual(AA);
    }
  });

  it("defines every palette shade the components use (Tailwind emits nothing for a missing one)", () => {
    const used = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.(tsx|ts)$/.test(entry.name)) {
          for (const m of readFileSync(p, "utf8").matchAll(/\b(?:text|bg|border|ring|fill|stroke|from|to|via|shadow|outline|decoration|accent|caret|placeholder|divide)-((?:ink|bone|ember|brass|sage|iris|danger)-\d{2,3})\b/g)) used.add(m[1]!);
        }
      }
    };
    walk(path.resolve(__dirname, "../../src"));
    expect(used.size).toBeGreaterThan(10);
    const missing = [...used].filter((name) => !new RegExp(`--color-${name}:`).test(css));
    expect(missing).toEqual([]);
  });
});
