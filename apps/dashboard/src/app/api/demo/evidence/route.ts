import "server-only";
import { NextResponse } from "next/server";
import { demoWaysafeClient } from "@/lib/demo/waysafe-client";

export const runtime = "nodejs";

/**
 * D-42, scene 4: hands the browser exactly what it needs to verify
 * independently -- the raw evidence events and the published public key --
 * and nothing else. The actual verification (`verifyEvidenceChainInBrowser`)
 * runs client-side, not here; this route is a thin, honest proxy for org
 * credentials that must stay server-side.
 */
export async function GET() {
  try {
    const waysafe = demoWaysafeClient();
    const [events, publicKey, serverVerify] = await Promise.all([
      waysafe.listEvidence(),
      waysafe.getEvidencePublicKey(),
      waysafe.verifyEvidenceChain(),
    ]);
    const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
    return NextResponse.json({ events: sorted, public_key: publicKey.public_key, server_verify: serverVerify });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
