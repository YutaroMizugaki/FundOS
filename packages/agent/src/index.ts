import type {
  AgentAction,
  AgentTickResult,
  FundVault,
  Timestamp,
} from "@fundos/core";

function now(): Timestamp {
  return new Date().toISOString();
}

export interface AutonomousAgentOptions {
  /** When true, approved proposals are executed in the same tick. */
  autoExecute?: boolean;
  /** Optional logger. */
  log?: (message: string) => void;
}

/**
 * Self-driving fund agent.
 * Each tick: rebalance reserves → evaluate pending proposals → approve/reject → optionally execute.
 * Humans set the mandate & policy; the agent continuously enforces them.
 */
export class AutonomousFundAgent {
  private ticks = 0;

  constructor(
    private readonly vault: FundVault,
    private readonly options: AutonomousAgentOptions = {},
  ) {}

  getTickCount(): number {
    return this.ticks;
  }

  /** Plan actions without mutating (dry-run planning for pending proposals). */
  plan(): AgentAction[] {
    const actions: AgentAction[] = [];
    const engine = this.vault.getPolicyEngine();
    const target = engine.targetReserved();
    const reserved = this.vault.getState().reserved;
    if (target !== reserved) {
      actions.push({ type: "rebalance_reserve", targetReserved: target });
    }

    for (const p of this.vault.getProposals()) {
      if (p.status !== "pending") continue;
      const decision = engine.evaluateProposal(p);
      if (decision.approved) {
        actions.push({
          type: "approve_proposal",
          proposalId: p.id,
          reason: "Autonomous policy approval",
        });
        if (this.options.autoExecute !== false) {
          actions.push({ type: "execute_proposal", proposalId: p.id });
        }
      } else {
        actions.push({
          type: "reject_proposal",
          proposalId: p.id,
          reason: decision.reasons.join("; "),
        });
      }
    }

    if (actions.length === 0) {
      actions.push({ type: "noop", reason: "No pending work" });
    }
    return actions;
  }

  /** Execute one autonomous tick. */
  tick(): AgentTickResult {
    this.ticks += 1;
    const at = now();
    const notes: string[] = [];
    const planned = this.plan();
    const actions: AgentAction[] = [];

    // Always rebalance first using live state
    this.vault.rebalanceReserve(`Agent tick #${this.ticks} reserve sync`);
    notes.push(`Tick #${this.ticks}: reserve synchronized`);

    for (const action of planned) {
      if (action.type === "rebalance_reserve") {
        actions.push(action);
        continue;
      }
      if (action.type === "noop") {
        actions.push(action);
        continue;
      }
      if (action.type === "approve_proposal") {
        const result = this.vault.approveProposal(action.proposalId, action.reason);
        actions.push(action);
        notes.push(`Approved ${action.proposalId} → ${result.status}`);
        continue;
      }
      if (action.type === "reject_proposal") {
        this.vault.rejectProposal(action.proposalId, action.reason);
        actions.push(action);
        notes.push(`Rejected ${action.proposalId}: ${action.reason}`);
        continue;
      }
      if (action.type === "execute_proposal") {
        try {
          const executed = this.vault.executeProposal(action.proposalId);
          actions.push(action);
          notes.push(
            `Executed ${action.proposalId} → ${executed.txRef ?? "ok"}`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          notes.push(`Execute failed ${action.proposalId}: ${message}`);
        }
        continue;
      }
      if (action.type === "pause_fund") {
        this.vault.setStatus("paused", action.reason);
        actions.push(action);
        continue;
      }
      if (action.type === "resume_fund") {
        this.vault.setStatus("active", action.reason);
        actions.push(action);
      }
    }

    this.vault.getLedger().append({
      fundId: this.vault.config.id,
      kind: "agent_tick",
      note: `Autonomous agent tick #${this.ticks}`,
      at,
      payload: {
        tick: this.ticks,
        actionTypes: actions.map((a) => a.type),
        notes,
      },
    });

    const result = { at, actions, notes };
    this.options.log?.(
      `[FundOS agent] tick=${this.ticks} actions=${actions.map((a) => a.type).join(",")}`,
    );
    return result;
  }

  /** Run N ticks (or until idle if stopWhenIdle). */
  run(opts: { ticks?: number; stopWhenIdle?: boolean } = {}): AgentTickResult[] {
    const max = opts.ticks ?? 1;
    const results: AgentTickResult[] = [];
    for (let i = 0; i < max; i++) {
      const result = this.tick();
      results.push(result);
      const idle = result.actions.every(
        (a) => a.type === "noop" || a.type === "rebalance_reserve",
      );
      if (opts.stopWhenIdle && idle) break;
    }
    return results;
  }
}
