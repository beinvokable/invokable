# ADR 0001 — Repository topology: OSS monorepo + separate private cloud

**Status:** accepted · **Date:** 2026-09-04

## Context

The spec (§4) splits the product into four MIT-licensed packages
(`@invokable/core`, `@invokable/skills`, `@invokable/server`, `create-invokable`)
and one commercial hosted service (`auth.invokable.dev`). Two GitHub
repositories already exist: `beinvokable/invokable` (public) and
`beinvokable/cloud` (private).

The question raised was whether to run everything from one place as a monorepo.

## Decision

**The four OSS packages live together in this monorepo. The hosted service stays
in `beinvokable/cloud` and consumes `@invokable/server` as a versioned npm
dependency.**

A single repository spanning both is not available to us: git visibility is a
per-repository property, so a repo cannot be public in one directory and private
in another. "One monorepo for everything" would mean either publishing the
commercial service or closing the source of the SDK. Neither is acceptable under
§4.

Within the OSS side, a monorepo is clearly right:

- The `defineTool` schema is one type that flows `core → skills → server` and
  later into the MCP adapter (§7/P2). Four repos would version that type against
  itself.
- The packages release as a set. A change to the output envelope touches core,
  the generated SKILL.md, and the conformance test in the same commit.
- A contributor gets the whole surface with one clone, and the conformance test
  (§7) can run against every package on every PR.

## Consequences

- `cloud` depends on published `@invokable/server` versions. During Phase 1 that
  means cutting `0.0.x-alpha` releases from CI once the server package exists.
- `cloud` stays empty until the hosted auth milestone (spec §10, week 4). There
  is nothing to build there before `@invokable/server` exists, and creating a
  skeleton now would only rot.
- If `cloud` ever needs to move faster than the npm release cycle, the escape
  hatch is a git dependency pinned to a commit — not vendoring a copy.

## Alternatives rejected

- **Four separate OSS repos.** Real overhead (cross-repo PRs, version matrices)
  for a benefit — independent release cadence — that does not exist at v0.1 with
  zero external users.
- **One repo, made public later.** Publishing history is not reversible; secrets
  and commercial logic committed while private stay in the history forever.
