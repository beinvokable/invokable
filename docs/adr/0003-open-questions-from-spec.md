# ADR 0003 — Open questions the spec leaves unresolved

**Status:** items 1 and 3 **decided 2026-09-04**; items 2 and 4 are standing
notes · **Date:** 2026-09-04

Implementing §5.1–§5.8 surfaced four issues that are not settled by the document.
None of them block the runtime layer already built; all of them block
`checkpoint()`.

## 1. Where is the checkpoint secret? — DECIDED: developer's API

**Decision: hosted is auth-only in Phase 1.** Checkpoint fingerprints are issued
and verified by the tool developer's own API, using `@invokable/server` with the
secret in their environment. The hosted service provides identity — device flow,
token store, revoke — and nothing else.

Implemented as `CheckpointVerifier` + `checkpointRoutes()` + `verifyCheckpoint()`
in `@invokable/server`. A tool developer mounts all three in their own app; the
secret never leaves their infrastructure.

This keeps the hosted product the size it was pitched at. Hosted checkpoints
would mean either a network hop to a third party inside every verification, or
proxying the developer's API outright — a materially larger service than "Clerk
for agent tools", and a Phase 2 decision if it happens at all.

The original problem, retained for context:

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

**This is stated in the README and in the `@invokable/server` README.** The
security boundary in Phase 1 is the human at the terminal plus the server-side
audit trail — not containment of a hostile agent. Claiming otherwise invites a
category of trust the design does not support.

What is implemented and does hold: an approval is bound to (gate, subject,
summary), expires, and is consumed exactly once by the action it authorises —
so a stale or replayed approval is detected. `--max-spend` overrides `--yes`,
and `requireSpendLimit` lets a tool refuse `--yes` without a cap.

## 3. `status: "ok"` with exit 10 — DECIDED: a third status

**Decision: `status: "checkpoint"` is a third top-level envelope value**, added
before any adoption could make it expensive. `status` and the exit code now
agree: a pending gate is `status: "checkpoint"` with exit 10, and no agent can
read it as success by looking at only one of the two.

The payload is flat, matching `ErrorEnvelope`, rather than nested under `data`.

This is a deliberate deviation from spec 5.2, which described the pending
checkpoint as `status: "ok"`. The original problem, retained for context:

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
