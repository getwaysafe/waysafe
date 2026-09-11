/**
 * Phase 4-equivalent auth gate for the dashboard: every route requires a
 * session cookie except /login itself. This only checks that a cookie is
 * *present*, not that it decrypts cleanly -- a tampered or stale-secret
 * cookie still reaches a page. Every page calls `getSessionClient()` itself
 * and redirects to /login if that returns null, which is the real check;
 * this proxy exists so a browser with no cookie at all never round-trips to
 * a page before bouncing. Proxy always runs on the Node.js runtime (not
 * Edge), so it can share session.ts's `node:crypto`-based cookie name
 * constant without a separate Edge-safe build of it.
 *
 * Named `proxy.ts`, not `middleware.ts` -- Next 16 renamed the convention;
 * see https://nextjs.org/docs/messages/middleware-to-proxy.
 */

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "./lib/session";

export function proxy(request: NextRequest) {
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (!hasSession) {
    const login = new URL("/login", request.url);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  // D-42: /demo and its API routes are a standalone, unauthenticated-by-
  // design recordable page -- it holds its own fixed org credential
  // server-side (WAYSAFE_DEMO_ORG_API_KEY), never a user's session cookie.
  // D-43: /story is the same kind of standalone public page -- it makes no
  // server calls at all (no org credential, no database), so there is no
  // session to gate it behind.
  // D-44: /film is also standalone and public, but unlike /story it does
  // call the server -- through /api/demo/* (the same demo org credential
  // /demo already uses server-side), never a user's session cookie.
  matcher: ["/((?!login|demo|story|film|api/demo|_next/static|_next/image|favicon.ico).*)"],
};
