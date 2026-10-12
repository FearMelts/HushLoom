import type { GenerationParams } from "@/server/db/schema";
import { pricing } from "@/config/pricing";

export type GenerationMode =
  | "text_to_image"
  | "image_to_image"
  | "text_to_video"
  | "image_to_video"
  | "video_to_video"
  | "video_extension"
  | "scene_continuation"
  | "reference_guided";

export const MODE_LABELS: Record<GenerationMode, string> = {
  text_to_image: "Text to image",
  image_to_image: "Image to image",
  text_to_video: "Text to video",
  image_to_video: "Image to video",
  video_to_video: "Video to video",
  video_extension: "Extend video",
  scene_continuation: "Continue scene",
  reference_guided: "Reference guided",
};

export const VIDEO_MODES: readonly GenerationMode[] = [
  "text_to_video",
  "image_to_video",
  "video_to_video",
  "video_extension",
  "scene_continuation",
];

/** Which input media a mode requires. */
export const MODE_INPUTS: Record<GenerationMode, { image: number; video: number; characterRef: boolean }> = {
  text_to_image: { image: 0, video: 0, characterRef: false },
  image_to_image: { image: 1, video: 0, characterRef: false },
  text_to_video: { image: 0, video: 0, characterRef: false },
  image_to_video: { image: 1, video: 0, characterRef: false },
  video_to_video: { image: 0, video: 1, characterRef: false },
  video_extension: { image: 0, video: 1, characterRef: false },
  scene_continuation: { image: 0, video: 1, characterRef: false },
  reference_guided: { image: 0, video: 0, characterRef: true },
};

export type ModelSpec = {
  key: string;
  providerKey: string;
  displayName: string;
  /** The provider's own model identifier. */
  providerModel: string;
  output: "image" | "video";
  modes: GenerationMode[];
  aspectRatios: string[];
  durationsS?: number[];
  qualities: ("hd" | "4k")[];
  supports: {
    negativePrompt: boolean;
    seed: boolean;
    cameraMovement: boolean;
    motionIntensity: boolean;
    cancel: boolean;
  };
  /**
   * What the model can promise about consistency across clips. Nothing in this
   * registry claims guaranteed identity or lighting preservation.
   */
  continuity: "none" | "best_effort";
  minInputShortSidePx: number;
  /** Plain-language notes shown in Studio next to the model. */
  notes: string;
};

export const CAMERA_MOVEMENTS = ["static", "slow push in", "pull back", "pan left", "pan right", "orbit", "handheld", "tilt up", "tilt down"] as const;
export const PACINGS = ["slow", "natural", "brisk"] as const;
export const LIGHTINGS = ["soft window", "golden hour", "neon", "candlelit", "low key", "high key", "backlit"] as const;
export const FRAMINGS = ["close-up", "medium", "wide", "over the shoulder", "low angle", "high angle"] as const;

export const MODELS: ModelSpec[] = [
  {
    key: "demo-still",
    providerKey: "demo",
    displayName: "Demo Still (not AI)",
    providerModel: "local-procedural",
    output: "image",
    modes: ["text_to_image", "image_to_image", "reference_guided"],
    aspectRatios: ["1:1", "4:5", "3:4", "2:3", "9:16", "16:9"],
    qualities: ["hd", "4k"],
    supports: { negativePrompt: true, seed: true, cameraMovement: false, motionIntensity: false, cancel: true },
    continuity: "none",
    minInputShortSidePx: 512,
    notes: "Development demonstration. Renders a labeled procedural placeholder locally; no AI model is called.",
  },
  {
    key: "demo-motion",
    providerKey: "demo",
    displayName: "Demo Motion (not AI)",
    providerModel: "local-ffmpeg",
    output: "video",
    modes: ["text_to_video", "image_to_video", "video_extension", "scene_continuation"],
    aspectRatios: ["9:16", "1:1", "16:9"],
    durationsS: [3, 5, 8],
    qualities: ["hd"],
    supports: { negativePrompt: false, seed: true, cameraMovement: true, motionIntensity: true, cancel: true },
    continuity: "none",
    minInputShortSidePx: 512,
    notes: "Development demonstration. Renders a labeled clip locally with ffmpeg; no AI model is called.",
  },
  {
    key: "replicate-flux-schnell",
    providerKey: "replicate",
    displayName: "FLUX.1 schnell (Replicate)",
    providerModel: "black-forest-labs/flux-schnell",
    output: "image",
    modes: ["text_to_image"],
    aspectRatios: ["1:1", "4:5", "3:4", "2:3", "9:16", "16:9"],
    qualities: ["hd"],
    supports: { negativePrompt: false, seed: true, cameraMovement: false, motionIntensity: false, cancel: true },
    continuity: "none",
    minInputShortSidePx: 0,
    notes:
      "Requires REPLICATE_API_TOKEN. Check the model's input schema and the provider's content policy before enabling it in production.",
  },
];

export function getModel(key: string): ModelSpec | undefined {
  return MODELS.find((m) => m.key === key);
}

export function modelsForMode(mode: GenerationMode): ModelSpec[] {
  return MODELS.filter((m) => m.modes.includes(mode));
}

export type CapabilityIssue = { field: string; message: string };

/** Validates params against what the model declares. Never assume a model supports a feature. */
export function validateAgainstModel(
  model: ModelSpec,
  mode: GenerationMode,
  params: GenerationParams,
  negativePrompt: string,
): CapabilityIssue[] {
  const issues: CapabilityIssue[] = [];
  if (!model.modes.includes(mode)) {
    issues.push({ field: "mode", message: `${model.displayName} does not support ${MODE_LABELS[mode].toLowerCase()}.` });
  }
  if (params.aspectRatio && !model.aspectRatios.includes(params.aspectRatio)) {
    issues.push({
      field: "aspectRatio",
      message: `${params.aspectRatio} is not available on ${model.displayName}. Try ${model.aspectRatios.join(", ")}.`,
    });
  }
  if (model.output === "video") {
    if (params.durationS !== undefined && !model.durationsS?.includes(params.durationS)) {
      issues.push({ field: "durationS", message: `Duration must be one of ${model.durationsS?.join(", ")} seconds.` });
    }
  } else if (params.durationS !== undefined) {
    issues.push({ field: "durationS", message: "Images do not have a duration." });
  }
  if (params.quality && !model.qualities.includes(params.quality)) {
    issues.push({ field: "quality", message: `${params.quality.toUpperCase()} is not offered by ${model.displayName}.` });
  }
  if (negativePrompt.trim() && !model.supports.negativePrompt) {
    issues.push({ field: "negativePrompt", message: `${model.displayName} ignores negative prompts, so remove it or pick another model.` });
  }
  if (params.seed !== undefined && !model.supports.seed) {
    issues.push({ field: "seed", message: `${model.displayName} does not accept a seed.` });
  }
  if (params.cameraMovement && !model.supports.cameraMovement) {
    issues.push({ field: "cameraMovement", message: `${model.displayName} has no camera control.` });
  }
  if (params.motionIntensity !== undefined && !model.supports.motionIntensity) {
    issues.push({ field: "motionIntensity", message: `${model.displayName} has no motion intensity control.` });
  }
  if (params.motionIntensity !== undefined && (params.motionIntensity < 1 || params.motionIntensity > 10)) {
    issues.push({ field: "motionIntensity", message: "Motion intensity runs from 1 to 10." });
  }
  return issues;
}

/** Credit cost. Values come from config/pricing.ts and are placeholders for the operator to set. */
export function estimateCost(model: ModelSpec, params: GenerationParams, priceMultiplierPct = 100): number {
  const quality = (params.quality ?? "hd") as "hd" | "4k";
  const qualityFactor = pricing.qualityMultiplier[quality] ?? 1;
  let base: number;
  if (model.output === "image") {
    base = pricing.imageBase;
  } else {
    const duration = params.durationS ?? model.durationsS?.[0] ?? 5;
    base = pricing.videoPerSecond * duration;
  }
  return Math.max(1, Math.ceil((base * qualityFactor * priceMultiplierPct) / 100));
}
