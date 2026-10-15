import { describe, expect, it } from "vitest";
import { analyze, interpret } from "@/lib/copilot";
import { getModel } from "@/server/ai/registry";

const still = getModel("demo-still")!;
const motion = getModel("demo-motion")!;
const flux = getModel("replicate-flux-schnell")!;

describe("analyze", () => {
  it("blocks a policy violation before anything is spent", () => {
    const s = analyze({ prompt: "a teen at the beach", negativePrompt: "", params: {}, mode: "text_to_image", model: still });
    expect(s.find((x) => x.id === "policy")?.severity).toBe("block");
  });

  it("offers detail for a short prompt and the patch keeps the original words", () => {
    const s = analyze({ prompt: "woman on a bed", negativePrompt: "", params: {}, mode: "text_to_image", model: still });
    const short = s.find((x) => x.id === "short-prompt");
    expect(short?.patch?.prompt?.startsWith("woman on a bed, ")).toBe(true);
  });

  it("flags contradictions", () => {
    const s = analyze({ prompt: "a static locked-off shot, the camera pans across the room slowly at night", negativePrompt: "", params: {}, mode: "text_to_video", model: motion });
    expect(s.some((x) => x.id.startsWith("conflict-"))).toBe(true);
  });

  it("suggests the nearest supported aspect ratio", () => {
    const s = analyze({ prompt: "an adult couple dancing in a ballroom under chandeliers", negativePrompt: "", params: { aspectRatio: "4:5" }, mode: "text_to_video", model: motion });
    expect(s.find((x) => x.id === "aspect-unsupported")?.patch?.params?.aspectRatio).toBe("1:1");
  });

  it("warns about low-resolution input and crop", () => {
    const s = analyze({
      prompt: "she turns toward the window light and smiles softly",
      negativePrompt: "",
      params: { aspectRatio: "9:16" },
      mode: "image_to_video",
      model: motion,
      input: { kind: "image", width: 400, height: 300 },
    });
    expect(s.map((x) => x.id)).toEqual(expect.arrayContaining(["low-res", "aspect-crop"]));
  });

  it("says when a negative prompt will be ignored", () => {
    const s = analyze({ prompt: "an adult in a sunlit studio, film grain, soft focus", negativePrompt: "text", params: {}, mode: "text_to_image", model: flux });
    expect(s.some((x) => x.id === "neg-unsupported")).toBe(true);
  });
});

describe("analyze: settings that agree with the prompt", () => {
  const prompt = "an adult couple at golden hour on a balcony, close-up, warm film grain";

  it("offers the lighting and framing the prompt names when they are unset", () => {
    const s = analyze({ prompt, negativePrompt: "", params: {}, mode: "text_to_image", model: still });
    expect(s.find((x) => x.id === "lighting-from-prompt")).toMatchObject({ severity: "info", patch: { params: { lighting: "golden hour" } } });
    expect(s.find((x) => x.id === "framing-from-prompt")).toMatchObject({ severity: "info", patch: { params: { framing: "close-up" } } });
  });

  it("warns when a setting names a different look than the prompt", () => {
    const s = analyze({ prompt, negativePrompt: "", params: { lighting: "neon", framing: "close-up" }, mode: "text_to_image", model: still });
    expect(s.find((x) => x.id === "lighting-disagrees")).toMatchObject({ severity: "warn", patch: { params: { lighting: "golden hour" } } });
    expect(s.some((x) => x.id.startsWith("framing-"))).toBe(false);
  });

  it("says nothing when the prompt names no lighting or framing", () => {
    const s = analyze({ prompt: "an adult couple laughing on a balcony with a city behind them", negativePrompt: "", params: {}, mode: "text_to_image", model: still });
    expect(s.some((x) => x.id.startsWith("lighting-") || x.id.startsWith("framing-"))).toBe(false);
  });
});

describe("interpret", () => {
  it("maps plain words to supported settings", () => {
    const r = interpret("vertical, slow push in, golden hour, 8 seconds, gentle", motion);
    expect(r.params).toMatchObject({ aspectRatio: "9:16", cameraMovement: "slow push in", lighting: "golden hour", durationS: 8, motionIntensity: 3 });
  });

  it("snaps to the nearest offered duration and says so", () => {
    const r = interpret("make it 6 seconds", motion);
    expect(r.params.durationS).toBe(5);
    expect(r.changes[0]?.because).toMatch(/isn't offered/);
  });

  it("lists what the model cannot do instead of pretending", () => {
    const r = interpret("orbit around her, 5 seconds", still);
    expect(r.params.cameraMovement).toBeUndefined();
    expect(r.unsupported).toEqual(expect.arrayContaining(["camera movement", "duration (this model makes images)"]));
  });
});
