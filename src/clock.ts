/**
 * The clock and scheduler are what make a FundOS fund *self-driving*.
 *
 * Rather than requiring an operator to press buttons, the fund registers
 * recurring tasks (rebalancing, yield accrual, spending distributions) on a
 * scheduler. Advancing the clock deterministically fires every task that has
 * come due, in chronological order. This makes autonomous behaviour trivially
 * testable and reproducible, and the exact same loop can be driven by real
 * wall-clock time in production (see `RealTimeDriver`).
 */

export const MS_PER_SECOND = 1_000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;
/** Length of a (non-leap) year in ms, used for annualised rate math. */
export const MS_PER_YEAR = 365 * MS_PER_DAY;

export interface Clock {
  /** Current time in milliseconds since the epoch. */
  now(): number;
}

interface ScheduledTask {
  readonly id: number;
  /** Next time this task should fire. */
  next: number;
  /** Repeat interval in ms, or `null` for a one-shot task. */
  readonly intervalMs: number | null;
  readonly run: (now: number) => void;
  cancelled: boolean;
}

export interface Cancellable {
  cancel(): void;
}

/**
 * A deterministic clock + scheduler. Time only moves when you call
 * {@link SimulationClock.advanceTo} / {@link SimulationClock.advance}, at which
 * point all due tasks fire in order. Perfect for simulations and tests.
 */
export class SimulationClock implements Clock {
  private current: number;
  private taskSeq = 0;
  private tasks: ScheduledTask[] = [];

  constructor(startAt = 0) {
    this.current = startAt;
  }

  now(): number {
    return this.current;
  }

  /** Schedule a one-shot task to run at `time` (fires immediately if in past). */
  at(time: number, run: (now: number) => void): Cancellable {
    return this.schedule(time, null, run);
  }

  /**
   * Schedule a recurring task every `intervalMs`, first firing at
   * `firstAt` (defaults to `now + intervalMs`).
   */
  every(intervalMs: number, run: (now: number) => void, firstAt?: number): Cancellable {
    if (intervalMs <= 0) throw new RangeError("intervalMs must be > 0");
    const first = firstAt ?? this.current + intervalMs;
    return this.schedule(first, intervalMs, run);
  }

  private schedule(
    next: number,
    intervalMs: number | null,
    run: (now: number) => void,
  ): Cancellable {
    const task: ScheduledTask = {
      id: this.taskSeq++,
      next,
      intervalMs,
      run,
      cancelled: false,
    };
    this.tasks.push(task);
    return { cancel: () => (task.cancelled = true) };
  }

  /** Advance the clock by `deltaMs`, firing everything that comes due. */
  advance(deltaMs: number): void {
    if (deltaMs < 0) throw new RangeError("cannot advance time backwards");
    this.advanceTo(this.current + deltaMs);
  }

  /** Advance the clock to absolute time `target`, firing everything due. */
  advanceTo(target: number): void {
    if (target < this.current) throw new RangeError("cannot advance time backwards");

    // Fire tasks strictly in chronological order. A task may schedule more
    // work, so we loop until no due task remains at/under `target`.
    for (;;) {
      const due = this.pickNextDue(target);
      if (!due) break;

      this.current = due.next;
      if (due.cancelled) continue;

      due.run(this.current);

      if (due.intervalMs === null) {
        due.cancelled = true;
      } else {
        due.next += due.intervalMs;
      }
    }

    this.current = target;
    this.prune();
  }

  private pickNextDue(target: number): ScheduledTask | undefined {
    let best: ScheduledTask | undefined;
    for (const t of this.tasks) {
      if (t.cancelled || t.next > target) continue;
      if (!best || t.next < best.next || (t.next === best.next && t.id < best.id)) {
        best = t;
      }
    }
    return best;
  }

  private prune(): void {
    this.tasks = this.tasks.filter((t) => !t.cancelled);
  }
}
