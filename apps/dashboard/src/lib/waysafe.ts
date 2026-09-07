/**
 * Server-only: builds an `@waysafe/sdk` client from the current request's
 * session cookie. Every dashboard page is a Server Component that calls
 * this once and reads data straight from the SDK -- there is no dashboard
 * API layer of its own, and no client-side fetching. The org credential
 * never reaches the browser except as the opaque, encrypted cookie value
 * (session.ts).
 */

import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Waysafe } from "@waysafe/sdk";
import { decryptSession, SESSION_COOKIE_NAME } from "./session";

const BASE_URL = process.env.WAYSAFE_API_BASE_URL ?? "http://localhost:3001";

/** Null when there's no session, or the cookie doesn't decrypt -- callers
 * (pages) redirect to /login in that case. Middleware already keeps
 * unauthenticated requests off every page but /login, so in practice this
 * is a defense-in-depth check, not the primary gate. */
export async function getSessionClient(): Promise<Waysafe | null> {
  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE_NAME)?.value;
  if (!cookie) return null;

  const apiKey = decryptSession(cookie);
  if (!apiKey) return null;

  return new Waysafe({ baseUrl: BASE_URL, apiKey });
}

/** Every dashboard page calls this instead of `getSessionClient()` directly:
 * middleware already keeps a cookie-less request off every page but /login,
 * so reaching here with no valid session means the cookie didn't decrypt
 * (wrong/rotated secret, tampering) -- treat it exactly like never having
 * logged in. */
export async function requireSessionClient(): Promise<Waysafe> {
  const client = await getSessionClient();
  if (!client) redirect("/login");
  return client;
}

export { BASE_URL as WAYSAFE_API_BASE_URL };
