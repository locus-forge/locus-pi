## Outcome

<!-- Describe the user-visible or maintainer-visible result. -->

## Scope

- [ ] The branch started from `dev`.
- [ ] The pull request targets `dev`, or this is the release pull request from `dev` to `main`.
- [ ] The change stays inside the approved public package and repository boundary.

## Proof

- [ ] Focused tests cover changed behavior.
- [ ] `npm run check:push` passes locally, or the omitted checks are explained below.
- [ ] Public manuals, extension manifests, and generated catalogs match the change.
- [ ] No credentials, private runtime state, generated research, or absolute workstation paths are included.

## Release-only checks

- [ ] This is a `dev` to `main` pull request.
- [ ] `package.json` contains the intended release version.
- [ ] `CHANGELOG.md` contains the matching release heading.
- [ ] The matching `vX.Y.Z` tag will be created after merge.

## Notes

<!-- Explain skipped checks, residual risks, migration details, or follow-up work. -->
