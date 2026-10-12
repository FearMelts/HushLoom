import { describe, expect, it } from "vitest";
import { ageAssuranceBlocksRegion, ageOn, checkPrompt, normalizeForPolicy } from "@/server/safety/policy";

const blocked = (p: string) => {
  const v = checkPrompt(p);
  return v.allowed ? null : v.category;
};

describe("content policy", () => {
  it.each([
    ["a teen on a bed", "minors"],
    ["16yo model", "minors"],
    ["a 16 y/o", "minors"],
    ["a 10-year-old", "minors"],
    ["fifteen year old girl", "minors"],
    ["aged 15", "minors"],
    ["school uniform, pleated skirt", "minors"],
    ["t e e n posing", "minors"],
    ["t.e.e.n posing", "minors"],
    ["teeeen", "minors"],
    ["l0lita style", "minors"],
    ["she is asleep and he undresses her", "non_consent"],
    ["forced against her will", "non_consent"],
    ["hidden camera in the shower", "non_consent"],
    ["deepfake of a famous actress", "real_person"],
    ["my coworker in lingerie", "real_person"],
    ["stepsister", "incest"],
    ["with a dog", "bestiality"],
    ["strangled while", "extreme_harm"],
  ])("blocks %s", (prompt, category) => {
    expect(blocked(prompt)).toBe(category);
  });

  it.each([
    "adult woman lounging on a velvet chaise at golden hour",
    "two adults, 30 years old, dancing in a neon lounge",
    "an 18-year-old adult model in a studio",
    "married 5 years, anniversary dinner by candlelight",
    "a woman with 10 years of experience as a dancer",
    "slow push in on her smile",
  ])("allows %s", (prompt) => {
    expect(checkPrompt(prompt)).toEqual({ allowed: true });
  });

  it("checks every field it is given, including the negative prompt", () => {
    expect(checkPrompt("adult couple", "", "teen").allowed).toBe(false);
  });

  it("normalizes common evasions", () => {
    expect(normalizeForPolicy("T.E.E.N")).toBe("teen");
    expect(normalizeForPolicy("sl33py")).toContain("sl");
    expect(normalizeForPolicy("y o u n g g i r l")).toBe("younggirl");
  });
});

describe("age", () => {
  const today = new Date("2026-10-12T12:00:00Z");
  it("computes age with the birthday boundary", () => {
    expect(ageOn("2008-10-12", today)).toBe(18);
    expect(ageOn("2008-10-13", today)).toBe(17);
    expect(ageOn("1990-01-01", today)).toBe(36);
  });
  it("blocks self-declared accounts only in strict regions", () => {
    expect(ageAssuranceBlocksRegion("self_declaration", "GB", "GB, FR")).toBe(true);
    expect(ageAssuranceBlocksRegion("self_declaration", "fr", "GB,FR")).toBe(true);
    expect(ageAssuranceBlocksRegion("self_declaration", "US", "GB,FR")).toBe(false);
    expect(ageAssuranceBlocksRegion("verified_provider", "GB", "GB")).toBe(false);
    expect(ageAssuranceBlocksRegion("self_declaration", null, "GB")).toBe(false);
  });
});
