# @invokable/conformance

Checks that a CLI honours the [invokable](https://github.com/beinvokable/invokable)
agent contract.

```console
$ npx invokable-test node bin/mytool.mjs

  ✓ `--version --json` returns a valid ok envelope
  ✓ `--help --json` returns a command manifest
  ✓ An unknown command exits 2 with an error envelope
  ✓ A bare invocation does not exit 0
  ✓ `doctor --json` reports auth and config state
  ✓ Every exit code is reserved or in 30-99
  ✓ `--json` puts exactly one JSON document on stdout
  ✓ No credential-shaped strings on stdout
  ✓ Errors carry a `remediation`

  9 passed
```

Exit 0 when everything passes, 1 otherwise. It works on **any** CLI, not just one
built with `@invokable/core`: the contract is the product, and the library is one
way of satisfying it.

## What it will not do

**It never runs a command from your manifest.** Only `--help`, `--version`,
`doctor` and deliberately invalid invocations are executed. A runner that
executed every listed command could deploy something or spend the user's money,
and tools where that matters are exactly the ones this suite exists for.

To include a command you know is safe:

```bash
invokable-test node bin/mytool.mjs --safe-command "projects list"
```

**It never reproduces a credential.** The secret-leak check reports the shape and
the prefix — `a token-shaped string: prefix "mtl_", 36 characters` — never the
material, because a report gets pasted into issues and CI logs.

## Options

| Option | Effect |
|---|---|
| `--json` | Emit the report as JSON on stdout instead of text on stderr. |
| `--safe-command <cmd>` | Also run this command. Repeatable. |
| `--timeout <ms>` | Per-invocation timeout. Default 30000. |

## In CI

```yaml
- run: npx invokable-test node bin/mytool.mjs
```

A failing check prints why an agent depends on it and a command to reproduce it.
