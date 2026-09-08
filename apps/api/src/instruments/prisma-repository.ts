/**
 * Real `InstrumentRepository`, backed by Postgres via Prisma.
 *
 * No row lock here, same reasoning as `principals/prisma-repository.ts`:
 * nothing about creating or reading an instrument is cumulative or racy.
 */

import { PrismaClient } from "@prisma/client";
import { ID_PREFIX, InstrumentStatus, generateId, type Instrument } from "@waysafe/core";
import type { InstrumentRepository, NewInstrument } from "./types.js";

export class PrismaInstrumentRepository implements InstrumentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createInstrument(input: NewInstrument, now: Date): Promise<Instrument> {
    const id = generateId(ID_PREFIX.instrument);

    const row = await this.prisma.instrument.create({
      data: {
        id,
        organizationId: input.organizationId,
        mandateId: input.mandateId,
        rail: input.rail,
        externalRef: input.externalRef,
        status: "ACTIVE",
        createdAt: now,
      },
    });

    return toInstrument(row);
  }

  async getInstrument(id: string): Promise<Instrument | null> {
    const row = await this.prisma.instrument.findUnique({ where: { id } });
    return row ? toInstrument(row) : null;
  }
}

interface InstrumentRow {
  id: string;
  organizationId: string;
  mandateId: string;
  rail: string;
  externalRef: string;
  status: string;
  createdAt: Date;
}

function toInstrument(row: InstrumentRow): Instrument {
  return {
    id: row.id,
    organization_id: row.organizationId,
    mandate_id: row.mandateId,
    rail: row.rail,
    external_ref: row.externalRef,
    status: row.status as InstrumentStatus,
    created_at: row.createdAt,
  };
}
