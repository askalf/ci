# Changelog

Callers pin a full commit of `main`, so this log names pull requests, not versions. Pin-bump and
dependency pull requests are left out.

## Versioning

There are no tags yet. The plan: tag `vX.Y.Z` on the commit each pin-bump wave moves the callers
to, with a release whose notes are the changes since the last tag. Callers keep pinning the full
commit sha (a tag can move, a sha cannot); the tag and its release say which change set that sha
is, and give tools that track releases something to follow. Until then, a caller's pin comment
names the commit's date and the pull request it came from.

## November 2026

- `docs/hosted-quickstart.md`: the whole hosted-mode setup for a repository outside askalf, in
  order: the reviewer account, the three secrets, the two workflow files to copy, the ruleset,
  and how a pull request that changes a workflow or comes from a fork is reviewed by a dispatch.
- The dario sidecar of hosted mode is tested for real: `redline-sidecar-self-test.yml` runs the
  start step of `redline-review.yml` against the pinned dario image and a stand-in lock service,
  on a pull request that changes the review workflow or the test, and weekly.
- A new action, `actions/scorecard-publish-check`: on `workflow_run` of a repository's Scorecard
  workflow it checks that the run's result reached scorecard.dev, dispatches Scorecard once more
  when it did not, and fails when a dispatched run is unpublished too. A failed publish was a
  warning on a green run, and left askalf/pitlane's badge reading "invalid repo path" for fifteen
  hours on 2026-11-09. The pin bump moves its pins like the other actions'. This repository calls
  it from `scorecard-publish.yml`.
- The review has a hosted mode: a caller passes `hosted-runner` (such as `ubuntu-latest`) in place
  of `runner-label`, with the model endpoint's key and its own rubric as the `model-api-key` and
  `reviewer-prompt` secrets, and the review runs on a GitHub-hosted runner against any endpoint
  that answers the Anthropic Messages API (`model-url`, `model`, `deep-model`). No self-hosted
  runner, host file or local model endpoint is needed. `runner-label` is no longer a required
  input; a caller that passes it runs as before.
- Hosted mode can read the review through a dario sidecar on subscription seats: `dario-image`
  (pinned by digest), `dario-lock-url` and the `dario-lock-token` secret in place of
  `model-api-key`. The job starts dario on the runner's loopback with a key made for the run, and
  dario takes its seats from the lock service's account registry.
- The account whose dispatched reviews are trusted is an input, `dispatch-actor`, of the review
  and the post (default `askalf`, compared without case). Before, only askalf's dispatch was
  posted or read as history, so no other repository could review a pull request that changes a
  workflow.
- The round cap counts only heads a model read, since Redline's newest approval. A cap verdict
  (`rule:round-cap`) is not a round, not the head a delta is read from, not an earlier request for
  the model to check, and not the request the next cap quotes; before, every push past the cap
  added a round and each cap quoted the one before it. A cap verdict does carry the count it states
  and the request it quoted, so once capped pushes fill the verdict history a run reads, the PR stays
  capped and the cap still quotes the real request. An approval, a re-read's included, clears the
  count, so a PR that met the bar and then moved is read again instead of capped.
- A low-risk approval posted under the reviewer's login from the file list alone (its body opens with
  `**Deterministic approval`) is never read as Redline's verdict: it is not reused as a standing
  verdict, not a judged head for the delta, and not a round. Before, a head Redline had not read could
  pass on it.
- A `misleading-text` finding on the pull request's description is reported as minor and never
  blocks: the description is not what ships. Attribution and a secret there still block.
- A Redline round after an earlier verdict reads the delta first: the brief's diff is the compare
  of the head last judged and this one, and the whole change is one `redline_diff` call away
  (every file, or one path). A finding may quote either. A first review shows the whole change.
- Redline reads its own earlier verdicts from the pull request's runs, not only from posted
  reviews, so a round on a repository where nothing is posted still sees the last; the brief asks
  for every blocking finding in the one review; and after `REDLINE_ROUND_CAP` request-changes
  rounds on one pull request (default 4, by head) a new head is not read: the run asks for changes
  once more without a model call, quotes the last request and leaves the pull request to a person,
  under the rule `round-cap`. A dispatch with `reread` reads that head after all. `zipEntry` moves
  to `zip.mjs`, shared by the post and the review.
- Public text fails on dash overuse, not on a dash: five or more added lines that are also more than
  one line in twenty. A dash or two in normal text passes, and a pull request from a fork is not read
  for dashes at all. Credits to a model or an AI tool are read as before.
- The scripts' input parsers are fuzzed with Jazzer.js: the pull request text and patches the public
  text check reads, the workflow files the fleet-status check reads, the caller workflows the pin
  bump rewrites, and the run record, patch and artifact the verdict post reads. `fuzz.yml` runs
  every target weekly, on demand and, for a change to a target or the script under it, on a pull
  request; `cflite.yml` is a coverage report, because ClusterFuzzLite cannot fuzz JavaScript. A
  job named like a built-in property (`constructor`, `toString`, `__proto__`) in a caller
  workflow is read as a job by the pin bump's permission check, not as that property.
  The fleet-status check reads a matrix key with no space after its colon, and a matrix of more than
  256 jobs (which Actions refuses), as unreadable, where it threw or ran out of time.
- This repository's own pull requests run the public text check. `public-text.yml` here is the
  called workflow, so `public-text-check.yml` calls it from the checkout and reports the same
  `public-text / check` a caller does, with the script fetched at the base commit.
- The values that named askalf in the reusable workflows are inputs with today's values as their
  defaults, so every caller runs as before: `env-file` and `prompt-file` (review and fix),
  `reviewer-login` (review and post) and `ci-repo` (review, post, fix and public-text), which the
  on-main check, the script checkout and the poster's trust check all follow. The pin bump takes a
  fork's callers from the repository variable `REDLINE_CALLERS` and its runner labels from
  `REDLINE_PIN_BUMP_RUNS_ON`. A `REDLINE_CI_REPO` or `REDLINE_REVIEWER_LOGIN` that is not a
  repository or a login stops the script when it loads.
- The fleet-status action runs on the runner's own Node and reads its statuses in two parallel
  rounds (#161), runs on a label event only for the `verified` label (#159), and accepts a
  self-test that runs on every pull request (#157).
- The fix lane sends `FIX_EFFORT` on its first round and `high` or more on later ones (#163).
- Redline's verdict posts from a `workflow_run` job in each repository, on a GitHub-hosted runner
  (#148, #151, #153).
- A forced pin-bump run gets 30 minutes, enough for the whole caller list (#166).
- The fleet-status checker escapes a pattern as a whole (#162).
- Security floor: licence, policies, CodeQL and Scorecard (#144). The README describes the gate
  beside the runners and the integrity check (#143, #147, #149).

## October 2026

- Review: changed files go with the brief and are read 1,000 lines at a time (#120); each review
  has its own conversation id for the cache key (#132); a review reads the pull request's earlier
  requests for changes (#56); a workflow can hand the review facts from outside the checkout
  (#44).
- Review routing: routine pull requests on `REDLINE_MODEL`, sensitive or large ones on
  `REDLINE_DEEP_MODEL` (#46), pin bumps and image files kept off the deep model (#50), deep reads
  on their own key (#52), and a fallback when the endpoint reports the model unroutable (#28).
- Fork pull requests: read on a dispatch, after the contributor gate, with nothing from them run
  (#65); a fork repository runs on GitHub's runners (#18, #29).
- `local.mjs` reviews a branch before the push (#123, #125, #129).
- Public text: fails a pull request that adds an em or en dash (#111) or whose text credits a model
  or an AI tool (#113, #115).
- Fix lane: never edits a file marked redline-protected (#12); answers a finding on the pull
  request description (#15); runs the checkout's commands as a separate run account (#17, #26);
  reaches the model endpoint through a key socket, so no runner holds the key (#20); can edit a
  `.github` file the pull request itself changes (#42); runs on the repository's fix-lane runner
  (#58); commits with its subject only (#110).
- Pin bump: batched into waves spread over hourly runs (#27, #35, #61, #62); never moves a pin
  ahead of the permission it needs (#67); finds the calling job from the workflow's structure,
  not its text (#68); moves drift-report and fleet-status action pins too (#38, #48, #70);
  skips callers whose workflows are unchanged since they were found at the commit (#139).
- New actions: `drift-report` (#37), `checkout-with-retry`, folded in from its own repository
  (#72, #74, #78, #79), and the fleet-status lanes and checker (#121, #134, #135).
- Captured data marked redline-protected is not read as public prose (#59).

## September 2026

- The truecopy gate pins the reviewer's tool surface (#1, #2).
- The review continues on a fallback model when the primary is parked (#3).
- Dispatch mode for heads a `pull_request` run cannot vouch for (#4).
- The fix lane names every tool `fix_*` and names failed tests in its notes (#6, #7).
- The pin bump's token needs Workflows read and write (#9).
