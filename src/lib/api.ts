export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }

  /** Where the person can fix a 451 "age_verification_required" error; null for every other error. */
  get verifyPath(): string | null {
    if (this.status !== 451) return null;
    const path = (this.details as { verifyPath?: unknown } | undefined)?.verifyPath;
    return typeof path === "string" && path.startsWith("/") ? path : AGE_VERIFICATION_PATH;
  }
}

export const AGE_VERIFICATION_PATH = "/settings#age-verification";

/**
 * A ready-made toast action for an API error: a 451 points at the age check in Settings so any
 * caller can show the message with a way to fix it. Other errors have no action.
 */
export function apiErrorAction(err: unknown): { label: string; href: string } | undefined {
  const path = err instanceof ApiError ? err.verifyPath : null;
  return path ? { label: "Verify your age", href: path } : undefined;
}

/** Browser-side fetch wrapper with the server's uniform error shape. */
export async function api<T>(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body || init.form ? "POST" : "GET"),
    headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
    credentials: "same-origin",
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = (data as { error?: { code: string; message: string; details?: unknown } } | null)?.error;
    let message = err?.message ?? `Request failed (${res.status})`;
    // Callers that only render the message still get a way forward on an age-check refusal.
    if (res.status === 451 && err?.code === "age_verification_required") message = `${message} Open Settings › Age verification to do it.`;
    throw new ApiError(res.status, err?.code ?? "error", message, err?.details);
  }
  return data as T;
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
