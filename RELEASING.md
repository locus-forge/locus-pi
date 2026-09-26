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

After `npm ci --ignore-scripts`, the same candidate check can run locally.
Install the pinned CLI before loading any release credential, and put it on
`PATH` so the pack script uses the same npm version as CI:

```bash
release_tools_dir=$(mktemp -d)
NPM_CONFIG_USERCONFIG=/dev/null npm install --prefix "$release_tools_dir" \
  --ignore-scripts --no-audit --no-fund npm@11.19.1
export PATH="$release_tools_dir/node_modules/.bin:$PATH"
test "$(npm --version)" = "11.19.1"
candidate_dir=$(mktemp -d)
node scripts/release-candidate.mjs pack "$candidate_dir"
node scripts/release-consumer-smoke.mjs "$candidate_dir"
```

The manual `stage.yml` workflow reuses the canonical `ci.yml`. After all CI
checks pass, it downloads the `npm-candidate-<commit SHA>` artifact from that
same run, verifies its digests again, and submits that exact `.tgz` with
`npm stage publish --ignore-scripts --access public --tag latest`. The staging
job does not repack the source.

## Find the existing authorization

Read the operator's workstation publication runbook before requesting a new
token. It owns credential locations and the temporary npm configuration used
to load them. Keep those paths and values out of this public repository.

`npm whoami` uses the current npm configuration. A `401` there only rejects
that configuration; repeat the authenticated read with the dedicated release
configuration before declaring credentials unavailable. Likewise, an absent
GitHub `NPM_TOKEN` secret blocks the CI submission route, not local staging.
Never print tokens, dump credential files or load them into shell startup files.

## Stage a checked candidate locally

An authorized operator can submit the checked `main` release tarball using an
existing local credential without copying it to GitHub. Use the pinned npm CLI
and the workstation runbook's temporary `NPM_CONFIG_USERCONFIG` and scoped token
environment for the npm commands below. Package builds and consumer checks run
before loading that credential.

First inspect the current public version and existing stages:

```bash
: "${NPM_CONFIG_USERCONFIG:?Load the dedicated release configuration first}"
npm whoami
npm view @locus-forge/locus-pi version --json
npm stage list @locus-forge/locus-pi --json
```

If the intended version already has a stage, inspect that stage instead of
resubmitting or rejecting it. Otherwise, submit the exact tarball verified
above; do not repack the working directory during staging:

```bash
node scripts/release-candidate.mjs verify "$candidate_dir"
candidate_filename=$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).filename' "$candidate_dir/candidate.json")
npm stage publish "$candidate_dir/$candidate_filename" \
  --ignore-scripts --access public --tag latest --json
```

Record the returned stage ID. Use `npm stage view <stage-id> --json` to verify
the package, version, intended tag and registry status. Download it with
`npm stage download <stage-id>` in a separate directory and compare its SHA-256
with `candidate.json`. A `validating` stage is uploaded but still undergoing
npm checks. Staging never authorizes `npm stage approve` or `npm publish`.

## Stage through GitHub Actions

Restrict the GitHub `npm-staging` environment to `main`. Before adding
`NPM_TOKEN` to that environment, the owner must verify that npm grants it
**Read and write (stage only)** for `@locus-forge/locus-pi`. A general
publish-capable token is not an acceptable substitute. If stage-only
permission is unavailable, leave the environment secret unset and do not
run the CI staging job. An existing local credential can still serve the
authorized local route above; do not upload it to CI without establishing its
stage-only permissions. The secret enters only the `npm stage publish` step. Tool
installation, packing, and consumer checks receive no credential.

The owner manually runs `Stage npm candidate` on `main`, for example:

```bash
gh workflow run stage.yml --repo locus-forge/locus-pi --ref main
```

## Public release after staging

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
