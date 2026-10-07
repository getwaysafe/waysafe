import { Prisma, PrismaClient } from "@prisma/client";
import type { ProviderEventRepository } from "./types.js";
import { activeTransaction } from "../db/transaction-context.js";

export class PrismaProviderEventRepository implements ProviderEventRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * D-81: joins an already-open transaction when there is one.
   *
   * Recording the event and applying its financial effect have to commit or
   * roll back together. Before D-81 this always wrote on its own connection,
   * so a failed effect left the event marked processed and the retry was
   * classified duplicate -- the second review injected a ledger failure and
   * the budget was never credited. Same mechanism as D-76 used for the
   * evidence repository.
   */
  private get client(): PrismaClient | Prisma.TransactionClient {
    return activeTransaction.getStore() ?? this.prisma;
  }

  async recordIfNew(
    provider: string,
    externalId: string,
    type: string,
    payload: Record<string, unknown>,
    now: Date,
  ): Promise<boolean> {
    try {
      await this.client.providerEvent.create({
        data: {
          id: `${provider}_${externalId}`,
          provider,
          externalId,
          type,
          payload: payload as unknown as Prisma.InputJsonValue,
          processedAt: now,
          createdAt: now,
        },
      });
      return true;
    } catch (err) {
      // The @@unique([provider, externalId]) constraint is the actual
      // idempotency mechanism -- a P2002 here means another request (or a
      // provider retry) already recorded this exact event.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return false;
      }
      throw err;
    }
  }
}
