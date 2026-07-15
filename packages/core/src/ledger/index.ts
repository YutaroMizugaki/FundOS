import { randomUUID } from "node:crypto";
import type { LedgerEntry, LedgerKind, Timestamp } from "../types/index.js";

function now(): Timestamp {
  return new Date().toISOString();
}

export interface AppendLedgerInput {
  fundId: string;
  kind: LedgerKind;
  note: string;
  amount?: bigint;
  counterparty?: string;
  proposalId?: string;
  payload?: Record<string, unknown>;
  at?: Timestamp;
}

/**
 * Append-only audit ledger for programmable fund operations.
 * All autonomous decisions and capital movements are recorded here.
 */
export class FundLedger {
  private readonly entries: LedgerEntry[] = [];

  constructor(initial: LedgerEntry[] = []) {
    this.entries.push(...initial);
  }

  append(input: AppendLedgerInput): LedgerEntry {
    const entry: LedgerEntry = {
      id: randomUUID(),
      fundId: input.fundId,
      kind: input.kind,
      amount: input.amount,
      counterparty: input.counterparty,
      proposalId: input.proposalId,
      note: input.note,
      at: input.at ?? now(),
      payload: input.payload,
    };
    this.entries.push(entry);
    return entry;
  }

  list(): readonly LedgerEntry[] {
    return this.entries;
  }

  byKind(kind: LedgerKind): LedgerEntry[] {
    return this.entries.filter((e) => e.kind === kind);
  }

  serialize(): LedgerEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }
}

/** JSON-safe ledger serialization (bigint → string). */
export function serializeLedgerForJson(entries: readonly LedgerEntry[]) {
  return entries.map((e) => ({
    ...e,
    amount: e.amount === undefined ? undefined : e.amount.toString(),
  }));
}
