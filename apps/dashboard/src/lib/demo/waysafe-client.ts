import "server-only";
import { Waysafe } from "@waysafe/sdk";
import { WAYSAFE_API_BASE_URL } from "./constants";

/**
 * D-42: the /demo page's own Waysafe client -- a fixed org credential
 * (`WAYSAFE_DEMO_ORG_API_KEY`, from `npm run demo:seed -w @waysafe/api`),
 * never a user's dashboard session cookie. The demo page is intentionally
 * not behind dashboard login (see proxy.ts's matcher).
 */
export function demoWaysafeClient(): Waysafe {
  const apiKey = process.env.WAYSAFE_DEMO_ORG_API_KEY;
  if (!apiKey) {
    throw new Error(
      "WAYSAFE_DEMO_ORG_API_KEY is not set. Run `npm run demo:seed -w @waysafe/api` and put the " +
        "printed credential in apps/dashboard/.env.local.",
    );
  }
  return new Waysafe({ baseUrl: WAYSAFE_API_BASE_URL, apiKey });
}

/** The two demo/proof-support routes (`apps/api/src/demo/routes.ts`) are
 * deliberately not part of `@waysafe/sdk` -- the SDK is the product's
 * developer contract, and these two exist only behind
 * `WAYSAFE_ENABLE_DEMO_ROUTES=1`. Plain `fetch` with the same Bearer
 * credential is the honest way to call them from here. */
export async function callDemoRoute<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const apiKey = process.env.WAYSAFE_DEMO_ORG_API_KEY;
  if (!apiKey) {
    throw new Error("WAYSAFE_DEMO_ORG_API_KEY is not set. Run `npm run demo:seed -w @waysafe/api`.");
  }
  const response = await fetch(`${WAYSAFE_API_BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => undefined);
  return { status: response.status, body: parsed as T };
}
