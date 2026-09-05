# Credits, quotas and metering

How to put a price on an agent-driven operation, show it to a person before it
happens, and charge the right amount afterwards.

Everything here is runnable: `examples/server/` implements it, and
`node examples/server/demo.mjs` drives it end to end. Steps 8–11 of that demo
are this document.

---

## The SDK has no opinion about money

It is worth being blunt about this, because the panel showing "Cost: 17 credits"
looks like a billing feature and is not one. `@invokable/core` does exactly two
things with a price:

1. **Renders it** in the approval panel. `Balance after` is a subtraction, not a
   query.
2. **Compares it to `--max-spend`.** If an agent runs `--yes --max-spend 10` and
   your server quoted 17, the auto-approval does not apply and the gate falls
   back to asking a human.

That second one is the point of the whole apparatus. It is the ceiling that stops
an agent spending more than it was allowed to. Everything else — what a credit is
worth, what the balance is, what to charge — comes from your server, and the SDK
takes it on trust.

So the question this document answers is not "how do I use the SDK's billing" but
"what does my server have to get right for the number in that panel to mean
something".

---

## You already have a ledger

Nearly everyone arriving here has credits somewhere already: Stripe metering, a
`balances` table, a quota service, seats in a plan. **Do not build a second
one.** The job is to expose the one you have at three moments.

`examples/server/ledger.mjs` is a stand-in for yours. It exists to show which of
its guarantees the flow actually leans on, and there are only three:

| Guarantee | Why the flow needs it |
| --- | --- |
| **Holds** | The balance shown at approval must still be there when the work runs. |
| **Idempotency** | A retried request must not charge twice. |
| **History** | "Why was I charged 11?" has to have an answer. |

If your ledger already does those three things, wiring it up is an afternoon.

---

## The three moments

```
  ┌──────────┐        ┌────────────┐        ┌──────────┐
  │  QUOTE   │───────▶│  APPROVE   │───────▶│ CAPTURE  │
  └──────────┘        └────────────┘        └──────────┘
   estimate +          human sees            do the work,
   hold credits        the number            charge actual,
                       and consents          release the hold

   your API            checkpoint()          your API
   (unguarded)         (SDK)                 (guarded)
```

**Quote** is unguarded on purpose. It changes nothing and produces the summary
the person is about to be shown — gate it and the CLI could never obtain a plan
to display in the first place.

**Capture** is guarded. `verifyCheckpoint` burns the approval, so one consent
buys exactly one operation.

---

## Fixed prices: the easy case

When the cost is known before the work, there is nothing to reconcile. Quote it,
gate it, charge it. `/v1/deploy` in the example server is four lines and needs no
further thought.

Most real products are not this.

---

## Dynamic prices: the case people actually have

An AI call costs what it costs. Input tokens are countable up front; output
tokens are not knowable until the model has finished writing. So the number the
user approves and the number you charge are *different numbers*, and the whole
design question is how to be honest about that.

### Quote a ceiling, not a guess

```js
// examples/server/pricing.mjs
export function estimate({ model, inputTokens, maxOutputTokens }) {
  const usd = usdForUsage(model, {
    input_tokens: inputTokens,
    output_tokens: maxOutputTokens,   // ← the cap you will actually enforce
  });
  return { credits: creditsForUsd(usd), model, inputTokens, maxOutputTokens };
}
```

Estimate against `max_tokens` — the ceiling you enforce on the request anyway —
rather than against a predicted output length. Then say so in the approval text:

```js
explain: `At most ${plan.credits} credits — you are charged for the output actually produced.`
```

A person who approves 17 and is charged 11 reads the difference as a refund. The
reverse is a support ticket. This asymmetry is the entire argument for quoting
high.

Measured, from the demo:

```
 Cost: 17 credits                  ← quoted, ceiling of 8000 output tokens
 Balance after: 83 credits
```
```json
{"estimated":17,"charged":11,"note":"Quoted 17 (ceiling of 8000 output tokens); used 3354."}
```

### Count input tokens properly

`text.length / 4` is fine for an example and wrong for a bill. Tokenizers differ
per model, and a counter that is 30% low produces quotes that are 30% low. Use
the provider's own counter — Anthropic exposes `POST /v1/messages/count_tokens`
for exactly this.

### Price cache reads correctly, or overcharge your best users

The formula everyone writes first is `(input_tokens + output_tokens) × rate`.
It is wrong, and it is wrong in the worst possible direction:

```js
// examples/server/pricing.mjs — usdForUsage()
usage.input_tokens              * perToken(rate.input) +
cacheRead                       * perToken(rate.input) * 0.1  +   // ~10%
cacheWrite                      * perToken(rate.input) * 1.25 +   // ~125%
usage.output_tokens             * perToken(rate.output)
```

Cached input is billed at roughly a tenth of the input rate. A request that reads
100k cached tokens costs about a tenth of what the naive formula computes — so
the users you overcharge most are the ones with the largest, most cache-friendly
workloads. That is to say: your heaviest customers.

The fields are on `response.usage`: `input_tokens`, `output_tokens`,
`cache_read_input_tokens`, `cache_creation_input_tokens`.

### Rates belong in configuration

Published prices move. Read them from config so repricing is a data change, and
so a historical charge can be recomputed against the rates that were in effect
when it was made. A rate constant compiled into your source makes both of those
impossible.

---

## Overruns: pick a policy before you need one

The charge came in *above* what the user approved. You have three honest
options, and exactly one dishonest one.

| Policy | Behaviour | Use when |
| --- | --- | --- |
| **Cap** | Charge the approved number; absorb the difference. | The overrun is bounded and small. The example does this. |
| **Fail** | Refuse the operation, charge nothing. | The work is cheap to redo. |
| **Truncate** | Stop the work at the ceiling and return partial output. | The work streams and partial output is useful. |

```js
// Cap, in examples/server/server.mjs
const capped = Math.min(charge.credits, plan.credits);
```

The dishonest option is charging more than was approved and not mentioning it.
The person consented to a specific number; that consent does not extend to a
larger one, and the approval panel is the record of what they agreed to.

The best defence is not needing the policy: **enforce the same ceiling you
quoted.** If you told the user 8000 output tokens, pass `max_tokens: 8000`.
Then the quote is a real bound rather than an aspiration.

---

## Idempotency: the fingerprint is your key

An agent retries. A network drops a response that had already been processed.
Without a key, a retry charges twice.

The checkpoint fingerprint is the natural one: it names exactly one approved
operation, it is unguessable, and it is already on the request.

```js
// examples/server/server.mjs
function approvalFingerprint(request) {
  const header = request.headers.get('x-invokable-checkpoint') ?? '';
  return header.split('@')[1] ?? null;
}

const txn = ledger.capture(holdId, {
  credits: capped,
  idempotencyKey: approvalFingerprint(request),
  detail: { model: plan.model, usage },
});
```

`ledger.capture` returns the original transaction with `replayed: true` rather
than charging again. Note that this is a *different* protection from
`verifyCheckpoint` consuming the approval — that one stops a second *operation*;
this one stops a second *charge* for the same operation.

---

## Quoting must be idempotent too

This one is not obvious, and it will bite you.

The approved run is a **fresh process**. It calls your quote endpoint again
before presenting its approval, because that is where it gets the plan to act
on. If a second quote mints a second plan id, the approval — bound to the first —
is refused:

```
That approval was issued for a different target.
(issued for subject "plan_a1b2", presented for "plan_c3d4" — the `subject` passed
to checkpoint() must equal what `subjectFor` returns in verifyCheckpoint())
```

and the command can never succeed. Key the quote by its content:

```js
const id = 'plan_' + createHash('sha256')
  .update(JSON.stringify([subject, model, maxOutputTokens, text]))
  .digest('hex').slice(0, 16);

const existing = plans.get(id);
if (existing) return json(existing.plan);   // same request, same quote, one hold
```

No state to expire, and a client that retries a quote whose response it never
saw does not strand a hold.

---

## Holds, and the number you show

Show **available** (balance minus open holds), not raw balance. Otherwise two
plans quoted against the same balance both look affordable, and the second one
fails *after* someone approved it.

One subtlety worth stating because it is easy to get backwards: pass
`checkpoint()` the figure from **before** this quote's own hold.

```js
const availableBefore = ledger.available(subject);   // read first
const hold = ledger.hold(subject, quote.credits);    // then hold
```

The panel renders `Balance after` by subtracting the estimate from
`spend.balance`. Hand it a figure that already has this hold deducted and the
cost is shown twice — 100 becomes "Balance after: 66" instead of 83.

---

## Refuse before you ask, not after

If the account cannot cover the estimate, do not raise a checkpoint. Asking
someone to approve an operation you already know you will reject wastes their
attention and teaches an agent that approval is meaningless.

```js
if (!hold) {
  return json({
    error: 'insufficient_spend',
    code: 'insufficient_spend',
    message: `This needs ${quote.credits} credits; ${availableBefore} available.`,
    remediation: 'Top up at https://example.com/billing, then re-run.',
  }, 402);
}
```

A 402 becomes exit **4** (`insufficient_spend`) in the CLI, which is documented
as *do not retry*. An agent that reads exit codes stops instead of looping. Put
the top-up URL in `remediation` — it is the one thing that resolves the failure,
and the agent will relay it.

---

## Give the agent a way to look before it leaps

Add a read-only, free command:

```js
balance: command({
  description: 'How many credits are available, and what the last charges were.',
  run: ({ client }) => client.get('/v1/balance'),
}),
```

```console
$ demo-tool balance --json
{"status":"ok","data":{"balance":89,"held":0,"available":89,"history":[
  {"id":"txn_2","estimated":17,"charged":11,"balanceAfter":89,
   "detail":{"model":"claude-sonnet-5","usage":{"input_tokens":20000,"output_tokens":3354}}}
]}}
```

This does two jobs. Before the work, an agent can decline to plan something the
account cannot pay for. After the work, `estimated` next to `charged` next to the
usage that produced it turns "why was I charged 11?" into a non-question — and
it is the same data your support team would otherwise be asked for by email.

---

## Checklist

- [ ] Quote and capture go through **one** pricing function.
- [ ] The estimate is a **ceiling**, and the approval text says "at most".
- [ ] Input tokens counted with the provider's counter, not a character heuristic.
- [ ] Cache-read and cache-write tokens priced at their own rates.
- [ ] Rates in configuration, not source.
- [ ] The ceiling you quoted is the ceiling you **enforce** (`max_tokens`).
- [ ] An overrun policy chosen: cap, fail, or truncate.
- [ ] Capture keyed by the checkpoint fingerprint.
- [ ] The quote endpoint is idempotent by request content.
- [ ] Plans hold credits; the panel shows **available before this hold**.
- [ ] Insufficient balance returns 402 → exit 4, with a top-up URL.
- [ ] A free, read-only `balance` command exists.

---

## See also

- `examples/server/pricing.mjs` — usage → USD → credits
- `examples/server/ledger.mjs` — holds, idempotent capture, history
- `examples/server/server.mjs` — the three moments wired together
- [`docs/mcp.md`](./mcp.md) — exposing the same operations, and their costs, over MCP
