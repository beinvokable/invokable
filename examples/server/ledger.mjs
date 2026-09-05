/**
 * A credit ledger, in memory, with the properties a real one needs.
 *
 * You almost certainly already have one of these — Stripe metering, an internal
 * balances table, a quota service. This file is not a suggestion to build
 * another; it exists so the example can show *where* your existing ledger
 * plugs into an invokable flow, and which of its guarantees the flow depends
 * on. There are three:
 *
 *   1. A hold, so the balance a user was shown when they approved cannot be
 *      spent by something else between the approval and the work.
 *   2. Idempotency, so the same authorised operation cannot be charged twice
 *      when a client retries a request whose response it never saw.
 *   3. An append-only history, so "why was I charged 37 credits" has an answer.
 *
 * Everything is per-subject. `subject` is the same identity the auth server put
 * in the token and the same one `subjectFor` returns to the checkpoint verifier.
 */

/** @typedef {{ id: string, subject: string, credits: number, state: 'held'|'captured'|'released' }} Hold */

export function memoryLedger({ startingBalance = 100 } = {}) {
  /** @type {Map<string, number>} */
  const balances = new Map();
  /** @type {Map<string, Hold>} */
  const holds = new Map();
  /** @type {Map<string, object>} */
  const byIdempotencyKey = new Map();
  /** @type {object[]} */
  const entries = [];

  let seq = 0;

  const balanceOf = (subject) =>
    balances.has(subject) ? balances.get(subject) : startingBalance;

  /** Credits promised to holds that have not yet been captured or released. */
  function heldFor(subject) {
    let total = 0;
    for (const hold of holds.values()) {
      if (hold.subject === subject && hold.state === 'held') total += hold.credits;
    }
    return total;
  }

  return {
    /**
     * What the user can still commit. This — not the raw balance — is the number
     * to show in a plan, or a user with one approval outstanding can approve a
     * second operation the account cannot afford.
     */
    available(subject) {
      return balanceOf(subject) - heldFor(subject);
    },

    balance(subject) {
      return { balance: balanceOf(subject), held: heldFor(subject), available: this.available(subject) };
    },

    /**
     * Reserve credits at the moment you quote them.
     *
     * Returns null when the account cannot cover the estimate — the caller turns
     * that into exit 4 (`insufficient_spend`) rather than asking for an approval
     * it already knows it cannot honour.
     */
    hold(subject, credits) {
      if (this.available(subject) < credits) return null;
      const id = `hold_${++seq}`;
      holds.set(id, { id, subject, credits, state: 'held' });
      return holds.get(id);
    },

    /**
     * Charge the real amount against a hold, once.
     *
     * `idempotencyKey` is the checkpoint fingerprint: it names one approved
     * operation, it is unguessable, and it is already travelling with the
     * request. A retried call returns the first result rather than charging
     * again — the important half of exactly-once billing, and the half a naive
     * `balance -= credits` gets wrong.
     *
     * `credits` may exceed the held amount: this is the overrun case, and the
     * caller decides what to do about it before calling. See `capAt` in
     * server.mjs.
     */
    capture(holdId, { credits, idempotencyKey, detail }) {
      if (byIdempotencyKey.has(idempotencyKey)) {
        return { ...byIdempotencyKey.get(idempotencyKey), replayed: true };
      }

      const hold = holds.get(holdId);
      if (!hold || hold.state !== 'held') throw new Error(`No open hold ${holdId}`);

      hold.state = 'captured';
      balances.set(hold.subject, balanceOf(hold.subject) - credits);

      const entry = {
        id: `txn_${++seq}`,
        subject: hold.subject,
        estimated: hold.credits,
        charged: credits,
        balanceAfter: balanceOf(hold.subject),
        idempotencyKey,
        detail,
        at: new Date().toISOString(),
      };
      entries.push(entry);
      byIdempotencyKey.set(idempotencyKey, entry);
      return { ...entry, replayed: false };
    },

    /** Give the credits back when the work did not happen. */
    release(holdId) {
      const hold = holds.get(holdId);
      if (hold && hold.state === 'held') hold.state = 'released';
    },

    /** What `usage --json` shows the agent. Append-only, newest last. */
    history(subject) {
      return entries.filter((entry) => entry.subject === subject);
    },
  };
}
