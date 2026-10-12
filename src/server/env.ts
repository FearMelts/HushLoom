import path from "node:path";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().default("postgres://playbox@localhost:5432/playbox"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
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
  cached = parsed;
  return parsed;
}

/** Dev/test fallback so local runs work without configuring a secret. Production refuses to start without one. */
export function mediaSigningSecret(): string {
  return env().MEDIA_SIGNING_SECRET ?? "dev-only-media-signing-secret-not-for-production";
}
