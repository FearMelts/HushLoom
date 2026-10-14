import { NextResponse, type NextRequest } from "next/server";
import { isCrossSiteWrite } from "@/server/origin";

export function middleware(req: NextRequest) {
  if (isCrossSiteWrite(req)) {
    return NextResponse.json({ error: { code: "bad_origin", message: "Cross-site request refused." } }, { status: 403 });
  }

  const headers = new Headers(req.headers);
  headers.set("x-pathname", req.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

// Next hands a route only the first 10 MB of a body when middleware runs on it, so the two upload
// routes (images up to 20 MB, videos up to 100 MB) are left out and make the cross-site check and
// their own size limit themselves (assertSameOrigin, readForm in src/server/http.ts).
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|api/uploads$|api/characters$).*)"] };
