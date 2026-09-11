import "server-only";
import { NextResponse } from "next/server";
import type { LogEntry } from "@/lib/demo/log";
import { callDemoRoute } from "@/lib/demo/waysafe-client";

export const runtime = "nodejs";

interface BypassBody {
  instrument_id: string;
}

interface BypassProofCase {
  name: string;
  description: string;
  rejected: boolean;
  revert_reason: string | null;
}

/**
 * D-42, scene 3: "the agent's key is stolen. The attacker has no Waysafe
 * SDK." Calls the real on-chain rejection proof (`x402.bypass.test.ts`
 * part 3, exposed over HTTP by `apps/api/src/demo/routes.ts`'s
 * bypass-proof route) -- every case here is a real `eth_call` against the
 * actual deployed Safe, never a client-side guard.
 */
export async function POST(request: Request) {
  const log: LogEntry[] = [];
  let body: BypassBody;
  try {
    body = (await request.json()) as BypassBody;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  log.push({
    kind: "info",
    label: "attacker has the stolen session key -- and nothing else",
    detail: "no Waysafe SDK, no agent API key, no way to ask evaluate() anything",
  });

  const result = await callDemoRoute<{ safe_address: string; cases: BypassProofCase[] } | { error: string; message: string }>(
    "/v1/enforcement/x402/bypass-proof",
    { instrument_id: body.instrument_id },
  );

  if (result.status !== 200 || !("cases" in result.body)) {
    log.push({ kind: "error", label: "bypass proof unavailable", detail: JSON.stringify(result.body) });
    return NextResponse.json({ error: "bypass_proof_unavailable", log }, { status: result.status || 500 });
  }

  for (const c of result.body.cases) {
    log.push({
      kind: c.rejected ? "success" : "error",
      label: `eth_call execTransaction -- ${c.description}`,
      detail: `${c.rejected ? "REJECTED by the Safe contract" : "NOT REJECTED (unexpected)"}${c.revert_reason ? `\n${c.revert_reason}` : ""}`,
    });
  }

  return NextResponse.json({ ...result.body, log });
}
