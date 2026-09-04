# ADR 0003 — Open questions the spec leaves unresolved

**Status:** proposed — needs a product/engineering decision before the
checkpoint milestone · **Date:** 2026-09-04

Implementing §5.1–§5.8 surfaced four issues that are not settled by the document.
None of them block the runtime layer already built; all of them block
`checkpoint()`.

## 1. Where is the checkpoint secret? (blocking)

§5.8 has the client `POST /checkpoints` to obtain an HMAC fingerprint, and §5.5
mounts `verifyCheckpoint({ secret })` as middleware on the *tool developer's*
Express app. Issuer and verifier must share the secret, so they must be in the
same trust domain.

But §5.8 also says "self-host supplies `secret` in env; **hosted holds it
per-tool**". If the hosted service holds the secret, the developer's own API
cannot verify the fingerprint — it does not have the key. The hosted product as
described is auth-only (§9 leans "auth only in Phase 1"), which leaves nobody
able to run step 2 of the verification.

**Proposed resolution for Phase 1:** issuing and verification both happen in the
developer's API via `@invokable/server`, with the secret in their env. Hosted
provides identity (device flow, token store, revoke) and nothing else. A hosted
checkpoint service is a Phase 2 decision, and it implies proxying or co-signing,
which is a much larger product than "Clerk for agent tools".

## 2. The fingerprint does not defend against the agent

§5.8 justifies HMAC over sha256 because "anyone who saw the summary — including
the agent — can compute the fp and forge `--approve`."

That is true, but the agent does not need to forge anything: it can pass `--yes`,
which §5.1(3) accepts. The `Never use --yes` line in the generated SKILL.md
(§5.6) is an instruction, not an enforcement boundary — a model that ignores it
faces no mechanism.

What the server-issued HMAC *does* buy is real and worth keeping: **freshness**
(an approval cannot outlive the state it described) and **one-shot use** (an
approval cannot be replayed). Both are properties the sha256 approach lacks.

**This should be stated honestly in the README.** The security boundary in Phase
1 is the human at the terminal plus the server-side audit trail — not containment
of a hostile agent. Claiming otherwise invites a category of trust the design
does not support. `requireSpendLimit` (implemented) lets a tool force
`--max-spend` alongside `--yes`, which is the closest thing to an actual cap.

## 3. `status: "ok"` with exit 10 is incoherent for a pending checkpoint

§5.2 shows a pending checkpoint as `{"status":"ok","data":{"kind":"checkpoint"…}}`
while the process exits 10. An agent keying on `status` sees success; an agent
keying on the exit code sees a non-zero result. Harnesses commonly treat any
non-zero exit as failure and may retry or abort — turning an approval prompt into
a spurious error.

Implemented as specified, because it is the written contract. `status` is
documented in code as describing envelope well-formedness only, with the exit
code authoritative for "did the command complete". If we are willing to change
the contract, `status: "checkpoint"` as a third top-level value removes the
ambiguity entirely, and it is far cheaper to change now than after adoption.

## 4. npm names

`@invokable/core`, `@invokable/server`, `@invokable/skills` and
`create-invokable` are all unregistered and available. The unscoped name
`invokable` is **taken** (v1.0.3 by an unrelated package). Nothing in the spec
depends on the unscoped name, but it rules out `npx invokable …` as a future
entry point — `npx create-invokable` and `npx invokable-test` (§7) are unaffected.
