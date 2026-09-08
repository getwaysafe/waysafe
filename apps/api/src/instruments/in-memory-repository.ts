/** In-process fake `InstrumentRepository`. */

import { ID_PREFIX, InstrumentStatus, generateId, type Instrument } from "@waysafe/core";
import type { InstrumentRepository, NewInstrument } from "./types.js";

export class InMemoryInstrumentRepository implements InstrumentRepository {
  private readonly byId = new Map<string, Instrument>();

  async createInstrument(input: NewInstrument, now: Date): Promise<Instrument> {
    const id = generateId(ID_PREFIX.instrument);
    const record: Instrument = {
      id,
      organization_id: input.organizationId,
      mandate_id: input.mandateId,
      rail: input.rail,
      external_ref: input.externalRef,
      status: InstrumentStatus.ACTIVE,
      created_at: now,
    };

    this.byId.set(id, record);
    return record;
  }

  async getInstrument(id: string): Promise<Instrument | null> {
    return this.byId.get(id) ?? null;
  }
}
