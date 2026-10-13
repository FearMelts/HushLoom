import { constants, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_AGE_VERIFICATION_REGIONS, jurisdictionCode, jurisdictionRequiresVerification } from "@/config/jurisdictions";
import { sandboxCallback, sandboxCallbackSchema, signSandboxBody } from "@/server/age/providers/sandbox";
import { mapYotiStatus, verifyYotiNotification } from "@/server/age/providers/yoti";

describe("jurisdiction codes", () => {
  it("builds GB / US-TX codes from the edge headers and matches configured regions", () => {
    expect(jurisdictionCode("gb", null)).toBe("GB");
    expect(jurisdictionCode("US", "tx")).toBe("US-TX");
    expect(jurisdictionCode("US", "US-TX")).toBe("US-TX");
    expect(jurisdictionCode("US", null)).toBe("US");
    expect(jurisdictionCode(null, "TX")).toBeNull();
    expect(jurisdictionRequiresVerification("US-TX", DEFAULT_AGE_VERIFICATION_REGIONS)).toBe(true);
    expect(jurisdictionRequiresVerification("US-CA", DEFAULT_AGE_VERIFICATION_REGIONS)).toBe(false);
    expect(jurisdictionRequiresVerification("US-CA", ["US"])).toBe(true);
    expect(jurisdictionRequiresVerification("GB", ["gb"])).toBe(true);
    expect(jurisdictionRequiresVerification(null, ["GB"])).toBe(false);
  });
});

describe("sandbox callback signing", () => {
  it("signs a body that the schema accepts and the signature is bound to that body", () => {
    const { body, signature } = sandboxCallback("sbx_abcdefgh", "verified");
    expect(sandboxCallbackSchema.safeParse(JSON.parse(body)).success).toBe(true);
    expect(signSandboxBody(body)).toBe(signature);
    expect(signSandboxBody(body.replace("verified", "failed"))).not.toBe(signature);
  });
});

describe("yoti notification signature", () => {
  // The documented scheme: RSA-PSS/SHA-256 over the payload minus sequence_number and signature,
  // serialized without whitespace, salt length = signature bytes - 32 - 2.
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const payload = {
    method: "AGE_ESTIMATION",
    age: 18,
    session_key: "0d6f8e3c-1111-2222-3333-444444444444",
    reference_id: "our-row-id",
    id: "notif-1",
    timestamp: 1760300000,
    notification_url: "https://hushloom.example/api/webhooks/age-verification/yoti",
    evidence_id: "ev-1",
    state: "COMPLETE",
    check_type: "PASSIVE",
  };
  const signed = (p: Record<string, unknown>) => {
    const data = Buffer.from(JSON.stringify(p).replace(/\s/g, ""), "utf8");
    const sig = sign("sha256", data, { key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 256 - 32 - 2 });
    return { ...p, sequence_number: 1, signature: sig.toString("base64") };
  };

  it("accepts a correctly signed notification and rejects tampering or another key", () => {
    const n = signed(payload);
    expect(verifyYotiNotification(n, publicKey)).toBe(true);
    expect(verifyYotiNotification({ ...n, state: "FAIL" }, publicKey)).toBe(false);
    expect(verifyYotiNotification({ ...n, signature: Buffer.alloc(256).toString("base64") }, publicKey)).toBe(false);
    expect(verifyYotiNotification({ ...n, signature: "short" }, publicKey)).toBe(false);
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
    expect(verifyYotiNotification(n, other)).toBe(false);
    // sequence_number is outside the signed part, so a retried delivery still verifies.
    expect(verifyYotiNotification({ ...n, sequence_number: 2 }, publicKey)).toBe(true);
  });

  it("maps session statuses to outcomes and keeps unknown states pending", () => {
    expect(mapYotiStatus("COMPLETE", "DOC_SCAN")).toEqual({ outcome: "verified", method: "doc_scan" });
    expect(mapYotiStatus("FAIL")).toMatchObject({ outcome: "failed", failureReason: "not_over_threshold" });
    expect(mapYotiStatus("ERROR")).toMatchObject({ outcome: "failed", failureReason: "provider_error" });
    expect(mapYotiStatus("CANCELLED")).toMatchObject({ outcome: "failed" });
    expect(mapYotiStatus("EXPIRED")).toMatchObject({ outcome: "failed" });
    for (const s of ["PENDING", "IN_PROGRESS", "PROCESSING", "SOMETHING_NEW"]) expect(mapYotiStatus(s).outcome).toBe("pending");
  });
});
