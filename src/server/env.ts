import path from "node:path";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /**
   * What kind of deployment this is, separate from NODE_ENV (which only says how the code was built).
   * Unset means "same as NODE_ENV", so a production build is treated as a live site. Sandbox payments,
   * the sandbox age check and the development scanner refuse to run on a live site. The e2e stack sets
   * "test" so a production build can exercise the sandboxes; "staging" is for a private preview.
   * Never set it on a public site.
   */
  APP_ENV: z.enum(["development", "test", "staging", "production"]).optional(),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().default("postgres://playbox@localhost:5432/playbox"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /**
   * How many reverse proxies you run in front of the app that append to (or set) X-Forwarded-For. Rate
   * limits key on the address the outermost of them saw (the n-th entry from the right,
   * src/server/request.ts); entries further left are whatever the client sent and are never used.
   * 0: nothing in front of the app. Next.js records the connection's address only when the request
   * carries no X-Forwarded-For, so the app cannot tell a forged address from a real one, and every
   * request shares one key: the per-address limits then hold for the whole site at once. A public site
   * runs behind a proxy and sets at least 1.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().nonnegative().default(0),
  MEDIA_SIGNING_SECRET: z.string().min(32).optional(),
  MEDIA_URL_TTL_S: z.coerce.number().int().positive().default(300),
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default(".storage"),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  ENABLE_DEMO_PROVIDER: z.enum(["true", "false"]).default("true"),
  REPLICATE_API_TOKEN: z.string().optional(),
  REPLICATE_WEBHOOK_SECRET: z.string().optional(),
  PROVIDER_TIMEOUT_S: z.coerce.number().int().positive().default(600),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().optional(),
  USER_MAX_ACTIVE_JOBS: z.coerce.number().int().positive().default(3),
  SIGNUP_GRANT_CREDITS: z.coerce.number().int().nonnegative().default(0),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  AGE_ASSURANCE_STRICT_REGIONS: z.string().default(""),
  GEO_COUNTRY_HEADER: z.string().default("x-country-code"),
  /** US state / region code header from the edge (e.g. "TX"); combined with the country as "US-TX". */
  GEO_REGION_HEADER: z.string().default("x-region-code"),

  // ── Payments (addendum §1). Stripe stays an adapter but is off unless chosen explicitly:
  // its restricted-businesses policy bans adult content, AI-generated included
  // (https://stripe.com/legal/restricted-businesses). "sandbox" never charges anyone.
  PAYMENT_PROVIDER: z.enum(["sandbox", "ccbill", "segpay", "stripe"]).default("sandbox"),
  CCBILL_ACCOUNT: z.string().optional(),
  CCBILL_SUBACCOUNT: z.string().optional(),
  CCBILL_FLEXFORM_ID: z.string().optional(),
  CCBILL_SALT: z.string().optional(),
  /** Shared secret appended to the registered CCBill webhook URL (?token=...). Required: without it CCBill stays off, since its refunds, chargebacks, renewals and cancellations carry no signature. */
  CCBILL_WEBHOOK_TOKEN: z.string().min(16).optional(),
  CCBILL_DATALINK_USER: z.string().optional(),
  CCBILL_DATALINK_PASSWORD: z.string().optional(),
  SEGPAY_PACKAGE_ID: z.string().optional(),
  SEGPAY_PRICE_POINT_ID: z.string().optional(),
  SEGPAY_USER_ACCESS_KEY: z.string().optional(),
  SEGPAY_POSTBACK_SECRET: z.string().optional(),

  // ── Age verification (addendum §2). "sandbox" is a labeled development provider that proves
  // nothing and refuses to run in production; "yoti" is Yoti's Age Verification Service
  // (https://developers.yoti.com/age-verification), written against the public docs and
  // unexercised without an account.
  AGE_VERIFICATION_PROVIDER: z.enum(["sandbox", "yoti"]).default("sandbox"),
  AGE_VERIFICATION_ENFORCE: z.enum(["true", "false"]).default("true"),
  /** Comma-separated override of the jurisdictions that require verification (defaults in src/config/jurisdictions.ts). */
  AGE_VERIFICATION_REGIONS: z.string().optional(),
  /** When the location is unknown (no geo header, an XX/T1/A1/A2 marker, or "US" without a state) and regions are configured, block creation (true) or allow (false). */
  AGE_VERIFICATION_FAIL_CLOSED: z.enum(["true", "false"]).default("false"),
  /** Yoti: the Age Verification API key (sent as "Authorization: Bearer"). */
  AGE_VERIFICATION_API_KEY: z.string().optional(),
  /** Yoti: the SDK ID from the Yoti Hub (sent as the "Yoti-SDK-Id" header and in the hosted URL). */
  AGE_VERIFICATION_SDK_ID: z.string().optional(),
  /** Yoti: base URL of the Age Verification API; the public docs name https://age.yoti.com. */
  AGE_VERIFICATION_API_URL: z.string().url().default("https://age.yoti.com"),
  /** Yoti: the Age Verification notifications public key (PEM, copied from the notifications page of the docs); every notification's RSA-PSS signature is checked against it. */
  AGE_VERIFICATION_NOTIFICATION_PUBLIC_KEY: z.string().optional(),
  /** Sandbox: HMAC secret for the sandbox callback; a dev-only fallback is used when unset. */
  AGE_VERIFICATION_WEBHOOK_SECRET: z.string().optional(),
  AGE_VERIFICATION_VALID_DAYS: z.coerce.number().int().positive().default(365),

  // ── Abuse scanning (addendum §3). "dev" is a labeled development scanner; production needs PhotoDNA
  // (pre-storage), optionally with Cloudflare's edge tool as a second layer. See docs/abuse-response.md.
  SCAN_PROVIDER: z.enum(["dev", "photodna", "cloudflare"]).default("dev"),
  /** true: content the scanner could not check is never kept (uploads 503, outputs retried). */
  SCAN_FAIL_CLOSED: z.enum(["true", "false"]).default("true"),
  PHOTODNA_API_KEY: z.string().optional(),
  /** The PhotoDNA Match URL exactly as Microsoft issues it to an approved account. */
  PHOTODNA_ENDPOINT: z.string().url().optional(),
  /** Unused: Cloudflare's CSAM Scanning Tool notifies by email only and offers no webhook to verify. */
  CLOUDFLARE_SCAN_WEBHOOK_SECRET: z.string().optional(),
  /** Seconds before one scanner call counts as unavailable. */
  SCAN_TIMEOUT_S: z.coerce.number().int().positive().default(30),
  /** Dev scanner only: comma-separated sha256 hashes that count as a match, for tests and drills. */
  SCAN_DEV_MATCH_HASHES: z.string().default(""),
  /** Dev scanner only: "true" makes every scan unavailable, to rehearse an outage. */
  SCAN_DEV_SIMULATE_OUTAGE: z.enum(["true", "false"]).default("false"),

  // ── Installable web app and push (addendum §4). Without VAPID keys push is disabled and says so.
  // Generate one pair per deployment with `npx web-push generate-vapid-keys` and keep both in the
  // secret store, never in the repo. Rotating the pair invalidates every existing subscription.
  /** Base64url P-256 public key (65 bytes decoded); browsers subscribe with it. */
  VAPID_PUBLIC_KEY: z.string().optional(),
  /** Base64url P-256 private key (32 bytes decoded); signs each push request. Secret. */
  VAPID_PRIVATE_KEY: z.string().optional(),
  /** Contact for push services: a mailto: address or an https: URL (Apple rejects localhost). */
  VAPID_SUBJECT: z.string().optional(),

  // ── Observability. Every error is a JSON line on stdout (src/server/log.ts) whatever is set here.
  // With ERROR_WEBHOOK_URL, each error is also POSTed there as a small JSON event (message, stack,
  // route, time; never request bodies, query strings, prompts or media), fire-and-forget with a short
  // timeout. Put Sentry, an incident tool or a chat channel behind it (src/server/observability.ts).
  /** Receives error events as JSON POSTs. Secret when it carries a token in its path or query. */
  ERROR_WEBHOOK_URL: z.string().url().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.parse(process.env);
  if (parsed.NODE_ENV === "production" && !parsed.MEDIA_SIGNING_SECRET) {
    throw new Error("MEDIA_SIGNING_SECRET must be set in production");
  }
  // The standalone server changes its working directory, so a relative path would point the app
  // and the worker at different folders. Production needs one absolute location both share.
  if (parsed.NODE_ENV === "production" && parsed.STORAGE_DRIVER === "local" && !path.isAbsolute(parsed.STORAGE_LOCAL_DIR)) {
    throw new Error("STORAGE_LOCAL_DIR must be an absolute path in production");
  }
  if (parsed.STORAGE_DRIVER === "s3" && !parsed.S3_BUCKET) {
    throw new Error("S3_BUCKET must be set when STORAGE_DRIVER=s3");
  }
  const live = (parsed.APP_ENV ?? parsed.NODE_ENV) === "production";
  if (live && parsed.SCAN_PROVIDER === "dev" && parsed.SCAN_FAIL_CLOSED === "true") {
    // The dev scanner matches nothing real. Production must name a real scanner or explicitly opt out of fail-closed.
    throw new Error("SCAN_PROVIDER=dev cannot run in production; configure photodna or cloudflare");
  }
  if (live && parsed.AGE_VERIFICATION_PROVIDER === "sandbox" && parsed.AGE_VERIFICATION_ENFORCE === "true") {
    // The sandbox check proves nothing about anyone's age. Production must name a real provider or explicitly turn enforcement off.
    throw new Error("AGE_VERIFICATION_PROVIDER=sandbox cannot run in production when AGE_VERIFICATION_ENFORCE=true; configure yoti");
  }
  cached = parsed;
  return parsed;
}

/** True on a live site: APP_ENV=production, or APP_ENV unset on a production build. Sandboxes refuse to run there. */
export function isLiveDeployment(): boolean {
  const e = env();
  return (e.APP_ENV ?? e.NODE_ENV) === "production";
}

/** Dev/test fallback so local runs work without configuring a secret. Production refuses to start without one. */
export function mediaSigningSecret(): string {
  return env().MEDIA_SIGNING_SECRET ?? "dev-only-media-signing-secret-not-for-production";
}
