import { NextResponse, type NextRequest } from "next/server";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // CSRF defense in depth (cookies are also SameSite=Lax): browser writes to the
  // API must come from this origin. Webhooks authenticate by signature instead.
  if (pathname.startsWith("/api/") && MUTATING.has(req.method) && !pathname.startsWith("/api/webhooks/")) {
    const origin = req.headers.get("origin");
    // Behind a proxy the request URL may carry the internal host, so the public APP_URL also counts.
    const publicOrigin = process.env.APP_URL ? new URL(process.env.APP_URL).origin : null;
    if (origin && origin !== req.nextUrl.origin && origin !== publicOrigin) {
      return NextResponse.json({ error: { code: "bad_origin", message: "Cross-site request refused." } }, { status: 403 });
    }
  }

  const headers = new Headers(req.headers);
  headers.set("x-pathname", pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
