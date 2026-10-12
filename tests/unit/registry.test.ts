import { describe, expect, it } from "vitest";
import { estimateCost, getModel, validateAgainstModel } from "@/server/ai/registry";
import { pricing } from "@/config/pricing";

const still = getModel("demo-still")!;
const motion = getModel("demo-motion")!;
const flux = getModel("replicate-flux-schnell")!;

describe("cost", () => {
  it("prices stills, clips per second, 4K and admin multipliers", () => {
    expect(estimateCost(still, {})).toBe(pricing.imageBase);
    expect(estimateCost(still, { quality: "4k" })).toBe(pricing.imageBase * 2);
    expect(estimateCost(motion, { durationS: 8 })).toBe(pricing.videoPerSecond * 8);
    expect(estimateCost(motion, {})).toBe(pricing.videoPerSecond * 3);
    expect(estimateCost(still, {}, 150)).toBe(Math.ceil(pricing.imageBase * 1.5));
    expect(estimateCost(still, {}, 10)).toBe(1);
  });
});

describe("capabilities", () => {
  it("accepts what the model declares", () => {
    expect(validateAgainstModel(motion, "text_to_video", { durationS: 5, cameraMovement: "orbit", motionIntensity: 4, aspectRatio: "9:16" }, "")).toEqual([]);
  });
  it("refuses what it does not", () => {
    const fields = validateAgainstModel(flux, "image_to_image", { aspectRatio: "21:9", quality: "4k", durationS: 5, cameraMovement: "orbit" }, "blurry").map((i) => i.field);
    expect(fields).toEqual(expect.arrayContaining(["mode", "aspectRatio", "quality", "durationS", "cameraMovement", "negativePrompt"]));
    expect(validateAgainstModel(motion, "text_to_video", { durationS: 7 }, "").map((i) => i.field)).toEqual(["durationS"]);
  });
});
