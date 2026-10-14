import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getBalance } from "@/server/credits/ledger";
import { closeDb, getDb } from "@/server/db";
import { generationJobs } from "@/server/db/schema";
import { confirmJob, createDraft } from "@/server/generation/service";
import { closeRedis } from "@/server/redis";
import { key, makeUser, resetDb } from "../helpers";

// The queue is down for this whole file: every enqueue rejects.
const enqueue = vi.hoisted(() => vi.fn(async () => {
  throw new Error("queue unreachable");
}));
vi.mock("@/server/generation/queue", () => ({ enqueueGeneration: enqueue }));

beforeEach(async () => {
  await resetDb();
  enqueue.mockClear();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("confirm when the queue is unreachable", () => {
  it("still answers with the queued job and its credits held, so the reconciler can pick it up", async () => {
    const user = await makeUser({ credits: 50 });
    const draft = await createDraft(
      user,
      { idempotencyKey: key(), mode: "text_to_image", modelKey: "demo-still", prompt: "two adults sharing a candlelit toast, warm film grain", negativePrompt: "", params: { aspectRatio: "4:5" }, inputAssetIds: [] },
      { country: null },
    );
    const queued = await confirmJob(user, draft.id, draft.costCredits);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(queued.status).toBe("queued");
    const [row] = await getDb().select().from(generationJobs).where(eq(generationJobs.id, draft.id));
    expect(row!.status).toBe("queued");
    expect(await getBalance(user.id)).toEqual({ available: 46, reserved: 4 });

    // A second confirm is a no-op: nothing is reserved twice and nothing is enqueued again.
    await confirmJob(user, draft.id, draft.costCredits);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(await getBalance(user.id)).toEqual({ available: 46, reserved: 4 });
  });
});
