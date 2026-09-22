# Releasing the npm package

`main` is the stable branch. Changes enter `dev` through pull requests. A release
enters `main` through a merge-commit pull request from `dev`. Before merging,
update the version in `package.json` and `package-lock.json`, add a matching
dated heading to `CHANGELOG.md`, and wait for CI to pass. After merging, tag
the commit on `main` as `vX.Y.Z`.

## Verified candidate

CI runs `npm run check`, the dependency audit, and the Pi version check. Then
npm CLI 11.19.1 builds a real tarball with `npm pack --ignore-scripts`.
`scripts/release-candidate.mjs` records its package name, version, npm
integrity, and SHA-256 digest in `candidate.json`. The
`scripts/release-consumer-smoke.mjs` script installs that tarball with the
repository's exact Pi development baseline into a clean external project. It
loads all package extensions and bundled skills, Workflows-only without
skills, and Workflows-only with bundled skills through Pi's real resource
loader. The consumer checks use neither the source checkout nor its
`node_modules`.

After `npm ci --ignore-scripts`, the same candidate check can run locally:

```bash
candidate_dir=$(mktemp -d)
node scripts/release-candidate.mjs pack "$candidate_dir"
node scripts/release-consumer-smoke.mjs "$candidate_dir"
```

The manual `stage.yml` workflow reuses the canonical `ci.yml`. After all CI
checks pass, it downloads the `npm-candidate-<commit SHA>` artifact from that
same run, verifies its digests again, and submits that exact `.tgz` with
`npm stage publish --ignore-scripts --access public --tag latest`. The staging
job does not repack the source.

## Staging and owner approval

Restrict the GitHub `npm-staging` environment to `main`. Before adding
`NPM_TOKEN` to that environment, the owner must verify that npm grants it
**Read and write (stage only)** for `@locus-forge/locus-pi`. A general
publish-capable token is not an acceptable substitute. If stage-only
permission is unavailable, leave the environment secret unset and do not
run staging. The secret enters only the `npm stage publish` step. Tool
installation, packing, and consumer checks receive no credential.

The owner manually runs `Stage npm candidate` on `main`, for example:

```bash
gh workflow run stage.yml --repo locus-forge/locus-pi --ref main
```

After staging succeeds, the owner inspects the staged tarball on npm and
personally approves it with 2FA. The workflow contains neither `npm publish`
nor `npm stage approve`. Successful staging does not mean the version is
publicly available. Confirm the published version on npm before announcing
the release.

**First release:** npm cannot stage a package name that has never been
published. If `@locus-forge/locus-pi` is absent from npm, the workflow stops
with an explicit prerequisite error before reading the secret. The owner must
perform the first public bootstrap under npm's rules. Automation has no
direct-publish fallback. Later versions use staging and separate owner
approval.
