type Level = "debug" | "info" | "warn" | "error";

/**
 * Drizzle's query errors carry the bound parameters in their message and stack ("params: ..."), and
 * those can hold prompts or emails. Logs keep the query text and drop the values.
 */
export function redactQueryParams(text: string): string;
export function redactQueryParams(text: string | undefined): string | undefined;
export function redactQueryParams(text: string | undefined): string | undefined {
  return text?.replace(/\nparams: [\s\S]*?(?=\n\s+at |$)/, "\nparams: [redacted]");
}

/** The direct cause's name and message (a wrapped query error's real reason, such as ECONNREFUSED). */
export function causeOf(err: Error): { name: string; message: string } | undefined {
  const cause: unknown = err.cause;
  return cause instanceof Error ? { name: cause.name, message: redactQueryParams(cause.message) } : undefined;
}

function serialize(meta: Record<string, unknown> | undefined) {
  if (!meta) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = v instanceof Error ? { name: v.name, message: redactQueryParams(v.message), stack: redactQueryParams(v.stack), cause: causeOf(v) } : v;
  }
  return out;
}

/** Receives every error entry after it is written; see src/server/observability.ts. */
export type ErrorSink = (msg: string, meta: Record<string, unknown> | undefined) => void;

// Held on globalThis: Next.js bundles instrumentation.ts (which installs the sink) and the route
// handlers (which log) into separate module graphs, so a module-level variable would not be shared.
const SINK = Symbol.for("hushloom.log.errorSink");
const holder = globalThis as typeof globalThis & { [SINK]?: ErrorSink | null };

/** Installs (or with null, removes) the error sink for this process. */
export function setErrorSink(sink: ErrorSink | null) {
  holder[SINK] = sink;
}

function write(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (process.env.NODE_ENV === "test" && !process.env.LOG_TESTS && level !== "error") return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...serialize(meta) });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
  const sink = level === "error" ? holder[SINK] : null;
  if (sink) {
    try {
      sink(msg, meta);
    } catch {
      // Monitoring must never break the code path that is reporting a failure.
    }
  }
}

/** Structured JSON logs on stdout; errors also go to the optional error sink (ERROR_WEBHOOK_URL). */
export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => write("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => write("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => write("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => write("error", msg, meta),
};
