import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyReplicateWebhook } from "@/server/ai/providers/replicate";
import { storage, verifyLocalSignature } from "@/server/storage";

describe("local media signatures", () => {
  it("accepts its own URL and rejects tampering and expiry", async () => {
    const url = new URL(await storage().signedUrl("outputs/abc/def.webp", 300), "http://x");
    const key = url.searchParams.get("k") ?? decodeURIComponent(url.pathname.split("/api/media/")[1] ?? "");
    const exp = Number(url.searchParams.get("e"));
    const sig = url.searchParams.get("s") ?? "";
    const dl = url.searchParams.get("d") ?? "";
    expect(verifyLocalSignature(key, exp, dl, sig)).toBe(true);
    expect(verifyLocalSignature("outputs/abc/other.webp", exp, dl, sig)).toBe(false);
    expect(verifyLocalSignature(key, exp + 300, dl, sig)).toBe(false);
    expect(verifyLocalSignature(key, exp, "x.webp", sig)).toBe(false);
    expect(verifyLocalSignature(key, exp, dl, sig, (exp + 1) * 1000)).toBe(false);
  });
});

describe("replicate webhook signature", () => {
  const secret = `whsec_${Buffer.from("test-secret-0123456789").toString("base64")}`;
  const sign = (id: string, ts: string, body: string, s = secret) =>
    `v1,${createHmac("sha256", Buffer.from(s.replace(/^whsec_/, ""), "base64")).update(`${id}.${ts}.${body}`).digest("base64")}`;
  const now = 1_800_000_000;

  it("accepts a valid signature", () => {
    const body = JSON.stringify({ id: "p1", status: "succeeded" });
    expect(verifyReplicateWebhook({ id: "msg_1", timestamp: String(now), signature: sign("msg_1", String(now), body) }, body, secret, now)).toBe(true);
  });
  it("rejects a wrong secret, a changed body, a stale timestamp and missing headers", () => {
    const body = "{}";
    const other = `whsec_${Buffer.from("other").toString("base64")}`;
    expect(verifyReplicateWebhook({ id: "m", timestamp: String(now), signature: sign("m", String(now), body, other) }, body, secret, now)).toBe(false);
    expect(verifyReplicateWebhook({ id: "m", timestamp: String(now), signature: sign("m", String(now), body) }, "{ }", secret, now)).toBe(false);
    expect(verifyReplicateWebhook({ id: "m", timestamp: String(now - 600), signature: sign("m", String(now - 600), body) }, body, secret, now)).toBe(false);
    expect(verifyReplicateWebhook({ id: null, timestamp: String(now), signature: "v1,x" }, body, secret, now)).toBe(false);
  });
});

describe("media link lifetime (R37)", () => {
  afterEach(() => vi.useRealTimers());

  it("a link lives at most a tenth longer than its TTL, however close to a boundary it is signed", async () => {
    for (const ttl of [300, 3600]) {
      for (const offset of [1, 17, 299, 1801, 3599]) {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date((1_800_000_000 + offset) * 1000));
        const url = new URL(await storage().signedUrl("outputs/abc/def.webp", ttl), "http://x");
        const lifetime = Number(url.searchParams.get("e")) - Math.floor(Date.now() / 1000);
        expect(lifetime, `ttl ${ttl}, signed ${offset} s after the hour`).toBeGreaterThanOrEqual(ttl);
        expect(lifetime, `ttl ${ttl}, signed ${offset} s after the hour`).toBeLessThanOrEqual(ttl * 1.1);
        vi.useRealTimers();
      }
    }
  });
});
