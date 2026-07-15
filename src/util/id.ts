let counter = 0;

/**
 * Deterministic, monotonic id generator.
 *
 * We intentionally avoid `crypto.randomUUID()` so that simulations and tests
 * are fully reproducible. Ids are unique within a single process run.
 */
export function nextId(prefix = "id"): string {
  counter += 1;
  return `${prefix}_${counter.toString(36).padStart(6, "0")}`;
}

/** Reset the internal counter. Only intended for tests. */
export function __resetIdCounterForTests(): void {
  counter = 0;
}
