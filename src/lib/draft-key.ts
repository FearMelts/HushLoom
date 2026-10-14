/**
 * Idempotency for "Make it". The server answers a repeated key with the draft it already made,
 * whatever the new request says (src/server/generation/service.ts createDraft), so a key may only
 * be reused for the exact same request: a double tap gets the same draft, and any change (prompt,
 * settings, model, mode, upload, character, placement, Undo, Restore, a preset) gets a new key.
 */
export type DraftKey = { key: string; signature: string };

/** JSON with object keys sorted, so the same settings always give the same signature. */
export function stableSignature(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}

/** The key to send for `body`: the previous one when the body is unchanged, otherwise a fresh one. */
export function draftKeyFor(prev: DraftKey | null, body: unknown, newKey: () => string): DraftKey {
  const signature = stableSignature(body);
  return prev && prev.signature === signature ? prev : { key: newKey(), signature };
}
