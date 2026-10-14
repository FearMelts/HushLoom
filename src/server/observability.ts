import { env } from "@/server/env";
import { causeOf, logger, redactQueryParams, redactStack, setErrorSink, type ErrorSink } from "@/server/log";

/**
 * Error monitoring hook (spec part VI, audit gap G8). Every logger.error entry is a JSON line on
 * stdout whatever happens here. When ERROR_WEBHOOK_URL is set, each one is also POSTed there as a
 * small JSON event, so Sentry, an incident tool or a chat channel can be wired behind that URL (a relay
 * that maps the event to their API) without adding an SDK to the app.
 *
 * An event holds the log message, the error's name, message and stack (query parameters redacted,
 * both truncated), the route path and method, a few identifiers, the process and the time. It never
 * holds request bodies, query strings, headers, cookies, prompts or media: the fields are copied by
 * name, never by spreading the log entry. Delivery is fire-and-forget with a short timeout and a cap
 * per minute, so a broken monitor or an error storm cannot slow the app down. A failed delivery is a
 * warning, never an error, so it cannot loop back into the webhook.
 */

export type ErrorSource = "web" | "worker";

export type ErrorEvent = {
  source: ErrorSource;
  time: string;
  message: string;
  error?: { name: string; message: string; stack?: string; digest?: string; cause?: { name: string; message: string } };
  route?: string;
  path?: string;
  method?: string;
  context?: Record<string, string | number | boolean>;
};

/** Log fields that are identifiers or outcomes, never user content; only these travel with an event. */
const CONTEXT_KEYS = ["jobId", "verificationId", "provider", "outcome", "routeType"] as const;
const MAX_MESSAGE = 1_000;
const MAX_STACK = 8_000;
const MAX_FIELD = 200;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** A path without its query string or fragment, which can carry signed-link signatures and webhook tokens. */
export function pathOnly(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return clip(value.split(/[?#]/)[0]!, MAX_FIELD);
}

function errorOf(value: unknown): ErrorEvent["error"] {
  if (value instanceof Error) {
    const digest = (value as { digest?: unknown }).digest;
    const cause = causeOf(value);
    return {
      name: value.name,
      message: clip(redactQueryParams(value.message), MAX_MESSAGE),
      stack: value.stack ? clip(redactStack(value) ?? "", MAX_STACK) : undefined,
      digest: typeof digest === "string" ? digest : undefined,
      cause: cause ? { name: cause.name, message: clip(cause.message, MAX_MESSAGE) } : undefined,
    };
  }
  if (typeof value === "string" && value) return { name: "Error", message: clip(redactQueryParams(value), MAX_MESSAGE) };
  return undefined;
}

/** Builds the event for one logger.error call. Only named fields are read from the log entry. */
export function toErrorEvent(msg: string, meta: Record<string, unknown> | undefined, source: ErrorSource, time: Date): ErrorEvent {
  const context: Record<string, string | number | boolean> = {};
  for (const key of CONTEXT_KEYS) {
    const v = meta?.[key];
    if (typeof v === "string") context[key] = clip(v, MAX_FIELD);
    else if (typeof v === "number" || typeof v === "boolean") context[key] = v;
  }
  const route = pathOnly(meta?.route);
  const path = pathOnly(meta?.path);
  const method = typeof meta?.method === "string" ? clip(meta.method, 16) : undefined;
  return {
    source,
    time: time.toISOString(),
    message: clip(msg, MAX_FIELD),
    error: errorOf(meta?.err),
    ...(route ? { route } : {}),
    ...(path ? { path } : {}),
    ...(method ? { method } : {}),
    ...(Object.keys(context).length ? { context } : {}),
  };
}

export type ErrorWebhookOptions = {
  url: string;
  source: ErrorSource;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Events beyond this many in a minute are dropped and counted. */
  maxPerMinute?: number;
  now?: () => number;
};

/** An error sink that POSTs each event to `url`. Returns immediately; the request runs in the background. */
export function createErrorWebhook(options: ErrorWebhookOptions): ErrorSink {
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3_000;
  const maxPerMinute = options.maxPerMinute ?? 30;
  const now = options.now ?? Date.now;
  let windowStart = Number.NEGATIVE_INFINITY;
  let sent = 0;
  let dropped = 0;

  return (msg, meta) => {
    const t = now();
    if (t - windowStart >= 60_000) {
      if (dropped) logger.warn("error_webhook.dropped", { count: dropped });
      windowStart = t;
      sent = 0;
      dropped = 0;
    }
    if (sent >= maxPerMinute) {
      dropped++;
      return;
    }
    sent++;
    const body = JSON.stringify(toErrorEvent(msg, meta, options.source, new Date(t)));
    let request: Promise<Response>;
    try {
      request = send(options.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      logger.warn("error_webhook.unreachable", { err: (err as Error)?.name });
      return;
    }
    // Never the URL in these warnings: it may carry a token.
    void request.then(
      (res) => {
        void res.body?.cancel().catch(() => undefined);
        if (!res.ok) logger.warn("error_webhook.rejected", { status: res.status });
      },
      (err: unknown) => logger.warn("error_webhook.unreachable", { err: (err as Error)?.name }),
    );
  };
}

/**
 * Routes this process's error log entries to ERROR_WEBHOOK_URL when it is set. Returns whether a
 * webhook was installed. A configuration that does not parse installs nothing here; the same
 * error surfaces, as before, on the first request or job that reads the configuration.
 */
export function installErrorWebhook(source: ErrorSource): boolean {
  let url: string | undefined;
  try {
    url = env().ERROR_WEBHOOK_URL;
  } catch {
    return false;
  }
  if (!url) return false;
  setErrorSink(createErrorWebhook({ url, source }));
  return true;
}
