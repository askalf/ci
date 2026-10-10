# askalf/ci

Redline, the gating code review on Sprayberry Labs' public repositories, as reusable GitHub Actions
workflows: the review (`redline-review.yml`, `scripts/redline/review.mjs`), the first-party fix that
answers a review (`redline-fix-run.yml`, `scripts/redline/fix.mjs`) and the pin bump that moves every
caller to a new commit of both (`redline-pin-bump.yml`, `scripts/redline/pin.mjs`). This repository is
public because a public repository can only call a public reusable workflow. It holds the mechanics
and nothing else: no credential, no prompt.

## Calling it

A repository's `.github/workflows/redline.yml` calls the review at one full commit sha of this
repository's `main`, and passes the same sha as `redline-ref`:

```yaml
jobs:
  review:
    if: github.event.pull_request.draft == false && github.event.pull_request.head.repo.full_name == github.repository
    uses: askalf/ci/.github/workflows/redline-review.yml@<sha>
    with:
      redline-ref: <sha>
      runner-label: redline
```

The two shas must be equal. GitHub gives a reusable workflow no way to learn its own commit, so the
workflow fetches `scripts/redline` at `redline-ref`, after checking that it is a full sha and a commit
on `main` here: a caller cannot point its review at a script from an unmerged branch. The fix caller,
`redline-fix.yml`, has the same shape with `redline-fix-run.yml` and the repository's exec runner
label; `node scripts/redline/pin.mjs --caller <sha> <label>` prints it.

## The prompts live on the host

The reviewer's rubric and the fixer's brief are never committed here. Each runner host carries them as
files, and the workflows hand the scripts their paths:

| file | read by | env | owner and mode |
|---|---|---|---|
| `/etc/askalf/redline-prompt.md` | `review.mjs` | `REDLINE_PROMPT_FILE` | readable by the account that runs the `redline` runner |
| `/etc/askalf/fix-prompt.md` | `fix.mjs` | `FIX_PROMPT_FILE` | readable by the exec runner's account only, like `fix-exec.env`; never by an account that runs untrusted code |

The scripts have no bundled fallback: a variable that is unset, a file that cannot be read or an empty
file fails the job with an error naming the variable. The tests use the three-line stand-ins in
`scripts/redline/test-fixtures/`. A pull request that adds prompt text to this repository is wrong by
definition, whatever it says.

Next to the prompts the hosts hold the credential files the scripts read (`/etc/askalf/redline.env`,
`/etc/askalf/fix-exec.env`): no secret is stored in GitHub.

## The pin bump

A push to `main` that changes what a caller runs, `scripts/redline/` (its tests, test fixtures and
README aside) or one of the reusable workflows, runs `redline-pin-bump.yml`. It rewrites `redline.yml` and, where a repository has one, `redline-fix.yml` in
every caller in its `CALLERS` list through `pin.mjs`, one commit per caller file on `bot/redline-pin`,
and opens or updates one pull request per repository. Each repository's own gate reviews and merges the
bump. This repository is in the list: its own `redline.yml` moves the same way. The job needs
`REDLINE_PIN_BUMP_TOKEN`, a fine-grained token with Contents, Pull requests and Workflows read and
write on every repository in the list (Workflows because the pins live in `.github/workflows/`);
without it the job says so and stops, green. A repository whose bump fails is reported and the job
goes on to the next one, then fails at the end.

## The drift report

`actions/drift-report` is the step a drift watcher ends with, pinned the same way: `uses:
askalf/ci/actions/drift-report@<sha>`. A watcher decides what drifted and says so through three
inputs; the action opens or refreshes the issue under a label, carries changed files into one open
bot pull request with the diff in its body, and closes the issues on a clean run. The PR is opened
with a PAT so that CI runs on it, the issue is handled with the job token so that a PAT without
Issues rights is enough. The mechanics and the token split are in
[scripts/drift-report/README.md](scripts/drift-report/README.md); `pin.mjs --action <sha>` moves the pin.

## Tests

`node scripts/redline/review.test.mjs` and `node scripts/redline/fix.test.mjs` run against a stubbed
GitHub and model and touch no network; `node scripts/drift-report/report.test.mjs` runs the drift
report against a fake `gh` and `git`. `redline-self-test.yml` runs them, and the `tools.json` and
`fix-tools.json` drift check, on every pull request: it is a required check, and a path-filtered
required check never reports on a pull request outside its paths.

## The truecopy gate

`truecopy.lock` pins the tool surfaces the models read: `scripts/redline/tools.json`, the reviewer's
read-only tools, and `scripts/redline/fix-tools.json`, the fixer's tools, which write and run in the
checkout. `truecopy-gate.yml` verifies both on every pull request and push to `main`:
`dump-tools.mjs --check` proves each file still matches `TOOLS` in `review.mjs` or `fix.mjs`, then
`truecopy verify` proves the pinned bytes did not move and still scan clean. A changed tool fails
until it is re-pinned with `truecopy add scripts/redline/tools.json` (or `fix-tools.json`). The prompts are not in the lock: they live on the runner
hosts, not in this repository, so there is nothing here to pin.
