"use server";

import { revalidatePath } from "next/cache";
import { requireSessionClient } from "../../../../lib/agentpay";

/**
 * The dashboard's step-up approval UI (Week 6): this is the human-in-the-loop
 * half of the flow the SDK has been able to drive since Week 5
 * (`approveStepUp`/`declineStepUp`) but our own dashboard couldn't. Same two
 * calls a developer's own approval UI would make (I-10) -- nothing here is
 * special-cased for being first-party.
 */
export async function approveStepUp(authorizationId: string): Promise<void> {
  const agentpay = await requireSessionClient();
  await agentpay.approveStepUp(authorizationId);
  revalidatePath(`/authorizations/${authorizationId}`);
}

export async function declineStepUp(authorizationId: string): Promise<void> {
  const agentpay = await requireSessionClient();
  await agentpay.declineStepUp(authorizationId);
  revalidatePath(`/authorizations/${authorizationId}`);
}
