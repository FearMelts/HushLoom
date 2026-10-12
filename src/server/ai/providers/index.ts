import { inArray } from "drizzle-orm";
import { getDb } from "@/server/db";
import { modelConfigs } from "@/server/db/schema";
import { MODELS, type ModelSpec } from "@/server/ai/registry";
import { demoProvider } from "./demo";
import { replicateProvider } from "./replicate";
import type { ProviderAdapter } from "./types";

const ADAPTERS: Record<string, ProviderAdapter> = {
  [demoProvider.key]: demoProvider,
  [replicateProvider.key]: replicateProvider,
};

/** Test hook: lets integration tests swap a provider for a controllable fake. */
export function registerAdapter(adapter: ProviderAdapter) {
  ADAPTERS[adapter.key] = adapter;
}

export function adapterFor(model: ModelSpec): ProviderAdapter | undefined {
  return ADAPTERS[model.providerKey];
}

export type ModelAvailability = ModelSpec & { available: boolean; isDemo: boolean; reason?: string; priceMultiplierPct: number };

/** Models with their live availability: adapter configured and not disabled by an admin. */
export async function listModelAvailability(): Promise<ModelAvailability[]> {
  const overrides = await getDb()
    .select()
    .from(modelConfigs)
    .where(inArray(modelConfigs.modelKey, MODELS.map((m) => m.key)));
  return MODELS.map((m) => {
    const adapter = adapterFor(m);
    const override = overrides.find((o) => o.modelKey === m.key);
    const disabled = override ? !override.enabled : false;
    const configured = adapter?.isConfigured() ?? false;
    return {
      ...m,
      isDemo: adapter?.isDemo ?? false,
      available: Boolean(adapter) && configured && !disabled,
      reason: !adapter ? "No adapter" : !configured ? "Needs credentials" : disabled ? "Disabled by an admin" : undefined,
      priceMultiplierPct: override?.priceMultiplier ?? 100,
    };
  });
}
