# locus-pi development contract

## Delivery

- `main` is the stable release branch. `dev` is the integration branch.
- Start focused work from current `dev` and open a pull request back into `dev`.
- Squash-merge normal work. Release through a merge-commit pull request from `dev` to `main`, then create the matching `vX.Y.Z` tag.
- Never commit `.locus/`, `.tasks/`, `.pi/`, runtime output, credentials, or workstation-specific state.

## Validation

```bash
npm ci --ignore-scripts
npm run hooks:install
npm run check:push
```

Use Node.js `>=22.19.0`. Pi supports `>=0.83.0`; development and CI use the exact version pinned in the four `@earendil-works/pi-*` development dependencies. Use `npm run sync:pi-host` to update that baseline.

`npm run check` is the canonical deterministic gate. CI runs the same command, then adds the network dependency audit, Pi peer check, and npm pack candidate. `npm run check:push` adds the size ratchet (`check:topology`, needs the local Locus CLI; skipped with a notice when it is absent) and the pack dry run.

## Ownership

- Shared code lives in the named layers under `extensions/_shared/`. Read `scripts/check-extension-layers.ts` before moving it.
- A shared module may not import a feature directory. Cross-feature imports use an explicitly owned facade.
- Versioned `globalThis` registries have one owning module.
- A change that creates a new internal owner (a module extracted out of an existing one) registers it in the same pull request: the ledger entry in `scripts/check-extension-layers.ts` (feature-internal, pure-root, or facade rule that protected the old owner) plus a negative import test. Otherwise the new module is an unguarded side entrance.
- File size is a growth ratchet, not a ceiling: `npm run check:topology` (`locus topology check`, physical lines, warn threshold 500) fails on growth since the base ref. Shrink elsewhere or record a narrow exception in `.locus-topology.toml` with an owner and a revisit trigger. Do not raise an existing exception to fit new code.

## Public package

The public contract is `package.json#pi.extensions`, extension manifests, co-located manuals, packaged workflows, focused tests, and `package.json#files`.

- Do not widen extensions, workflows, dependencies, permissions, or the npm package without matching proof and documentation.
- Cross-cutting guides live in `docs/`. Extension behavior lives in `extensions/<name>/README.md`.
- Git is the public repository inventory. `package.json#files` is the separate npm-package boundary.
- Ordinary task pull requests into `dev` do not require a `CHANGELOG.md` entry.
  Record useful release notes while work accumulates; the `dev` to `main` release
  pull request must update `CHANGELOG.md` with the matching dated release heading.

## npm release

- Follow [RELEASING.md](RELEASING.md) for the owner-controlled release path.
- Before requesting npm credentials, read the operator's publication runbook
  and check its dedicated local npm configuration. A missing GitHub secret or
  an unauthorized default npm session does not rule out an existing local token.
- CI checks a real tarball through a clean external Pi consumer install. Only the
  `main` branch in `locus-forge/locus-pi` may dispatch npm staging. The staging
  workflow reuses CI, downloads its exact candidate, and never approves or
  directly publishes it.
- npm cannot stage a package name that has never been published. The initial
  public bootstrap belongs to the owner; do not add a direct-publish fallback
  to automation.
