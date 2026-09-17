import "server-only";
import { NextResponse } from "next/server";
import type { LogEntry } from "@/lib/demo/log";
import { callDemoRoute } from "@/lib/demo/waysafe-client";

export const runtime = "nodejs";

interface CardBody {
  mandate_id: string;
  /** D-52: "proof" selects /proof's own ALLOW + isolated-DENY scenario
   * set (`PROOF_CARD_REPLAY_SCENARIOS`, apps/api/src/demo/routes.ts);
   * omitted (or "film") keeps /film's own two scenarios unchanged. */
  variant?: "film" | "proof";
}

interface CardAttempt {
  label: string;
  amount_cents: number;
  approved: boolean;
  reason_codes: string[];
  authorization_id: string | null;
}

interface CardReplayResponse {
  instrument_id: string;
  mandate_version_id: string;
  policy_hash: string;
  attempts: CardAttempt[];
}

/**
 * D-44: `/film`'s Act 2 card lane. Proxies to the real, non-SDK demo route
 * (`apps/api/src/demo/routes.ts`'s `POST /v1/demo/enforcement/stripe-issuing`)
 * the same way `/api/demo/bypass` proxies its own bypass-proof route --
 * this is a replay of the real Stripe Issuing adapter against hand-authored
 * payloads, not a live Stripe call (this environment's Issuing financial
 * account is still `status: "pending"`, D-37). Every result here must be
 * labeled "replayed Stripe authorization request -- live sandbox pending
 * (D-37)" wherever it's shown.
 */
export async function POST(request: Request) {
  const log: LogEntry[] = [];
  let body: CardBody;
  try {
    body = (await request.json()) as CardBody;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  log.push({
    kind: "info",
    label: "replayed Stripe authorization request -- live sandbox pending (D-37)",
    detail: "hand-authored issuing_authorization.request payloads, run through the real adapter and evaluate()",
  });

  const result = await callDemoRoute<CardReplayResponse | { error: string }>(
    "/v1/demo/enforcement/stripe-issuing",
    { mandate_id: body.mandate_id, variant: body.variant ?? "film" },
  );

  if (result.status !== 200 || !("attempts" in result.body)) {
    log.push({ kind: "error", label: "card replay unavailable", detail: JSON.stringify(result.body) });
    return NextResponse.json({ error: "card_replay_unavailable", log }, { status: result.status || 500 });
  }

  for (const a of result.body.attempts) {
    log.push({
      kind: a.approved ? "success" : "warn",
      label: `POST /v1/demo/enforcement/stripe-issuing -- ${a.label}`,
      detail: `${a.approved ? "ALLOW" : "DENY"}: ${a.reason_codes.join(", ") || "(no reason codes)"}`,
    });
  }

  return NextResponse.json({ ...result.body, log });
}
