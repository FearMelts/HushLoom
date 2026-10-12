/**
 * Placeholder economics. None of these numbers come from any existing product;
 * the operator sets real prices here (and per-model multipliers in model_configs).
 */
export const pricing = {
  imageBase: 4,
  videoPerSecond: 3,
  qualityMultiplier: { hd: 1, "4k": 2 } as Record<string, number>,
  currency: "usd",
  packs: [
    { key: "pack_small", credits: 100, priceCents: 999, label: "Spark" },
    { key: "pack_medium", credits: 550, priceCents: 4499, label: "Flicker" },
    { key: "pack_large", credits: 1200, priceCents: 8999, label: "Blaze" },
  ],
  plans: [
    {
      key: "plan_member",
      label: "Night Pass",
      monthlyCredits: 400,
      priceCents: 1999,
      perks: ["400 credits each month", "VIP templates", "3 generations at once"],
      maxActiveJobs: 3,
      vip: true,
    },
    {
      key: "plan_studio",
      label: "Studio Pass",
      monthlyCredits: 1500,
      priceCents: 5999,
      perks: ["1,500 credits each month", "VIP templates", "6 generations at once"],
      maxActiveJobs: 6,
      vip: true,
    },
  ],
} as const;

export type PackKey = (typeof pricing.packs)[number]["key"];
export type PlanKey = (typeof pricing.plans)[number]["key"];
