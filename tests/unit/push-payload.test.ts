import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildPushPayload, PUSH_BODY, type PushOutcome } from "@/server/push/payload";

// A finished job as the processor sees it: everything here is private except its id.
const job = {
  id: randomUUID(),
  prompt: "two adults sharing a candlelit toast in a velvet booth, warm film grain",
  negativePrompt: "blurry",
  templateTitle: "Velvet Hour",
  templateSlug: "velvet-hour",
  modelKey: "demo-still",
  storageKey: "outputs/2026/10/abc.webp",
  failureMessage: "The provider timed out.",
};

describe("push payload", () => {
  it("carries only a title, a neutral line, a link to the creation and a tag", () => {
    const payload = buildPushPayload("completed", job.id);
    expect(Object.keys(payload).sort()).toEqual(["body", "tag", "title", "url"]);
    expect(payload).toEqual({ title: "Hushloom", body: "Your creation is ready", url: `/collection/${job.id}`, tag: `job-${job.id}` });
  });

  it("has one fixed line per outcome", () => {
    expect(buildPushPayload("failed", job.id).body).toBe("A creation didn't finish");
    expect(buildPushPayload("cancelled", job.id).body).toBe("A creation was cancelled");
    expect(Object.keys(PUSH_BODY).sort()).toEqual(["cancelled", "completed", "failed"]);
  });

  it("contains nothing from the job but its id: no prompt, template, model, media or failure detail", () => {
    for (const outcome of ["completed", "failed", "cancelled"] as PushOutcome[]) {
      const text = JSON.stringify(buildPushPayload(outcome, job.id)).toLowerCase();
      for (const secret of [job.prompt, "candlelit", job.negativePrompt, job.templateTitle, job.templateSlug, job.modelKey, job.storageKey, "webp", job.failureMessage, "timed out"]) {
        expect(text).not.toContain(secret.toLowerCase());
      }
    }
  });

  it("refuses anything but a job id where the id goes, so text cannot ride along", () => {
    expect(() => buildPushPayload("completed", `${job.id} ${job.prompt}`)).toThrow();
    expect(() => buildPushPayload("completed", "../settings")).toThrow();
    expect(() => buildPushPayload("completed", "")).toThrow();
  });
});
