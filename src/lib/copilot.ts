/**
 * The built-in creative assistant. Pure, deterministic rules that run in the
 * browser and on the server alike. It suggests; it never edits on its own.
 */
import type { GenerationParams } from "@/server/db/schema";
import { CAMERA_MOVEMENTS, type GenerationMode, type ModelSpec } from "@/server/ai/registry";
import { checkPrompt } from "@/server/safety/policy";

export type Suggestion = {
  id: string;
  severity: "info" | "warn" | "block";
  title: string;
  detail: string;
  patch?: { prompt?: string; params?: Partial<GenerationParams> };
  patchLabel?: string;
};

export type InputMeta = { kind: "image" | "video"; width: number | null; height: number | null };

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const has = (s: string, re: RegExp) => re.test(s.toLowerCase());

const MOVING_CAMERA = /\b(pan(s|ned|ning)?|orbit(s|ed|ing)?|dolly|dollies|tracking|zoom(s|ed|ing)?|handheld)\b/;

const CONFLICTS: { a: RegExp; b: RegExp; label: string }[] = [
  { a: /\b(static|locked[- ]off|still camera|tripod)\b/, b: MOVING_CAMERA, label: "a still camera and a moving camera" },
  { a: /\b(daylight|midday|noon|sunny)\b/, b: /\b(night|midnight|moonlight)\b/, label: "day and night" },
  { a: /\b(close[- ]?up|macro)\b/, b: /\b(wide shot|full body|establishing)\b/, label: "a close-up and a wide shot" },
  { a: /\b(slow motion|slow-mo|languid)\b/, b: /\b(fast|frantic|energetic|rapid)\b/, label: "slow and fast motion" },
  { a: /\b(bright|airy|high[- ]key)\b/, b: /\b(dark|moody|low[- ]key)\b/, label: "bright and dark lighting" },
  { a: /\b(black and white|monochrome|b&w)\b/, b: /\b(vibrant|colou?rful|neon|saturated)\b/, label: "monochrome and vivid color" },
];

function ratio(aspect: string) {
  const [w, h] = aspect.split(":").map(Number) as [number, number];
  return w / h;
}

function nearestAspect(target: number, options: string[]): string {
  return options.reduce((best, o) => (Math.abs(ratio(o) - target) < Math.abs(ratio(best) - target) ? o : best), options[0]!);
}

export function analyze(args: {
  prompt: string;
  negativePrompt: string;
  params: GenerationParams;
  mode: GenerationMode;
  model: ModelSpec;
  input?: InputMeta | null;
}): Suggestion[] {
  const { prompt, params, model, input } = args;
  const out: Suggestion[] = [];
  const p = prompt.toLowerCase();

  const verdict = checkPrompt(prompt, args.negativePrompt);
  if (!verdict.allowed) {
    out.push({ id: "policy", severity: "block", title: "This can't be created", detail: verdict.message });
  }

  const n = words(prompt).length;
  if (n > 0 && n < 5) {
    const extra = [params.lighting ? null : "soft window light", params.framing ? null : "medium shot", "natural skin texture", "shallow depth of field"].filter(Boolean);
    out.push({
      id: "short-prompt",
      severity: "info",
      title: "Give the model a little more",
      detail: "Short prompts leave most choices to chance. Adding light, framing and texture makes results more consistent.",
      patch: { prompt: `${prompt.trim()}, ${extra.join(", ")}` },
      patchLabel: "Add detail",
    });
  }
  if (n > 120) {
    out.push({
      id: "long-prompt",
      severity: "info",
      title: "Long prompts lose their tail",
      detail: "Models weight the first details most. Put the subject and the most important look first.",
    });
  }

  for (const c of CONFLICTS) {
    if (has(p, c.a) && has(p, c.b)) {
      out.push({ id: `conflict-${c.label}`, severity: "warn", title: "Mixed instructions", detail: `The prompt asks for ${c.label}. The model will pick one at random; keep the one you mean.` });
    }
  }
  if (params.cameraMovement === "static" && has(p, MOVING_CAMERA)) {
    out.push({ id: "conflict-camera-param", severity: "warn", title: "Camera setting disagrees with the prompt", detail: "Camera is set to static but the prompt describes movement." });
  }

  if (params.aspectRatio && !model.aspectRatios.includes(params.aspectRatio)) {
    const best = nearestAspect(ratio(params.aspectRatio), model.aspectRatios);
    out.push({
      id: "aspect-unsupported",
      severity: "warn",
      title: `${params.aspectRatio} isn't available here`,
      detail: `${model.displayName} supports ${model.aspectRatios.join(", ")}. ${best} is the closest.`,
      patch: { params: { aspectRatio: best } },
      patchLabel: `Use ${best}`,
    });
  }

  if (input?.width && input.height) {
    const shortSide = Math.min(input.width, input.height);
    if (model.minInputShortSidePx && shortSide < model.minInputShortSidePx) {
      out.push({
        id: "low-res",
        severity: "warn",
        title: "Low-resolution upload",
        detail: `Your image is ${input.width}×${input.height}. Below ${model.minInputShortSidePx}px on the short side, expect soft detail and smeared faces.`,
      });
    }
    const inRatio = input.width / input.height;
    const outAspect = params.aspectRatio ?? model.aspectRatios[0]!;
    if (Math.abs(inRatio - ratio(outAspect)) > 0.15) {
      const best = nearestAspect(inRatio, model.aspectRatios);
      if (best !== outAspect) {
        out.push({
          id: "aspect-crop",
          severity: "info",
          title: "Your image will be cropped",
          detail: `The upload is closer to ${best} than ${outAspect}. Matching it keeps the whole frame.`,
          patch: { params: { aspectRatio: best } },
          patchLabel: `Match ${best}`,
        });
      }
    }
  }

  if (model.output === "video") {
    const intensity = params.motionIntensity ?? 5;
    const duration = params.durationS ?? model.durationsS?.[0] ?? 5;
    if (intensity >= 8 && duration >= 5) {
      out.push({
        id: "artifact-risk",
        severity: "info",
        title: "Expect some warping",
        detail: "High motion over a longer clip is where video models most often bend hands, faces and fabric. Dropping intensity to 5 usually helps.",
        patch: { params: { motionIntensity: 5 } },
        patchLabel: "Set intensity to 5",
      });
    }
    if (!params.cameraMovement && model.supports.cameraMovement) {
      const suggestion = has(p, /\b(danc|twirl|spin)\w*/)
        ? "orbit"
        : has(p, /\b(face|portrait|eyes|lips|smile)\b/)
          ? "slow push in"
          : has(p, /\b(room|bed|landscape|city|beach|pool)\b/)
            ? "pan right"
            : "slow push in";
      out.push({
        id: "camera",
        severity: "info",
        title: "Add camera movement?",
        detail: `A ${suggestion} suits this scene and makes clips feel less static.`,
        patch: { params: { cameraMovement: suggestion } },
        patchLabel: `Use ${suggestion}`,
      });
    }
  }

  if (args.negativePrompt.trim() && !model.supports.negativePrompt) {
    out.push({ id: "neg-unsupported", severity: "warn", title: "Negative prompt will be ignored", detail: `${model.displayName} does not read negative prompts.` });
  }
  if (has(p, /\b(sign|text|caption|logo|words?) (that )?(says|reading|saying)\b/)) {
    out.push({ id: "text", severity: "info", title: "Lettering is unreliable", detail: "Image and video models often misspell text. Plan to add words afterwards." });
  }
  if (model.continuity === "none" && (args.mode === "scene_continuation" || args.mode === "video_extension")) {
    out.push({
      id: "continuity",
      severity: "info",
      title: "Continuity is a goal, not a guarantee",
      detail: `${model.displayName} does not promise the same face, outfit or lighting between clips. Keep the prompt and continuity notes identical to improve your odds.`,
    });
  }
  return out;
}

export type Interpretation = {
  params: Partial<GenerationParams>;
  changes: { field: keyof GenerationParams; value: string | number; because: string }[];
  unsupported: string[];
};

const CAMERA_PHRASES: [RegExp, (typeof CAMERA_MOVEMENTS)[number]][] = [
  [/\b(push(es|ing)? in|zoom(s|ing)? in|dolly in|move closer)\b/, "slow push in"],
  [/\b(pull(s|ing)? (back|out)|zoom(s|ing)? out|dolly out)\b/, "pull back"],
  [/\bpan(s|ning)? left\b/, "pan left"],
  [/\bpan(s|ning)? right\b/, "pan right"],
  [/\b(orbit|circle around|360)\b/, "orbit"],
  [/\b(handheld|shaky|documentary)\b/, "handheld"],
  [/\btilt(s|ing)? up\b/, "tilt up"],
  [/\btilt(s|ing)? down\b/, "tilt down"],
  [/\b(static|locked[- ]off|still camera|no camera movement)\b/, "static"],
];

/** Turns a plain-language request ("vertical, slow push in, golden hour, 8 seconds") into settings the model accepts. */
export function interpret(text: string, model: ModelSpec): Interpretation {
  const t = text.toLowerCase();
  const result: Interpretation = { params: {}, changes: [], unsupported: [] };
  const set = <K extends keyof GenerationParams>(field: K, value: GenerationParams[K] & (string | number), because: string) => {
    result.params[field] = value;
    result.changes.push({ field, value, because });
  };

  const aspectWish = /\b(vertical|portrait|phone|story|stories|tiktok)\b/.test(t)
    ? "9:16"
    : /\b(square|1:1)\b/.test(t)
      ? "1:1"
      : /\b(widescreen|landscape|horizontal|cinematic wide|16:9)\b/.test(t)
        ? "16:9"
        : null;
  if (aspectWish) {
    const options = model.aspectRatios;
    const chosen = options.includes(aspectWish) ? aspectWish : nearestAspect(ratio(aspectWish), options);
    set("aspectRatio", chosen, chosen === aspectWish ? `you asked for ${aspectWish}` : `${aspectWish} isn't offered, ${chosen} is closest`);
  }

  const dur = t.match(/\b(\d{1,2})\s*(s|sec|secs|seconds?)\b/);
  if (dur) {
    if (model.output !== "video") result.unsupported.push("duration (this model makes images)");
    else {
      const wanted = Number(dur[1]);
      const options = model.durationsS ?? [];
      const chosen = options.reduce((b, o) => (Math.abs(o - wanted) < Math.abs(b - wanted) ? o : b), options[0] ?? wanted);
      set("durationS", chosen, chosen === wanted ? `you asked for ${wanted}s` : `${wanted}s isn't offered, ${chosen}s is closest`);
    }
  }

  for (const [re, move] of CAMERA_PHRASES) {
    if (re.test(t)) {
      if (model.supports.cameraMovement) set("cameraMovement", move, `"${t.match(re)![0]}"`);
      else result.unsupported.push("camera movement");
      break;
    }
  }

  const calm = /\b(subtle|gentle|calm|barely moving)\b/.test(t);
  const wild = /\b(energetic|intense|wild|fast|vigorous)\b/.test(t);
  if (calm || wild) {
    if (model.supports.motionIntensity) set("motionIntensity", calm ? 3 : 8, calm ? "you asked for gentle motion" : "you asked for energetic motion");
    else if (model.output === "video") result.unsupported.push("motion intensity");
  }
  if (/\b(slow motion|slow-mo|slowly|unhurried)\b/.test(t)) set("pacing", "slow", "you asked for a slow pace");
  else if (/\b(brisk|quick cuts|snappy)\b/.test(t)) set("pacing", "brisk", "you asked for a brisk pace");

  const lighting: [RegExp, string][] = [
    [/\b(golden hour|sunset|sunrise)\b/, "golden hour"],
    [/\bneon\b/, "neon"],
    [/\bcandle(lit|light)?\b/, "candlelit"],
    [/\b(moody|low[- ]key|shadowy)\b/, "low key"],
    [/\b(bright|airy|high[- ]key)\b/, "high key"],
    [/\b(backlit|silhouette)\b/, "backlit"],
    [/\b(window light|soft light)\b/, "soft window"],
  ];
  for (const [re, v] of lighting) {
    if (re.test(t)) {
      set("lighting", v, `"${t.match(re)![0]}"`);
      break;
    }
  }

  const framing: [RegExp, string][] = [
    [/\b(close[- ]?up|closeup)\b/, "close-up"],
    [/\b(wide shot|full body|wide angle)\b/, "wide"],
    [/\bmedium shot\b/, "medium"],
    [/\blow angle\b/, "low angle"],
    [/\b(high angle|overhead|top[- ]down)\b/, "high angle"],
    [/\bover the shoulder\b/, "over the shoulder"],
  ];
  for (const [re, v] of framing) {
    if (re.test(t)) {
      set("framing", v, `"${t.match(re)![0]}"`);
      break;
    }
  }

  if (/\b(4k|ultra hd|uhd)\b/.test(t)) {
    if (model.qualities.includes("4k")) set("quality", "4k", "you asked for 4K (costs more)");
    else result.unsupported.push("4K output");
  }
  return result;
}
