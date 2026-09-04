# Releasing

All five packages share one version and are published together.

## One-time setup

1. **npm organisation.** The `@invokable` scope must exist on npm and your user
   must be able to publish to it.
2. **Token.** On npmjs.com create an **Automation** token (or a Granular token
   limited to publishing the `@invokable` scope). Automation tokens bypass 2FA
   prompts, which a CI run cannot answer.
3. **GitHub secret.** In `beinvokable/invokable` → Settings → Secrets and
   variables → Actions, add it as `NPM_TOKEN`. If you add it at the
   organisation level, scope it to **Selected repositories → invokable**: a
   publish token should not be readable by every repository in the org.

The token value never appears in the workflow file or in a command line.
`actions/setup-node` writes an `.npmrc` that reads it from `NODE_AUTH_TOKEN` at
publish time.

## Cutting a release

```bash
pnpm version:set 0.1.0     # every package, plus the root
pnpm install               # refresh the lockfile
pnpm build && pnpm test

git commit -am "Release 0.1.0"
git tag v0.1.0
git push --follow-tags
```

Pushing the tag runs `.github/workflows/release.yml`, which:

1. Checks the tag matches the version in `packages/core/package.json`.
2. Checks every package carries the same version.
3. Builds, runs the tests, and runs the conformance suite on the example tool.
4. Packs every package and **fails if any tarball still contains a
   `workspace:` range**.
5. Publishes with `pnpm publish -r --access public --provenance`.

## Why `pnpm publish`, never `npm publish`

Internal dependencies are declared as `workspace:^`. `pnpm` rewrites that to a
real range (`^0.1.0`) when it packs. `npm publish` does not: it would upload the
literal string `workspace:^`, and **every install of the published package would
fail**. Step 4 above exists to catch this if the command is ever changed.

## Dry run

Run the workflow manually from the Actions tab with **dry_run** left on. It does
everything except the publish step, so you can confirm the pipeline before
spending a version number. Locally:

```bash
pnpm -r --filter './packages/*' exec pnpm pack --pack-destination /tmp/tarballs
tar -xzOf /tmp/tarballs/invokable-skills-*.tgz package/package.json
```

## Pre-releases

```bash
pnpm version:set 0.2.0-alpha.1
```

npm treats a version with a hyphen as a pre-release: it is not installed by
`^0.1.0` and does not become `latest`. Useful for letting `cloud` consume
`@invokable/server` before a stable cut.

## After publishing

Check the packages resolve for a real consumer:

```bash
mkdir /tmp/check && cd /tmp/check && npm init -y
npm install @invokable/core @invokable/skills
npx create-invokable my-tool --yes
```
