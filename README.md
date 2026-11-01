# askalf/ci

[![CI on pitlane](https://img.shields.io/endpoint?url=https%3A%2F%2Fpitlane.askalf.org%2Fbadge.json)](https://pitlane.askalf.org/)

The gate layer of Sprayberry Labs' CI: the reusable workflows and composite actions a pull request
on one of our public repositories has to pass before it lands.

## Where this sits

One CI setup in three layers, and this repository is the middle one.

| Layer | What it does | Where it lives |
|---|---|---|
| **pitlane runs it** | Self-hosted, ephemeral, non-root runners we run ourselves, one job each. Every job's queue wait, from GitHub creating it to a runner starting it, is measured, and the last 24 hours are published live against two targets: a median under 5 s and a p90 under 30 s. The badge above is that median. | [the proof page](https://pitlane.askalf.org/) and its [JSON](https://pitlane.askalf.org/stats.json) |
| **This repository gates it** | Redline, the code review every pull request has to pass. The caller runs it as a reusable workflow at one pinned commit, the review's own check is the verdict (approve, or the job fails and the pull request does not merge), and the finished review is posted on the pull request. Beside it: the public-text check, the fleet statuses a merge waits on, and shared steps such as a checkout that retries. | here |
| **truecopy-action is the integrity gate inside it** | The gate that fails the build on a tampered skill. [@askalf/truecopy](https://www.npmjs.com/package/@askalf/truecopy) pins the exact bytes of each vetted tool definition in `truecopy.lock`, and the action fails the job when those bytes change or newer detection flags them. Here it pins the tools the reviewer and the fixer read. | [askalf/truecopy-action](https://github.com/askalf/truecopy-action); [`truecopy-gate.yml`](#the-truecopy-gate) here |

## What is here

The mechanics and nothing else: no credential, no prompt. The repository is public because a public
repository can only call a public reusable workflow. A caller pins each workflow and action at one
full commit sha of `main`, so a change here reaches it only through a reviewed bump
([the pin bump](#the-pin-bump)).

| Called by other repositories | What it does |
|---|---|
| [`redline-review.yml`](.github/workflows/redline-review.yml) | Redline, the gating review: `scripts/redline/review.mjs` reads the pull request with read-only tools on the caller's self-hosted runner, and the job's result is the verdict: APPROVE passes, REQUEST_CHANGES fails. |
| [`redline-fix-run.yml`](.github/workflows/redline-fix-run.yml) | The first-party answer to a REQUEST_CHANGES: `scripts/redline/fix.mjs` edits and tests the reviewed head on the caller's exec runner and uploads the fix as an artifact. Nothing in the job pushes or comments. |
| [`public-text.yml`](.github/workflows/public-text.yml) | Fails a pull request that adds an em or en dash, or whose title, description or a commit message credits a model or an AI tool. It reads the pull request through the API and checks out none of its code. |
| [`actions/checkout-with-retry`](actions/checkout-with-retry/action.yml) | `actions/checkout` as up to three steps, so a job that starts before its runner's credential is in place still checks out. |
| [`actions/drift-report`](actions/drift-report/action.yml) | The report step of a drift watcher: one issue under a label, one bot pull request carrying the changed files, and the issue closed on a clean run. |
| [`actions/fleet-status`](actions/fleet-status/action.yml) | Posts the `fleet/verify` and `fleet/review` commit statuses a merge waits on; the lane rules are in [scripts/fleet-status/README.md](scripts/fleet-status/README.md). |
| [`actions/fleet-status-check`](actions/fleet-status-check/action.yml) | Checks a repository's fleet-status workflows, its self-hosted `runs-on` labels and its review relay, as that repository's self-test job. |

| This repository's own | What it does |
|---|---|
| `redline.yml`, `redline-fix.yml` | This repository's callers of the review and the fix, pinned and bumped like every other caller's. |
| `redline-pin-bump.yml` | Hourly, moves every caller's pins to the newest `main` commit that changed what a caller runs, one pull request per repository. |
| `redline-self-test.yml` | The Redline, public-text, drift-report, fleet-status and pin-bump tests on every pull request: a required check. |
| `checkout-with-retry-self-test.yml` | Proves the retry action on a runner: a healthy checkout, the retry paths through a stub, and the act path under act. |
| `fleet-status-self-test.yml` | Runs the two fleet-status actions from the checkout as a caller would, the status one as a dry run. |
| `truecopy-gate.yml` | Verifies `truecopy.lock`, the pins on the reviewer's and the fixer's tools, on every pull request and push to `main`. |

## Calling it

A repository's `.github/workflows/redline.yml` calls the review at one full commit sha of this
repository's `main`, and passes the same sha as `redline-ref`:

```yaml
permissions:
  actions: read
  contents: read
  pull-requests: read

jobs:
  review:
    if: github.event.pull_request.draft == false && github.event.pull_request.head.repo.full_name == github.repository
    uses: askalf/ci/.github/workflows/redline-review.yml@<sha>
    with:
      redline-ref: <sha>
      runner-label: redline
```

The two shas must be equal. GitHub gives a reusable workflow no way to learn its own commit, so the
workflow fetches `scripts/redline` at `redline-ref`, after checking that it is a full sha and a
commit on `main` here: a caller cannot point its review at a script from an unmerged branch. The
caller grants the review all three read permissions, since a called workflow gets no permission its
caller withholds and GitHub refuses to start one that asks for more; `actions: read` is for the fork
check, which lists the head's pull_request runs and their jobs.

A fork PR is reviewed only on a dispatch (`redline-review.yml`'s dispatch mode) and only after its
workflows have been let through the contributor gate: the head is fetched from the repository's own
pull ref, compared with the sha the dispatch named, and read with symlinks written as plain files;
nothing from it runs.

The fix caller, `redline-fix.yml`, has the same shape with `redline-fix-run.yml` and the
repository's exec runner label; `node scripts/redline/pin.mjs --caller <sha> <label>` prints it. The
public-text caller, `public-text.yml`, calls `public-text.yml` here the same way, with `redline-ref`
and no runner label: it runs on a GitHub-hosted runner.

## The prompts live on the host

The reviewer's rubric and the fixer's brief are never committed here. Each runner host carries them as
files, and the workflows hand the scripts their paths:

| file | read by | env | owner and mode |
|---|---|---|---|
| `/etc/askalf/redline-prompt.md` | `review.mjs` | `REDLINE_PROMPT_FILE` | readable by the account that runs the `redline` runner |
| `/etc/askalf/fix-prompt.md` | `fix.mjs` | `FIX_PROMPT_FILE` | readable by the exec runner's account only, like `fix-exec.env`; never by an account that runs untrusted code |

The scripts have no bundled fallback: a variable that is unset, a file that cannot be read or an
empty file fails the job with an error naming the variable. The tests use the three-line stand-ins in
`scripts/redline/test-fixtures/`. A pull request that adds prompt text to this repository is wrong by
definition, whatever it says.

Next to the prompts the hosts hold the credential files the scripts read (`/etc/askalf/redline.env`,
`/etc/askalf/fix-exec.env`): no secret is stored in GitHub.

## The pin bump

`redline-pin-bump.yml` runs hourly and on dispatch, and picks the newest `main` commit that changed
what a caller runs: the scripts the reusable workflows and actions fetch (their tests, test fixtures
and READMEs aside), one of the four actions, or one of the reusable workflows. It rewrites, in every
repository in its `CALLERS` list,
the reusable-workflow pins in `redline.yml`, `redline-fix.yml` and `public-text.yml` where the
repository has them, and every pin of one of the four actions in any workflow file there, through
`pin.mjs`: one commit per file on `bot/redline-pin`, one pull request per repository. Each
repository's own gate reviews and merges the bump. This repository is in the list: its own callers
move the same way. A repository with no pin of any kind is reported as wrong.

Each bump is a review in every caller, so bumps are batched. The hourly run bumps to that commit
once it has been quiet for an hour, so a burst of merges is one wave, and opens or updates at most
three pull requests per run, leaving the rest of the list for the next run; a dispatch without
`wait-for-quiet` bumps every caller at once, for a fix that cannot wait.
An open bump that already proposes the picked commit is left alone, so its review and checks are not
restarted. A repository whose bump fails is reported and the job goes on to the next one, then fails
at the end. A repository found with every pin at the commit is noted with its `.github/workflows`
tree in a cache entry for that commit, and later runs read only that tree id until a workflow there
changes.

The job needs `REDLINE_PIN_BUMP_TOKEN`, a fine-grained token with Contents, Pull requests and
Workflows read and write on every repository in the list (Workflows because the pins live in
`.github/workflows/`); without it the job says so and stops, green.

## The drift report

`actions/drift-report` is the step a drift watcher ends with, pinned the same way: `uses:
askalf/ci/actions/drift-report@<sha>`. A watcher decides what drifted and says so through three
inputs; the action opens or refreshes the issue under a label, carries changed files into one open
bot pull request with the diff in its body, and closes the issues on a clean run. The PR is opened
with a PAT so that CI runs on it, and the issue is handled with the job token so that a PAT without
Issues rights is enough. The mechanics and the token split are in
[scripts/drift-report/README.md](scripts/drift-report/README.md).

## Checkout with retry

`actions/checkout-with-retry` is `actions/checkout` run as up to three steps, 8 s and then 20 s
apart, pinned the same way: `uses: askalf/ci/actions/checkout-with-retry@<sha>`. An ephemeral
runner can start a job before its credential is in place; the first fetch then fails with `could not
read Username for 'https://github.com'`, and `actions/checkout`'s own retries re-use the credential
the step was handed, so only a new step clears it. The log says which attempt succeeded, a rescued
run carries a `::warning::` annotation, and the third failure fails the job as a plain checkout
would.

Every input our workflows pass is forwarded (`ref`, `repository`, `token`, `fetch-depth`, `path`,
`sparse-checkout`, `sparse-checkout-cone-mode`, `persist-credentials`); an input the action does not
declare is not forwarded, so it is added there before a caller uses it. Under act no attempt runs:
act stands in for a plain, input-free `actions/checkout` by copying the working directory into the
workspace, so the action's first step is one that runs under act only, and a `path`, `repository` or
`ref` act cannot honour is warned about. The inner `actions/checkout` pin moves through dependabot
(`.github/dependabot.yml`), and `checkout-with-retry-self-test.yml` runs the action from the checkout
on every pull request that changes it. It replaces the standalone `askalf/checkout-with-retry`, now
archived.

## Tests

`redline-self-test.yml` runs the tests on every pull request, and it is a required check; a
path-filtered required check never reports on a pull request outside its paths, so it is not path
filtered. The tests touch no network: `review.test.mjs` and `fix.test.mjs` run against a stubbed
GitHub and model, `local.test.mjs` runs the pre-push review against a throwaway repository and a
stubbed model, `public-text.test.mjs` runs the dash and credit rules,
`report.test.mjs` runs the drift report against a fake `gh` and `git`, `fleet-status.test.mjs` and
`check.test.mjs` run the fleet lanes and their checker against a stubbed GitHub and a fixture caller,
and `pin-bump.test.mjs` runs the pin bump's bump step against a fake `gh`. The same job runs the
`tools.json` and `fix-tools.json` drift check.

## The truecopy gate

`truecopy.lock` pins the tool surfaces the models read: `scripts/redline/tools.json`, the reviewer's
read-only tools, and `scripts/redline/fix-tools.json`, the fixer's tools, which write and run in the
checkout. `truecopy-gate.yml` verifies both on every pull request and push to `main`:
`dump-tools.mjs --check` proves each file still matches `TOOLS` in `review.mjs` or `fix.mjs`, then
[truecopy-action](https://github.com/askalf/truecopy-action) checks the Sigstore attestation of the
`@askalf/truecopy` tarball it installs and runs `truecopy verify`, which proves the pinned bytes did
not move and still scan clean. A changed tool fails until it is re-pinned with
`truecopy add scripts/redline/tools.json` (or `fix-tools.json`). The prompts are not in the lock:
they live on the runner hosts, not in this repository, so there is nothing here to pin.
