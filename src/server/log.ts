type Level = "debug" | "info" | "warn" | "error";

/**
 * Drizzle's query errors carry the bound parameters in their message and stack ("params: ..."), and
 * those can hold prompts or emails. Logs keep the query text and drop the values. The parameters end
 * the message, and one can hold newlines (a prompt typed over several lines, even a line that starts
 * with "at "), so everything after "params: " goes: never cut at what merely looks like a stack frame.
 */
export function redactQueryParams(text: string): string;
export function redactQueryParams(text: string | undefined): string | undefined;
export function redactQueryParams(text: string | undefined): string | undefined {
  return text?.replace(/\nparams: [\s\S]*$/, "\nparams: [redacted]");
}

/**
 * The error's stack with its message redacted as above and its frames kept. The stack repeats the
 * message verbatim, so that copy is swapped for the redacted one; a stack that does not hold the
 * message as is loses everything after "params: ", frames included.
 */
export function redactStack(err: Error): string | undefined {
  const { stack, message } = err;
  if (!stack) return stack;
  const redacted = redactQueryParams(message);
  const at = redacted === message ? -1 : stack.indexOf(message);
  return at >= 0 ? stack.slice(0, at) + redacted + stack.slice(at + message.length) : redactQueryParams(stack);
}

/**
 * Redacts, in place, the query parameters an error and its causes carry: message, stack and Drizzle's
 * own `params` field, and the driver's `detail` field, where Postgres repeats the offending values
 * ("Failing row contains (...)", "Key (lower(email))=(...) already exists."). For an error that other
 * code prints after the app has logged it: Next.js's production server prints every error it reports
 * to instrumentation with console.error. The whole cause chain is walked: Next.js's production
 * inspect prints causes at any depth.
 */
export function scrubQueryParams(err: unknown): void {
  const seen = new Set<Error>();
  for (let e: unknown = err; e instanceof Error && !seen.has(e); e = e.cause) {
    seen.add(e);
    if (typeof (e as { detail?: unknown }).detail === "string") (e as { detail?: unknown }).detail = "[redacted]";
    const message = redactQueryParams(e.message);
    if (message === e.message) continue;
    e.stack = redactStack(e);
    e.message = message;
    if (Object.hasOwn(e, "params")) (e as { params?: unknown }).params = "[redacted]";
  }
}

/** The direct cause's name and message (a wrapped query error's real reason, such as ECONNREFUSED). */
export function causeOf(err: Error): { name: string; message: string } | undefined {
  const cause: unknown = err.cause;
  return cause instanceof Error ? { name: cause.name, message: redactQueryParams(cause.message) } : undefined;
}

/** Error values become name, message, stack and cause; strings are redacted too, since call sites log a caught error's message as one. */
function serialize(meta: Record<string, unknown> | undefined) {
  if (!meta) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v instanceof Error) out[k] = { name: v.name, message: redactQueryParams(v.message), stack: redactStack(v), cause: causeOf(v) };
    else out[k] = typeof v === "string" ? redactQueryParams(v) : v;
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
