import { describe, expect, it } from "vitest";
import { draftKeyFor, stableSignature } from "@/lib/draft-key";

let n = 0;
const newKey = () => `k${++n}`;
const body = (overrides: Record<string, unknown> = {}) => ({
  mode: "text_to_image",
  modelKey: "demo-still",
  prompt: "two adults sharing a candlelit toast",
  negativePrompt: "",
  params: { aspectRatio: "4:5", lighting: "candlelit" },
  inputAssetIds: [],
  templateId: undefined,
  ...overrides,
});

describe("stableSignature", () => {
  it("ignores key order and undefined fields", () => {
    expect(stableSignature({ a: 1, b: { y: 2, x: 1 } })).toBe(stableSignature({ b: { x: 1, y: 2 }, a: 1 }));
    expect(stableSignature({ a: 1, b: undefined })).toBe(stableSignature({ a: 1 }));
  });

  it("keeps array order, which matters for inputs", () => {
    expect(stableSignature({ ids: ["a", "b"] })).not.toBe(stableSignature({ ids: ["b", "a"] }));
  });
});

describe("draftKeyFor", () => {
  it("reuses the key for the exact same request, so a retry finds the draft already made", () => {
    const first = draftKeyFor(null, body(), newKey);
    expect(draftKeyFor(first, body(), newKey)).toBe(first);
    expect(draftKeyFor(first, { ...body(), params: { lighting: "candlelit", aspectRatio: "4:5" } }, newKey).key).toBe(first.key);
  });

  it("starts a new key for any change, including the ones Undo, Restore and a model switch make", () => {
    const first = draftKeyFor(null, body(), newKey);
    const changes = [
      body({ prompt: "two adults sharing a candlelit toast, rain outside" }),
      body({ params: { aspectRatio: "4:5" } }),
      body({ params: { aspectRatio: "1:1", lighting: "candlelit" } }),
      body({ modelKey: "demo-motion" }),
      body({ mode: "reference_guided", characterReferenceId: "c1" }),
      body({ negativePrompt: "text" }),
      body({ inputAssetIds: ["a1"] }),
      body({ projectId: "p1", sceneId: "s1" }),
      body({ parentJobId: "j1", relation: "remix" }),
    ];
    const keys = new Set(changes.map((c) => draftKeyFor(first, c, newKey).key));
    expect(keys.size).toBe(changes.length);
    expect(keys.has(first.key)).toBe(false);
  });

  it("starts a new key after the panel forgets the previous one, even for the same request", () => {
    const first = draftKeyFor(null, body(), newKey);
    expect(draftKeyFor(null, body(), newKey).key).not.toBe(first.key);
  });
});
