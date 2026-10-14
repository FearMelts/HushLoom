/**
 * Server-side content policy. This is a deterministic baseline that always runs;
 * a production deployment should add a trained classifier behind ModerationProvider
 * (see docs). Rules are deliberately strict: a false block costs a rephrase, a
 * false pass can cost a person their safety.
 */

export type PolicyCategory = "minors" | "non_consent" | "real_person" | "bestiality" | "incest" | "extreme_harm";

export type PolicyVerdict =
  | { allowed: true }
  | { allowed: false; category: PolicyCategory; matched: string; message: string };

const MESSAGES: Record<PolicyCategory, string> = {
  minors: "Hushloom only allows content depicting adults. Anything suggesting a minor is blocked.",
  non_consent: "Content must show enthusiastic consent. Depictions of coercion or non-consent are blocked.",
  real_person: "Sexual content of real, identifiable people needs their recorded consent through Train. Prompts naming public figures are blocked.",
  bestiality: "This content is not allowed on Hushloom.",
  incest: "This content is not allowed on Hushloom.",
  extreme_harm: "Sexual content combined with serious violence is not allowed on Hushloom.",
};

const RULES: { category: PolicyCategory; patterns: RegExp[] }[] = [
  {
    category: "minors",
    patterns: [
      /\b(child|children|kid|kids|minor|minors|underage|under-age|preteen|pre-teen|teen|teens|teenage|teenager|tween|infant|toddler|baby ?face|schoolgirl|schoolboy|school ?uniform|loli|lolita|shota|jailbait|barely legal|youngster|juvenile|adolescent|pubescent|prepubescent|little girl|little boy|young girl|young boy)\b/,
      // "16yo", "16 y/o", "16 year old", "16-year-old", "16yrs old". Plain "5 years" (of anything) is not an age.
      /\b(1[0-7]|[1-9])\s*-?\s*(yo|y\/o|y\.o\.?|(yrs?|years?)\s*-?\s*old)(?![a-z])/,
      /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)\s*-?\s*(yrs?|years?)\s*-?\s*old\b/,
      /\b(aged?)\s*(1[0-7]|[1-9])\b/,
      /\b(grade|middle|elementary|high) ?school(er)?\b/,
    ],
  },
  {
    category: "non_consent",
    patterns: [
      /\b(rape|raped|raping|non-?consensual|nonconsensual|forced|forcing|against (her|his|their) will|drugged|unconscious|passed out|sleeping|asleep|blackmail(ed)?|coerc(ed|ion)|molest(ed|ing)?|hidden cam(era)?|spy ?cam|upskirt|creepshot|revenge porn|leaked nudes?)\b/,
    ],
  },
  {
    category: "real_person",
    patterns: [/\b(celebrity|celeb|famous (actress|actor|singer|person)|deepfake|look-?alike of|lookalike of|face of a real|my (ex|coworker|neighbou?r|classmate|teacher|boss))\b/],
  },
  { category: "bestiality", patterns: [/\b(bestiality|zoophilia|with an? (dog|horse|animal))\b/] },
  { category: "incest", patterns: [/\b(incest|step-?(sis|sister|bro|brother|mom|dad|daughter|son)|(my|her|his) (sister|brother|mother|father|daughter|son))\b/] },
  { category: "extreme_harm", patterns: [/\b(snuff|gore|mutilat\w*|torture|necro\w*|choking to death|strangl\w*)\b/] },
];

/** Undo common evasions: leetspeak, separators between letters, repeated letters. */
export function normalizeForPolicy(input: string): string {
  let s = input.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  s = s.replace(/[0@4]/g, (c) => ({ "0": "o", "@": "a", "4": "a" })[c] ?? c);
  // Joined single letters ("t e e n", "t.e.e.n") become a word.
  s = s.replace(/\b(?:[a-z][\s._*-]){2,}[a-z]\b/g, (m) => m.replace(/[\s._*-]/g, ""));
  s = s.replace(/([a-z])\1{2,}/g, "$1$1");
  return s.replace(/\s+/g, " ");
}

export function checkPrompt(...texts: string[]): PolicyVerdict {
  const raw = texts.join(" \n ");
  // Check both the raw lowercase text (keeps digits for age patterns) and the normalized form.
  const candidates = [raw.toLowerCase(), normalizeForPolicy(raw)];
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      for (const text of candidates) {
        const m = text.match(pattern);
        if (m) return { allowed: false, category: rule.category, matched: m[0], message: MESSAGES[rule.category] };
      }
    }
  }
  return { allowed: true };
}

/**
 * Every string value in a generation's settings. Free-text settings (atmosphere, and anything a
 * client or an older row carries) go through the same check as the prompt, at draft and at publish.
 */
export function paramTexts(params: Record<string, unknown> | null | undefined): string[] {
  return Object.values(params ?? {}).filter((v): v is string => typeof v === "string");
}

export const ADULT_AGE = 18;

export function ageOn(dateOfBirth: string, today = new Date()): number {
  const [y, m, d] = dateOfBirth.split("-").map(Number) as [number, number, number];
  let age = today.getUTCFullYear() - y;
  const beforeBirthday = today.getUTCMonth() + 1 < m || (today.getUTCMonth() + 1 === m && today.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  return age;
}

/**
 * Regions whose law requires verified age assurance (not self-declaration) are
 * configured in AGE_ASSURANCE_STRICT_REGIONS. The provider-backed gate in
 * src/server/age folds that list into its own rules, so this helper is kept
 * only as a pure predicate for tooling and tests.
 */
export function ageAssuranceBlocksRegion(method: string, country: string | null, strictRegions: string): boolean {
  if (!country) return false;
  const strict = strictRegions
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return strict.includes(country.toUpperCase()) && method === "self_declaration";
}
