/**
 * A lightweight, append-only event log.
 *
 * Every state change in FundOS (mint, transfer, rebalance, distribution,
 * policy rejection, circuit-breaker trip, ...) is recorded as an event. This
 * gives an autonomous fund a full, replayable audit trail — essential when no
 * human is in the loop.
 */

export interface FundEvent {
  readonly at: number;
  readonly type: string;
  readonly message: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export type EventListener = (event: FundEvent) => void;

export class EventLog {
  private readonly events: FundEvent[] = [];
  private readonly listeners = new Set<EventListener>();

  emit(at: number, type: string, message: string, data: Record<string, unknown> = {}): FundEvent {
    const event: FundEvent = { at, type, message, data: Object.freeze({ ...data }) };
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
    return event;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** All events, optionally filtered by type. */
  all(type?: string): readonly FundEvent[] {
    return type ? this.events.filter((e) => e.type === type) : [...this.events];
  }

  get size(): number {
    return this.events.length;
  }
}
