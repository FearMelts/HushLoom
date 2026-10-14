import type { GenerationParams } from "@/server/db/schema";

/**
 * The prompt text for a model whose schema has no fields for lighting, framing, atmosphere or
 * pacing. They are settings here so they can be picked, saved in presets and reused, but most
 * models only read text, so they are appended as words. A setting the prompt already names is not
 * repeated, and pacing only applies to clips.
 */
export function promptWithSettings(prompt: string, params: GenerationParams, output: "image" | "video"): string {
  const said = prompt.toLowerCase();
  const extra = [
    params.lighting ? { value: params.lighting, words: `${params.lighting} lighting` } : null,
    params.framing ? { value: params.framing, words: `${params.framing} shot` } : null,
    params.atmosphere?.trim() ? { value: params.atmosphere.trim(), words: `${params.atmosphere.trim()} atmosphere` } : null,
    output === "video" && params.pacing && params.pacing !== "natural" ? { value: params.pacing, words: `${params.pacing} pacing` } : null,
  ]
    .filter((x) => x !== null)
    .filter((x) => !said.includes(x.value.toLowerCase()))
    .map((x) => x.words);
  const base = prompt.trim().replace(/[\s,.;]+$/, "");
  return extra.length ? `${base}, ${extra.join(", ")}` : prompt;
}
