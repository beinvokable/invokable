# create-invokable

Scaffolds an agent-native CLI.

```console
$ npx create-invokable my-deployer
? Auth server?
  1) hosted  (default)
  2) self-host
? First command? (deploy)
? Does it spend money or need approval? [Y/n]

Created ./my-deployer
```

Non-interactive:

```bash
npx create-invokable my-deployer --yes --command deploy --spends --auth self-host
```

## What you get

```
my-deployer/
├── package.json          bin wired, build and test scripts
├── tsconfig.json
├── src/tool.ts           defineTool with your first command
├── bin/my-deployer.mjs   the entry point, executable
├── README.md
└── .github/workflows/ci.yml
```

`login`, `logout`, `whoami` and `doctor` are built in and need no code. `init`
generates agent instructions. If the first command spends money it comes with an
approval gate already wired, and `requireSpendLimit` set so `--yes` is refused
without a `--max-spend` cap.

The generated CI runs both contract checks:

```yaml
- run: npx invokable-test node bin/my-deployer.mjs   # the contract holds
- run: node bin/my-deployer.mjs init --check         # instructions are current
```

## Options

| Option | Effect |
|---|---|
| `--command <name>` | First command. Default `deploy`. |
| `--spends` / `--no-spends` | Whether it needs an approval gate. |
| `--auth <hosted\|self-host>` | Where `login` points. Default `hosted`. |
| `-y`, `--yes` | Accept every default; never prompt. |

The name must be lowercase letters, digits and hyphens: it becomes both the
binary name and the generated skill name, and the Agent Skills spec constrains
the latter.
