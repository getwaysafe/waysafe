import "server-only";
import { NextResponse } from "next/server";
import type { LogEntry } from "@/lib/demo/log";
import { buildDemoPolicy } from "@/lib/demo/policy";
import { demoWaysafeClient, callDemoRoute } from "@/lib/demo/waysafe-client";
import { agentSessionKeyAddress } from "@/lib/demo/agent-runtime";
import { polygonScanAddressUrl } from "@/lib/demo/log";
import { DEMO_INSTRUCTION } from "@/lib/demo/constants";

export const runtime = "nodejs";

/**
 * D-42, scene 0: compiles (or falls back to the hand-authored equivalent
 * of) the demo instruction, creates and authenticates a fresh mandate, and
 * (by default) provisions its x402 instrument. Everything here is a real
 * call against the running Waysafe API -- see the imported modules' own
 * doc comments for exactly which parts are real compilation versus
 * infrastructure config (merchant identity) that natural language could
 * never state.
 *
 * D-44: `{ provision_x402: false }` skips the x402 step entirely, mandate
 * and authentication otherwise unchanged. `/film`'s card lane needs its
 * own mandate -- `Instrument.mandateId` is `@unique` (one instrument per
 * mandate, D-32 item 3), so a mandate this route already gave an x402
 * instrument to can never also take a card instrument. `/demo` never
 * passes this (its every call is bodyless, same as before this option
 * existed), so its own behavior is unchanged.
 */
export async function POST(request: Request) {
  const log: LogEntry[] = [];
  let provisionX402 = true;
  try {
    const body = await request.json();
    if (body && typeof body === "object" && (body as { provision_x402?: unknown }).provision_x402 === false) {
      provisionX402 = false;
    }
  } catch {
    // No body, or not JSON -- /demo's own calls are always bodyless; default stands.
  }

  const sessionKey = process.env.WAYSAFE_DEMO_AGENT_SESSION_KEY;
  if (provisionX402 && !sessionKey) {
    return NextResponse.json({ error: "WAYSAFE_DEMO_AGENT_SESSION_KEY is not set" }, { status: 500 });
  }

  try {
    const waysafe = demoWaysafeClient();

    log.push({ kind: "info", label: "principal's instruction", detail: DEMO_INSTRUCTION });

    const { policy, compiledLive, assumptions, summary } = await buildDemoPolicy(waysafe);
    log.push({
      kind: "http",
      label: "POST /v1/mandates/compile",
      detail: compiledLive
        ? `compiled live -- ${summary}${assumptions.length ? `\nassumptions: ${assumptions.join("; ")}` : ""}`
        : "no live/fixture compilation available for this exact sentence -- using the equivalent hand-authored policy (POST /v1/policies/validate's own sanctioned path)",
    });

    const principal = await waysafe.createPrincipal({ display_name: `Demo Principal ${Date.now()}` });
    const agent = await waysafe.createAgent({ name: "demo agent runtime" });
    log.push({ kind: "http", label: "POST /v1/principals, POST /v1/agents", detail: `principal_id=${principal.principal_id} agent_id=${agent.agent_id}` });

    const mandate = await waysafe.createMandate({
      principal_id: principal.principal_id,
      agent_ids: [agent.agent_id],
      policy,
      intent_text: DEMO_INSTRUCTION,
    });
    log.push({
      kind: "http",
      label: "POST /v1/mandates",
      detail: `mandate_id=${mandate.mandate_id} policy_hash=${mandate.policy_hash}`,
    });

    const authResult = await callDemoRoute<{ activated: boolean }>(
      `/v1/demo/mandates/${mandate.mandate_id}/authenticate`,
      {},
    );
    if (authResult.status !== 200) {
      log.push({ kind: "error", label: "mandate authentication failed", detail: JSON.stringify(authResult.body) });
      return NextResponse.json({ error: "authentication_failed", log }, { status: 502 });
    }
    log.push({
      kind: "success",
      label: "principal authenticated the policy (real WebAuthn ceremony, synthetic authenticator)",
      detail: `mandate ${mandate.mandate_id} is now ACTIVE`,
    });

    let instrumentId: string | null = null;
    let safeAddress: string | null = null;
    if (provisionX402) {
      const sessionKeyAddress = agentSessionKeyAddress(sessionKey as `0x${string}`);
      const instrument = await waysafe.provisionX402Instrument({
        mandate_id: mandate.mandate_id,
        session_key_address: sessionKeyAddress,
      });
      instrumentId = instrument.instrument_id;
      safeAddress = instrument.external_ref;
      log.push({
        kind: "http",
        label: "POST /v1/instruments/x402",
        detail: `instrument_id=${instrument.instrument_id} rail=${instrument.rail}`,
        link: { href: polygonScanAddressUrl(instrument.external_ref), text: `Safe ${instrument.external_ref}` },
      });
    } else {
      log.push({
        kind: "info",
        label: "skipping x402 instrument provisioning",
        detail: "this mandate is for a different rail (D-44)",
      });
    }

    return NextResponse.json({
      mandate_id: mandate.mandate_id,
      policy_hash: mandate.policy_hash,
      instrument_id: instrumentId,
      safe_address: safeAddress,
      compiled_live: compiledLive,
      summary,
      log,
    });
  } catch (err) {
    log.push({ kind: "error", label: "mandate setup failed", detail: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: "mandate_setup_failed", log }, { status: 500 });
  }
}
