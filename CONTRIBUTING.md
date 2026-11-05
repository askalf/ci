# Contributing to askalf/ci

Thanks for your interest in improving **askalf/ci**, the reusable workflows and actions behind the
gate our public repositories' pull requests pass through.

## Ground rules

- Be respectful. This project follows our [Code of Conduct](CODE_OF_CONDUCT.md).
- Found a security issue? **Do not open a public issue**: follow [SECURITY.md](SECURITY.md) to report
  it privately.
- The prompts the review and the fix read are never committed here. A pull request that adds prompt
  text is closed; the tests use the stand-ins in `scripts/redline/test-fixtures/`.

## Development setup

The scripts are plain Node.js modules with no dependencies to install. You need Node.js **22** (the
version CI uses).

```bash
git clone https://github.com/askalf/ci.git
cd ci
node test-all.mjs
```

`test-all.mjs` runs every test the `test` check runs, in the same list as
`.github/workflows/redline-self-test.yml`: the review, post, local, public-text, drift-report,
fleet-status, check, pin-bump and fix tests, and the `tools.json` drift check. Each file also runs
on its own, for example `node scripts/redline/post.test.mjs`.

The model and GitHub are stubbed in every test: no credential, no network. The run-account tests
in `fix.test.mjs` need a second account to `sudo` to and skip where there is none; CI provides one.

## Making a change

1. Branch off `main`.
2. Keep the change focused: one concern per pull request.
3. Add or update tests for any behavior change. A change to what the review or the fix may do, to
   the ref check a called workflow performs, or to what the pin bump rewrites must be covered.
4. A tool added to or changed in `review.mjs` or `fix.mjs` is also a change to `tools.json` or
   `fix-tools.json`: `node scripts/redline/dump-tools.mjs` rewrites them, and `--check` fails CI
   when they drift.
5. Run `node test-all.mjs` before pushing.
6. Open a pull request against `main`.

## Fuzzing

The scripts that read text they do not control have Jazzer.js targets in `fuzz/`: the public text
check, the fleet-status check, the pin bump's workflow readers and the verdict post's inputs. Each
target states the contract it asserts in its header. To run them:

```bash
npm ci --prefix .clusterfuzzlite
FUZZ_ARTIFACT_DIR=fuzz/crashes FUZZ_SECONDS=60 node fuzz/run.mjs   # FUZZ_ONLY=pin_yaml for one target
```

`fuzz.yml` runs them weekly, on demand and on a pull request that changes a target or a script one
imports. A crash writes the reproducing input to `FUZZ_ARTIFACT_DIR` (`fuzz/crashes/` in CI, uploaded
as an artifact; the working directory when it is unset): fix the script at its source, add a test and
put the input under `fuzz/seeds/<target>/`, where `node fuzz/seeds.test.mjs` replays it. A script a target
imports must not need a build step, and a new target is a `fuzz/<name>.fuzz.js` that is also listed in
`.clusterfuzzlite/build.sh`.

## What CI requires

Every pull request must pass these checks to merge:

- `test`: the tests `test-all.mjs` runs, on Node **22**
- `verify pinned reviewer surface`: the tool definitions the reviewer and the fixer read are pinned
  with truecopy, and the build fails when their bytes change
- **CodeQL** static analysis of the scripts and the workflows

OpenSSF Scorecard also runs on the repository.

## Conventions

- GitHub Actions are **pinned to a commit SHA**, never a mutable tag. New or updated workflow steps
  must keep this. Our own pins (`askalf/ci/...@<sha>`) move through the pin bump, not by hand.
- A comment states the constraint the code keeps, not the history of how it got there.
- Commit messages: a short imperative subject, with a wrapped body explaining the why when it is not
  obvious.
- Pull requests are squash-merged, so the title becomes the commit subject on `main`.
