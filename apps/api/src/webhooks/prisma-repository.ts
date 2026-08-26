import { Prisma, PrismaClient } from "@prisma/client";
import type { ProviderEventRepository } from "./types.js";

export class PrismaProviderEventRepository implements ProviderEventRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async recordIfNew(
    provider: string,
    externalId: string,
    type: string,
    payload: Record<string, unknown>,
    now: Date,
  ): Promise<boolean> {
    try {
      await this.prisma.providerEvent.create({
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
