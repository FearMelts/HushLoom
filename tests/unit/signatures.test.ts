import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
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
