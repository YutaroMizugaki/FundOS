import { type Cancellable, type Clock, SimulationClock } from "../clock.js";
import { PolicyViolation } from "../money/types.js";
import type { Fund } from "./fund.js";

export interface RuleContext {
  readonly fund: Fund;
  readonly now: number;
  readonly engine: AutonomousEngine;
  log(type: string, message: string, data?: Record<string, unknown>): void;
}

/**
 * An autonomous rule inspects the fund and acts on it. Rules are pure policy:
 * they should be idempotent per tick and tolerate being called at any cadence,
 * deriving elapsed time from `ctx.now` rather than assuming a fixed interval.
 */
export interface Rule {
  readonly name: string;
  evaluate(ctx: RuleContext): void;
}

/**
 * The engine is the fund's autopilot. Rules are evaluated in registration order
 * on every tick; a tick can be driven manually or, more usefully, wired to a
 * clock via {@link AutonomousEngine.autopilot} so the fund runs itself.
 *
 * Distributions can be globally paused by a guard rule (circuit breaker); other
 * rules observe {@link AutonomousEngine.distributionsPaused} to cooperate.
 */
export class AutonomousEngine {
  private readonly rules: Rule[] = [];
  private _paused = false;
  private _pauseReason: string | null = null;
  private ticks = 0;

  constructor(
    readonly fund: Fund,
    private readonly clock: Clock,
  ) {}

  get distributionsPaused(): boolean {
    return this._paused;
  }

  get pauseReason(): string | null {
    return this._pauseReason;
  }

  get tickCount(): number {
    return this.ticks;
  }

  register(...rules: Rule[]): this {
    this.rules.push(...rules);
    return this;
  }

  pauseDistributions(reason: string): void {
    if (this._paused && this._pauseReason === reason) return;
    this._paused = true;
    this._pauseReason = reason;
    this.fund.events.emit(this.clock.now(), "engine.paused", `distributions paused: ${reason}`, {
      reason,
    });
  }

  resumeDistributions(reason = "conditions recovered"): void {
    if (!this._paused) return;
    this._paused = false;
    this._pauseReason = null;
    this.fund.events.emit(this.clock.now(), "engine.resumed", `distributions resumed: ${reason}`, {
      reason,
    });
  }

  /** Run one evaluation pass over all rules. */
  tick(): void {
    this.ticks += 1;
    const ctx: RuleContext = {
      fund: this.fund,
      now: this.clock.now(),
      engine: this,
      log: (type, message, data) => this.fund.events.emit(this.clock.now(), type, message, data),
    };
    for (const rule of this.rules) {
      try {
        rule.evaluate(ctx);
      } catch (err) {
        // A single misbehaving rule must never halt the autopilot. Policy
        // violations (e.g. a spending cap) are expected and simply logged.
        const message = err instanceof Error ? err.message : String(err);
        this.fund.events.emit(this.clock.now(), "rule.error", `rule ${rule.name} failed: ${message}`, {
          rule: rule.name,
          error: message,
          kind: err instanceof PolicyViolation ? "policy-violation" : "error",
        });
      }
    }
  }

  /**
   * Wire the engine to a SimulationClock so it ticks automatically every
   * `intervalMs`. This is what makes the fund "self-driving": once armed, no
   * external actor needs to intervene for the fund to operate.
   */
  autopilot(clock: SimulationClock, intervalMs: number): Cancellable {
    return clock.every(intervalMs, () => this.tick());
  }
}
