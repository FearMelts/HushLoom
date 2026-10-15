import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getModel } from "@/server/ai/registry";
import { getDb } from "@/server/db";
import { savedPresets, type GenerationParams } from "@/server/db/schema";
import { paramsSchema, getOwnedJob } from "@/server/generation/service";
import { HttpError, notFound } from "@/server/http";

const MODES = ["text_to_image", "image_to_image", "text_to_video", "image_to_video", "video_to_video", "video_extension", "scene_continuation", "reference_guided"] as const;

export const presetSchema = z.union([
  z.object({ name: z.string().trim().min(1).max(40), fromJobId: z.string().uuid() }),
  z.object({
    name: z.string().trim().min(1).max(40),
    mode: z.enum(MODES),
    modelKey: z.string().min(1).max(60),
    prompt: z.string().max(2000).default(""),
    params: paramsSchema.default({}),
  }),
]);

export type Preset = typeof savedPresets.$inferSelect;

export function listPresets(userId: string) {
  return getDb().select().from(savedPresets).where(eq(savedPresets.userId, userId)).orderBy(desc(savedPresets.createdAt)).limit(100);
}

export async function getPreset(userId: string, presetId: string): Promise<Preset | null> {
  const [p] = await getDb().select().from(savedPresets).where(and(eq(savedPresets.id, presetId), eq(savedPresets.userId, userId)));
  return p ?? null;
}

export async function createPreset(userId: string, input: z.infer<typeof presetSchema>): Promise<Preset> {
  let values: Omit<typeof savedPresets.$inferInsert, "userId">;
  // The seed is what makes a run reproducible, not a style. Presets leave it out, whichever way they are saved.
  const withoutSeed = (params: GenerationParams) => Object.fromEntries(Object.entries(params).filter(([k]) => k !== "seed")) as GenerationParams;
  if ("fromJobId" in input) {
    const job = await getOwnedJob(userId, input.fromJobId);
    values = { name: input.name, mode: job.mode, modelKey: job.modelKey, prompt: job.prompt, params: withoutSeed(job.params) };
  } else {
    // Saved while composing (the Create panel's "Save as preset").
    if (!getModel(input.modelKey)) throw new HttpError(422, "unknown_model", "That model does not exist.");
    values = { name: input.name, mode: input.mode, modelKey: input.modelKey, prompt: input.prompt, params: withoutSeed(input.params) };
  }
  const [count] = await getDb().select({ id: savedPresets.id }).from(savedPresets).where(eq(savedPresets.userId, userId)).offset(99).limit(1);
  if (count) throw new HttpError(422, "limit_reached", "You can keep up to 100 presets. Delete one first.");
  const [p] = await getDb()
    .insert(savedPresets)
    .values({ ...values, userId })
    .returning();
  return p!;
}

export async function deletePreset(userId: string, presetId: string) {
  const res = await getDb().delete(savedPresets).where(and(eq(savedPresets.id, presetId), eq(savedPresets.userId, userId))).returning({ id: savedPresets.id });
  if (!res.length) throw notFound();
}
