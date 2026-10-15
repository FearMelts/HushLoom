import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { pricing } from "@/config/pricing";
import type { CheckoutItem } from "./types";

/** Looks up a pack or plan by key as a provider-neutral checkout item. */
export function checkoutItem(itemKey: string): CheckoutItem | null {
  const pack = pricing.packs.find((p) => p.key === itemKey);
  if (pack) return { key: pack.key, kind: "pack", label: pack.label, priceCents: pack.priceCents, currency: pricing.currency, credits: pack.credits };
  const plan = pricing.plans.find((p) => p.key === itemKey);
  if (plan) return { key: plan.key, kind: "plan", label: plan.label, priceCents: plan.priceCents, currency: pricing.currency, credits: plan.monthlyCredits };
  return null;
}

/** Constant-time string comparison that also hides length differences behind a false. */
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const md5 = (s: string) => createHash("md5").update(s).digest("hex");
export const hmacHex = (secret: string, s: string) => createHmac("sha256", secret).update(s).digest("hex");

/**
 * Processor webhooks arrive as JSON or as form encoding; some put fields in the query string.
 * Keys are lower-cased so the adapters can read them case-insensitively. Query values are read
 * first, body values override them, which matches how CCBill and Segpay append their own fields.
 */
export function webhookParams(rawBody: string, headers: Headers, url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of url.searchParams) out[k.toLowerCase()] = v;
  const type = headers.get("content-type") ?? "";
  if (rawBody.trim()) {
    if (type.includes("application/json")) {
      const parsed = JSON.parse(rawBody) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (v === null || v === undefined) continue;
          out[k.toLowerCase()] = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
        }
      }
    } else {
      for (const [k, v] of new URLSearchParams(rawBody)) out[k.toLowerCase()] = v;
    }
  }
  return out;
}

/** "10.00" -> 1000. Rejects anything that is not a plain decimal amount. */
export function parseMoneyCents(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^\s*(-?)(\d+)(?:\.(\d{1,2}))?\s*$/.exec(s);
  if (!m) return null;
  const cents = Number(m[2]) * 100 + Number((m[3] ?? "0").padEnd(2, "0"));
  return m[1] ? -cents : cents;
}

export const toMoneyString = (cents: number) => (cents / 100).toFixed(2);

/** ISO 4217 numeric codes CCBill accepts, in both directions. */
const NUMERIC_CURRENCY: Record<string, string> = { usd: "840", eur: "978", gbp: "826", cad: "124", aud: "036", jpy: "392" };

export function currencyToNumeric(iso: string): string {
  const code = NUMERIC_CURRENCY[iso.toLowerCase()];
  if (!code) throw new Error(`currency ${iso} has no numeric code configured`);
  return code;
}

/** The ISO code for a numeric one, or null for a code that is missing or not in the table: never a guess. */
export function currencyFromNumeric(numeric: string | undefined): string | null {
  if (!numeric) return null;
  const hit = Object.entries(NUMERIC_CURRENCY).find(([, n]) => n === numeric.padStart(3, "0"));
  return hit ? hit[0] : null;
}
