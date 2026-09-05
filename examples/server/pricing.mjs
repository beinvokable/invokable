/**
 * Turning real usage into credits.
 *
 * This is the part nobody can write for you, because it encodes a commercial
 * decision: what a unit of your product costs, and what margin you take. What
 * the SDK asks of you is only that the number you show a user before the work
 * and the number you charge after it are produced by the same function — this
 * one — so the two can be compared and reconciled.
 *
 * The example is an AI summarizer, because that is the hard case: the cost is
 * not known until the work is done.
 */

/**
 * USD per million tokens, per model.
 *
 * Rates move. Read them from configuration in a real system rather than a
 * constant in your source, so that repricing is a deploy of data, not code —
 * and so that a charge can be recomputed later against the rates that were in
 * effect when it was made.
 */
const RATES = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/** What one credit is worth to you, in USD, before margin. */
const USD_PER_CREDIT = 0.01;

/** Your markup. 1.0 is at cost. */
const MARGIN = 1.4;

/**
 * The cost of one model call, in USD.
 *
 * The naive formula — `(input + output) * rate` — overcharges anyone whose
 * prompt is cached, often by a lot. Cached input is billed at roughly a tenth
 * of the input rate and writing to the cache at roughly 1.25x, so a request
 * that reads 100k cached tokens costs about a tenth of what a first-pass reader
 * of `usage` would compute. Charge the naive number and your heaviest, most
 * cache-friendly users pay the largest overcharge.
 *
 * @param {string} model
 * @param {{input_tokens: number, output_tokens: number,
 *          cache_read_input_tokens?: number,
 *          cache_creation_input_tokens?: number}} usage
 */
export function usdForUsage(model, usage) {
  const rate = RATES[model];
  if (!rate) throw new Error(`No published rate for model ${model}`);

  const perToken = (usd) => usd / 1_000_000;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;

  return (
    usage.input_tokens * perToken(rate.input) +
    cacheRead * perToken(rate.input) * 0.1 +
    cacheWrite * perToken(rate.input) * 1.25 +
    usage.output_tokens * perToken(rate.output)
  );
}

/**
 * Credits for a USD amount.
 *
 * Rounded up, and never to zero: a call that did real work bills at least one
 * credit. Rounding down instead lets an agent issue an unbounded number of
 * sub-credit requests for free, which is a metering hole rather than a
 * generosity.
 */
export function creditsForUsd(usd) {
  return Math.max(1, Math.ceil((usd * MARGIN) / USD_PER_CREDIT));
}

/**
 * What to show the user *before* the work, when the true cost is unknowable.
 *
 * Output length is the unknown. Guessing it low makes every approval an
 * understatement and every invoice a surprise; the estimate here is
 * deliberately an upper bound, derived from the cap you will actually enforce
 * on the request (`maxOutputTokens`). A user who approves 40 credits and is
 * charged 12 is not upset. The reverse is a support ticket.
 *
 * Return the ceiling alongside the estimate: the caller passes it to
 * `checkpoint()` so the approved number and the enforced number are the same
 * one, and shows it to the user as the worst case.
 */
export function estimate({ model, inputTokens, maxOutputTokens }) {
  const usd = usdForUsage(model, {
    input_tokens: inputTokens,
    output_tokens: maxOutputTokens,
  });
  return { credits: creditsForUsd(usd), model, inputTokens, maxOutputTokens };
}

/** What to charge *after* the work, from the usage the provider reported. */
export function actual({ model, usage }) {
  const usd = usdForUsage(model, usage);
  return { credits: creditsForUsd(usd), usd: Number(usd.toFixed(6)), model, usage };
}
