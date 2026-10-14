import { afterEach, describe, expect, it, vi } from "vitest";

// env() caches its first parse, so every case loads a fresh copy of the module.
async function load(vars: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
  return import("@/server/env");
}

const productionBuild = {
  NODE_ENV: "production",
  MEDIA_SIGNING_SECRET: "x".repeat(32),
  STORAGE_LOCAL_DIR: "/data/storage",
  APP_ENV: undefined,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("live deployment guard", () => {
  it("treats a production build without APP_ENV as a live site and refuses the sandbox defaults", async () => {
    const mod = await load(productionBuild);
    expect(() => mod.env()).toThrow(/SCAN_PROVIDER=dev cannot run in production/);
  });

  it("refuses the sandbox age check on a live site while enforcement is on", async () => {
    const mod = await load({ ...productionBuild, SCAN_FAIL_CLOSED: "false" });
    expect(() => mod.env()).toThrow(/AGE_VERIFICATION_PROVIDER=sandbox cannot run in production/);
  });

  it("lets a production build run the sandboxes only when APP_ENV says it is not live", async () => {
    const mod = await load({ ...productionBuild, APP_ENV: "test" });
    expect(() => mod.env()).not.toThrow();
    expect(mod.isLiveDeployment()).toBe(false);
  });

  it("treats APP_ENV=production as live even on a development build", async () => {
    const mod = await load({ NODE_ENV: "development", APP_ENV: "production", MEDIA_SIGNING_SECRET: undefined });
    expect(() => mod.env()).toThrow(/SCAN_PROVIDER=dev cannot run in production/);
  });

  it("the sandbox providers refuse to work on a live site", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MEDIA_SIGNING_SECRET", "x".repeat(32));
    vi.stubEnv("STORAGE_LOCAL_DIR", "/data/storage");
    vi.stubEnv("SCAN_FAIL_CLOSED", "false");
    vi.stubEnv("AGE_VERIFICATION_ENFORCE", "false");
    const { isLiveDeployment } = await import("@/server/env");
    const { sandboxAllowed } = await import("@/server/payments/providers/sandbox");
    const { sandboxProvider } = await import("@/server/age/providers/sandbox");
    const { devScanProvider } = await import("@/server/safety/scan/providers/dev");
    expect(isLiveDeployment()).toBe(true);
    expect(sandboxAllowed()).toBe(false);
    expect(sandboxProvider.isConfigured()).toBe(false);
    expect(devScanProvider.isConfigured()).toBe(false);
  });
});
