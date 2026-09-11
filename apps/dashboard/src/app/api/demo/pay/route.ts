import "server-only";
import { NextResponse } from "next/server";
import type { Address, Hex } from "viem";
import type { LogEntry } from "@/lib/demo/log";
import { polygonScanTxUrl } from "@/lib/demo/log";
import { demoWaysafeClient } from "@/lib/demo/waysafe-client";
import { fetchPaymentRequirement, signSessionTransfer } from "@/lib/demo/agent-runtime";
import { GOODBEANS_RESOURCE_URL, SHINYGADGETS_RESOURCE_URL } from "@/lib/demo/constants";

export const runtime = "nodejs";

interface PayBody {
  scenario: "allowed" | "denied";
  instrument_id: string;
  safe_address: string;
}

/**
 * D-42, scenes 1 and 2: the simulated agent's own attempt to pay. Fetches
 * the 402 itself (so it knows what it's about to try -- this is what a
 * real x402 client does), signs a Safe transfer with its own session key,
 * and asks Waysafe to co-sign. Waysafe never trusts anything sent here
 * about payment requirements -- it independently re-fetches the same URL
 * (D-40) -- so this route's own fetch is for the agent's own use only.
 */
export async function POST(request: Request) {
  const log: LogEntry[] = [];
  const sessionKey = process.env.WAYSAFE_DEMO_AGENT_SESSION_KEY as Hex | undefined;
  const rpcUrl = process.env.POLYGON_AMOY_RPC_URL;
  if (!sessionKey || !rpcUrl) {
    return NextResponse.json({ error: "WAYSAFE_DEMO_AGENT_SESSION_KEY / POLYGON_AMOY_RPC_URL not set" }, { status: 500 });
  }

  let body: PayBody;
  try {
    body = (await request.json()) as PayBody;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const resourceUrl = body.scenario === "allowed" ? GOODBEANS_RESOURCE_URL : SHINYGADGETS_RESOURCE_URL;

  try {
    log.push({ kind: "http", label: `GET ${resourceUrl}`, detail: "the agent's own fetch -- what it thinks it's about to pay" });
    const requirement = await fetchPaymentRequirement(resourceUrl);
    log.push({
      kind: "info",
      label: "402 Payment Required",
      detail: `payTo=${requirement.payTo} amount=${requirement.maxAmountRequired} asset=${requirement.asset} (${requirement.description ?? ""})`,
    });

    const decimals = Number(requirement.extra?.["decimals"] ?? 6);
    const amountAtomic = BigInt(requirement.maxAmountRequired);
    void decimals;

    const sessionSignature = await signSessionTransfer({
      rpcUrl,
      safeAddress: body.safe_address as Address,
      sessionKeyPrivateKey: sessionKey,
      payTo: requirement.payTo as Address,
      amountAtomic,
    });
    log.push({
      kind: "chain",
      label: "agent signs its own Safe transfer (session key -- never sent to Waysafe)",
      detail: `nonce=${sessionSignature.nonce} signer=${sessionSignature.signer}`,
    });

    const waysafe = demoWaysafeClient();
    log.push({ kind: "http", label: "POST /v1/enforcement/x402", detail: JSON.stringify({ instrument_id: body.instrument_id, resource_url: resourceUrl }) });

    const result = await waysafe.enforceX402Payment({
      instrument_id: body.instrument_id,
      resource_url: resourceUrl,
      session_signature: sessionSignature,
    });

    log.push({
      kind: result.decision === "ALLOW" ? "success" : "warn",
      label: `decision: ${result.decision}`,
      detail: result.reason_codes.join(", ") || "(no reason codes)",
    });

    if (result.co_signature) {
      log.push({
        kind: "info",
        label: "Waysafe co-signature (off-chain attestation, D-40)",
        detail: JSON.stringify(result.co_signature),
      });
    }

    if (result.settlement && "tx_hash" in result.settlement) {
      log.push({
        kind: "chain",
        label: "execTransaction (2-of-2, broadcast)",
        detail: result.settlement.tx_hash,
        link: { href: polygonScanTxUrl(result.settlement.tx_hash), text: "view on PolygonScan" },
      });
    } else if (result.settlement && "error" in result.settlement) {
      log.push({ kind: "error", label: "settlement failed", detail: result.settlement.error });
    }

    return NextResponse.json({ ...result, log });
  } catch (err) {
    log.push({ kind: "error", label: "payment attempt failed", detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: "payment_failed", log }, { status: 500 });
  }
}
