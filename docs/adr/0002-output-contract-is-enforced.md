# ADR 0002 — The output contract is enforced, not documented

**Status:** accepted · **Date:** 2026-09-04

## Context

Spec §5.2 fixes the stdout/stderr split: in `--json` mode stdout carries exactly
one JSON document and every log line goes to stderr. §7 lists a conformance test
that checks "`--json` purity (stdout clear of logs)".

Documenting this is not enough. The failure it guards against is a tool author's
dependency calling `console.log`, which the author never sees and which silently
corrupts the document the agent parses. A rule that is only checked at review
time will be broken by transitive dependencies.

## Decision

`Io.guardStdout()` replaces `process.stdout.write` with a writer that forwards to
stderr for the duration of the command body, restoring it in a `finally`. The
envelope is written through a writer bound *before* the diversion is installed.

Consequences of that ordering are load-bearing and easy to get wrong: binding the
envelope writer lazily makes it resolve to the diverted function and sends the
result to stderr. The binding happens in the `Io` constructor for this reason.

`Io.emit()` throws if called twice. Two JSON documents on stdout is precisely the
corruption this class exists to prevent, and it should fail loudly in the tool
author's tests rather than quietly in an agent's parser.

## Verification

Stdout purity cannot be verified in-process under vitest, which installs its own
`console` interception, so `console.log` never reaches `process.stdout.write`
there. `packages/core/test/stdout-purity.test.ts` therefore spawns a real
subprocess and asserts on its actual file descriptors. That is the only setting
where the guarantee means anything, and it is the same mechanism the shipped
`invokable-test` conformance runner will use.
