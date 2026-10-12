import { NextResponse, type NextRequest } from "next/server";
import { ZodError, type ZodTypeAny, type output } from "zod";
import { getCurrentUser, type SessionUser } from "@/server/auth/session";
import { InsufficientCreditsError } from "@/server/credits/ledger";
import { logger } from "@/server/log";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const unauthorized = () => new HttpError(401, "unauthorized", "Sign in to continue.");
export const forbidden = (msg = "You do not have access to this.") => new HttpError(403, "forbidden", msg);
// Not found and not-yours look identical, so ids of private content are not confirmed to others.
export const notFound = () => new HttpError(404, "not_found", "Not found.");

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw unauthorized();
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "admin") throw notFound();
  return user;
}

export async function parseJson<S extends ZodTypeAny>(req: Request, schema: S): Promise<output<S>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be JSON.");
  }
  return schema.parse(body);
}

/** Wraps a route handler with uniform error shapes and logging. */
export function route<C>(handler: (req: NextRequest, ctx: C) => Promise<Response>) {
  return async (req: NextRequest, ctx: C): Promise<Response> => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        return NextResponse.json({ error: { code: err.code, message: err.message, details: err.details } }, { status: err.status });
      }
      if (err instanceof ZodError) {
        return NextResponse.json(
          { error: { code: "invalid_input", message: "Some fields need attention.", details: err.flatten() } },
          { status: 422 },
        );
      }
      if (err instanceof InsufficientCreditsError) {
        return NextResponse.json(
          { error: { code: "insufficient_credits", message: err.message, details: { needed: err.needed, available: err.available } } },
          { status: 402 },
        );
      }
      if (isBadIdentifier(err)) {
        return NextResponse.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
      }
      logger.error("unhandled route error", { path: req.nextUrl.pathname, err });
      return NextResponse.json({ error: { code: "internal", message: "Something went wrong on our side." } }, { status: 500 });
    }
  };
}

/** Postgres rejects a malformed uuid with 22P02. To a client that is simply a missing record. */
function isBadIdentifier(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === "22P02") return true;
  }
  return false;
}
