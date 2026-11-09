# askalf/ci

[![CI measured](https://img.shields.io/endpoint?url=https%3A%2F%2Fpitlane.askalf.org%2Fbadge.json)](https://pitlane.askalf.org/)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/askalf/ci/badge)](https://scorecard.dev/viewer/?uri=github.com/askalf/ci)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/16411/badge)](https://www.bestpractices.dev/projects/16411)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

The gate every fix lands through: the reusable workflows and composite actions a pull request on
one of our public repositories has to pass before it lands.

**Redline, the review at its center, is an AI code review.** A model reads each ready pull request
with read-only tools and either approves it or requests changes, and every finding has to quote the
diff, the pull request text or a commit message it is about. The models are set on the runner host.
Our hosts run it on OpenAI models through a ChatGPT subscription: `REDLINE_MODEL=gpt-5.6-terra` reads
routine pull requests and `REDLINE_DEEP_MODEL=gpt-6-astra` reads large or sensitive ones. For any
setting a host leaves unset, the defaults in [`scripts/redline/review.mjs`](scripts/redline/review.mjs)
apply: `claude-fable-5-1` as the main model, and `claude-opus-5-5` as the fallback and for pull
requests that only move Redline pins.

**Who this is for.** The askalf repositories call it today. Another repository can adopt it by
forking this one: [Who can use this](#who-can-use-this) lists what a fork needs and what it changes.

A calling repository's `.github/workflows/redline.yml`, in short ([Calling it](#calling-it) has the
details):

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions: { actions: read, contents: read, pull-requests: read }
jobs:
  review:
    if: github.event.pull_request.draft == false && github.event.pull_request.head.repo.full_name == github.repository
    uses: askalf/ci/.github/workflows/redline-review.yml@<sha>
    with: { redline-ref: <sha>, runner-label: redline }
```

## Where this sits

One CI setup in four layers, and this repository is the gate.

| Layer | What it does | Where it lives |
|---|---|---|
| **ci-wizard measures it** | A read-only audit of a repository's GitHub Actions: where the time goes and what to fix first, with the cause confirmed in the workflow file before a finding names it. A fix is measured the same way before and after it lands here. | [askalf/ci-wizard](https://github.com/askalf/ci-wizard) |
| **pitlane runs it, as the lab** | Self-hosted, ephemeral, non-root runners we run ourselves, one job each, where ci-wizard's method is proven. Every job's queue wait, from GitHub creating it to a runner starting it, is measured, and the last 24 hours are published live against two targets: a median under 5 s and a p90 under 30 s. The badge above is that median. | [the proof page](https://pitlane.askalf.org/), its [JSON](https://pitlane.askalf.org/stats.json) and the runner code, [askalf/pitlane](https://github.com/askalf/pitlane) |
| **This repository gates it** | Redline, the AI code review every pull request has to pass. The caller runs it as a reusable workflow at one pinned commit, and the finished review is posted on the pull request as an approval or a request for changes. That posted review is what a merge waits on: a ruleset that requires an approving review lets the pull request merge only once its latest push is approved ([what this repository's ruleset requires](#what-holds-a-merge)). Beside it: the public-text check, the fleet statuses a merge waits on, and shared steps such as a checkout that retries. | here |
| **truecopy-action is the integrity gate inside it** | The gate that fails the build on a tampered skill. [@askalf/truecopy](https://www.npmjs.com/package/@askalf/truecopy) pins the exact bytes of each vetted tool definition in `truecopy.lock`, and the action fails the job when those bytes change or newer detection flags them. Here it pins the tools the reviewer and the fixer read. | [askalf/truecopy-action](https://github.com/askalf/truecopy-action); [`truecopy-gate.yml`](#the-truecopy-gate) here |

## Who can use this

These workflows are built for the askalf repositories, and the values in them that name ours are
inputs with ours as the defaults. An outside repository can call them as they are and pass its own
values in `with:`, or fork this repository and point its callers at the fork with `ci-repo`.
Either way it provides:

| What it needs | Why | Here |
|---|---|---|
| A self-hosted runner with the label the caller passes (`redline` above) | The review runs there and reads the prompt and credential files on that host | [pitlane](https://github.com/askalf/pitlane) rows |
| A model endpoint | `review.mjs` sends its turns as Anthropic Messages API requests (`/v1/messages`) to `DARIO_URL` (default `http://127.0.0.1:3456`), with `DARIO_API_KEY` or a key socket | [dario](https://github.com/askalf/dario) |
| The prompt file | The reviewer's rubric is never committed: `REDLINE_PROMPT_FILE` names it on the host | [The prompts live on the host](#the-prompts-live-on-the-host) |
| The credential file | `REDLINE_ENV_FILE` holds the endpoint's address and key and the model settings | the same section |
| A reviewer account and its token | The review is posted as that account by `redline-post-verdict.yml`, on a GitHub-hosted runner, with the caller's `REDLINE_REVIEWER_TOKEN` secret | `sprayberry-redline` |
| The post caller | The calling repository's `redline-post.yml` passes that secret | [Calling it](#calling-it) |
| A ruleset that requires an approving review | The posted approval is what lets a pull request merge | [What holds a merge](#what-holds-a-merge) |

The inputs, each optional, with the value every askalf caller runs:

| Input | Reusable workflows | Default | What it is |
|---|---|---|---|
| `env-file` | redline-review.yml | `/etc/askalf/redline.env` | the host file with the endpoint's address and key and the model settings |
| `prompt-file` | redline-review.yml | `/etc/askalf/redline-prompt.md` | the host file with the reviewer's rubric |
| `env-file`, `prompt-file` | redline-fix-run.yml | `/etc/askalf/fix-exec.env`, `/etc/askalf/fix-prompt.md` | the same two for the fix lane |
| `reviewer-login` | redline-review.yml, redline-post-verdict.yml | `sprayberry-redline` | the account whose posted reviews are Redline's: the one the post caller's token posts as |
| `ci-repo` | redline-review.yml, redline-post-verdict.yml, redline-fix-run.yml, public-text.yml | `askalf/ci` | where the scripts are fetched from; `redline-ref` must be a commit on its `main`, and the poster trusts a review run only if it called this repository's `redline-review.yml` |

A caller passes the same `reviewer-login` to the review and to the post, and a fork passes its
own `ci-repo` to all four. `uses:` takes no expression, so a fork's callers also name the fork
there. In the fork itself, the pin bump (`redline-pin-bump.yml`) runs once the repository variable
`REDLINE_CALLERS` lists its callers (space-separated owner/name; without it the bump runs in
askalf/ci only), on the runner labels in `REDLINE_PIN_BUMP_RUNS_ON` (a JSON list, default
`["self-hosted","ci-exec"]`), with a GitHub App of its own installed on its callers: its client id in the
variable `REDLINE_PIN_BUMP_CLIENT_ID` and its private key in the secret `REDLINE_PIN_BUMP_APP_KEY`. One value is still
fixed: the fleet statuses (`actions/fleet-status`) count `sprayberry-redline`'s reviews.

## Words used here

- **Caller:** a repository's workflow that calls one of these reusable workflows at a pinned commit.
- **Fleet:** the askalf repositories that call these workflows. The fleet statuses are the
  `fleet/verify` and `fleet/review` commit statuses a merge there waits on.
- **Exec runner:** the self-hosted runner a repository's build and test jobs run on, and the fix
  lane with them. The `redline` runner only reads pull requests.
- **Ops tick:** the scheduled job on our runner host that dispatches the fix lane and the
  dispatch-mode reviews, and pushes a verified fix to the pull request branch. It is not in this
  repository.
- **Pin bump:** the hourly pull request in each caller that moves its pins to a newer commit here.

## What is here

The mechanics and nothing else: no credential, no prompt. The repository is public because a public
repository can only call a public reusable workflow. A caller pins each workflow and action at one
full commit sha of `main`, so a change here reaches it only through a reviewed bump
([the pin bump](#the-pin-bump)).

| Called by other repositories | What it does |
|---|---|
| [`redline-review.yml`](.github/workflows/redline-review.yml) | Redline, the AI review: `scripts/redline/review.mjs` reads the pull request with read-only tools on the caller's self-hosted runner and returns APPROVE or REQUEST_CHANGES; the job passes or fails with it, and the caller's post workflow posts the verdict as a review. |
| [`redline-fix-run.yml`](.github/workflows/redline-fix-run.yml) | The first-party answer to a REQUEST_CHANGES: `scripts/redline/fix.mjs` edits and tests the reviewed head on the caller's exec runner and uploads the fix as an artifact. Nothing in the job pushes or comments. |
| [`public-text.yml`](.github/workflows/public-text.yml) | Fails a pull request that overuses em or en dashes, or whose title, description or a commit message credits a model or an AI tool. It reads the pull request through the API and checks out none of its code. |
| [`actions/checkout-with-retry`](actions/checkout-with-retry/action.yml) | `actions/checkout` as up to three steps, so a job that starts before its runner's credential is in place still checks out. |
| [`actions/drift-report`](actions/drift-report/action.yml) | The report step of a drift watcher: one issue under a label, one bot pull request carrying the changed files, and the issue closed on a clean run. |
| [`actions/fleet-status`](actions/fleet-status/action.yml) | Posts the `fleet/verify` and `fleet/review` commit statuses a merge waits on; the lane rules are in [scripts/fleet-status/README.md](scripts/fleet-status/README.md). |
| [`actions/fleet-status-check`](actions/fleet-status-check/action.yml) | Checks a repository's fleet-status workflows, its self-hosted `runs-on` labels and its review relay, as that repository's self-test job. |

| This repository's own | What it does |
|---|---|
| `redline.yml`, `redline-fix.yml`, `redline-post.yml` | This repository's callers of the review, the fix and the post, pinned and bumped like every other caller's. |
| `public-text-check.yml` | Runs `public-text.yml` on this repository's own pull requests, with the script fetched at the base commit. |
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

`fix-exec.env` may also set `FIX_EFFORT` (`low`, `medium`, `high`, `xhigh` or `max`). A fix run
answering the reviewer's first change request on a pull request sends that level as
`output_config.effort`; a run answering a later change request from the same reviewer sends `high` or
the setting when that is higher. The count is of change requests, not of fix runs: if an earlier
request was answered by hand, the first fix run already sends `high`. Unset, no request names an
effort.

## The pin bump

`redline-pin-bump.yml` runs hourly and on dispatch, and picks the newest `main` commit that changed
what a caller runs: the scripts the reusable workflows and actions fetch (their tests, test fixtures
and READMEs aside), one of the four actions, or one of the reusable workflows. It rewrites, in every
repository in its `CALLERS` list,
the reusable-workflow pins in `redline.yml`, `redline-fix.yml`, `public-text.yml` and
`redline-post.yml` where the repository has them, and every pin of one of the four actions in any workflow file there, through
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

The job writes with the pin bump's GitHub App, installed on every repository in the list with
Contents, Pull requests and Workflows read and write (Workflows because the pins live in
`.github/workflows/`). Each run mints a token of those three that lasts an hour and is revoked
when the job ends; no long-lived token writes to the callers. Without the App's client id (variable
`REDLINE_PIN_BUMP_CLIENT_ID`) the job says so and stops, green; with a missing or wrong private key
(secret `REDLINE_PIN_BUMP_APP_KEY`) it fails.

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

## What holds a merge

This repository's ruleset on `main` requires one approving review of the latest push, resolved
review threads, a linear history, and four checks: `test` (the Redline self-test), `verify pinned
reviewer surface` (the truecopy gate) and the two CodeQL `analyze` jobs. The review job itself is
not a required check. What holds a pull request back is the review it posts: an approval from the
reviewer account satisfies the required review, and a request for changes stops the merge until a
new head is approved. The approval is the model's; no person signs off on each merge.

The review job stays unrequired on purpose. A pull request that changes a workflow runs its own
workflow files, so it could make a check of that name pass; that is why the poster refuses such a
head and only a dispatch on the default branch reviews it, and a dispatch run reports on the
default branch, not on the pull request. Requiring the job would add nothing those heads cannot
fake, and a transient failure of the pull_request run would hold a merge the posted review had
already approved. Actions here must be pinned to a full commit sha (the repository's
`sha_pinning_required` setting), so no workflow run can resolve a moving tag.

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
