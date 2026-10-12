type Level = "debug" | "info" | "warn" | "error";

function serialize(meta: Record<string, unknown> | undefined) {
  if (!meta) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v;
  }
  return out;
}

function write(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (process.env.NODE_ENV === "test" && !process.env.LOG_TESTS && level !== "error") return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...serialize(meta) });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

/** Structured JSON logs; ship stdout to the log pipeline / error monitor of choice. */
export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => write("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => write("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => write("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => write("error", msg, meta),
};
