import { describe, expect, it } from "vitest";
import { getModel } from "@/server/ai/registry";
import { promptWithSettings } from "@/server/ai/providers/prompt";
import { buildReplicateInput } from "@/server/ai/providers/replicate";
import { ProviderError, type ProviderRequest } from "@/server/ai/providers/types";

const flux = getModel("replicate-flux-schnell")!;
const request = (overrides: Partial<ProviderRequest> = {}): ProviderRequest => ({
  jobId: "job-1",
  model: flux,
  mode: "text_to_image",
  prompt: "an adult couple on a balcony at dusk",
  negativePrompt: "",
  params: { aspectRatio: "4:5", seed: 7 },
  inputs: [],
  ...overrides,
});

describe("promptWithSettings", () => {
  it("adds lighting, framing and atmosphere as words", () => {
    expect(promptWithSettings("an adult couple on a balcony.", { lighting: "neon", framing: "close-up", atmosphere: "hazy" }, "image")).toBe(
      "an adult couple on a balcony, neon lighting, close-up shot, hazy atmosphere",
    );
  });

  it("does not repeat what the prompt already says, and leaves an untouched prompt alone", () => {
    expect(promptWithSettings("golden hour on a balcony", { lighting: "golden hour" }, "image")).toBe("golden hour on a balcony");
    expect(promptWithSettings("a balcony", {}, "image")).toBe("a balcony");
  });

  it("adds pacing only to clips", () => {
    expect(promptWithSettings("a slow dance", { pacing: "brisk" }, "image")).toBe("a slow dance");
    expect(promptWithSettings("a dance", { pacing: "brisk" }, "video")).toBe("a dance, brisk pacing");
    expect(promptWithSettings("a dance", { pacing: "natural" }, "video")).toBe("a dance");
  });
});

describe("Replicate input", () => {
  it("maps the request onto the model's schema with the settings in the prompt", () => {
    expect(buildReplicateInput(request({ params: { aspectRatio: "4:5", seed: 7, lighting: "neon" } }))).toEqual({
      prompt: "an adult couple on a balcony at dusk, neon lighting",
      aspect_ratio: "4:5",
      num_outputs: 1,
      output_format: "webp",
      seed: 7,
    });
  });

  it("refuses a character reference the model cannot take instead of dropping it", () => {
    const reference = { kind: "image" as const, mime: "image/webp", bytes: Buffer.from("x"), width: 640, height: 640, role: "reference" as const };
    let caught: unknown;
    try {
      buildReplicateInput(request({ mode: "reference_guided", inputs: [reference] }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect(caught).toMatchObject({ code: "unsupported", retryable: false });
  });
});
