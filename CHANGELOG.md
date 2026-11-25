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

- The file `REDLINE_MODELS_FILE` names may set `REDLINE_ROUND_CAP`. The models file could not set
  the cap: it took only the four model pins, so a host whose pins come from a reviewed repository
  still kept its cap in its env file or in the runner's environment, where no review sees it. A
  cap in the models file replaces the env file's, and the log says so when the two are not the
  same count, giving the env file's value only when it is one: that file holds the host's
  secrets. Both are read trimmed. There
  it must be a whole number from 0 to 999 (0 turns the cap off), and anything else ends the run, as
  a family with no `*` does. The env file's own value is read as before, one that is not such a
  number counts as the default, and the process environment's is still read when neither file
  sets the key.
- A run that `main` ends on the env file, the models file, the prompt or the context file leaves
  no file of an earlier run to upload. `review.mjs` removed an earlier run's `verdict.json` only
  after it had read those four, and its `models.json` later still. A run that ended on one of
  them (a file that cannot be read, a family with no `*`) left both in the runner's workspace, and
  the workflow uploads a verdict or a models record whenever the file is there. `main` now removes
  both before it reads any of the four. A run that fails before `main` starts, on a setting read
  while the module loads (a reviewer login that is not a login), still leaves them.
- A review that asks for changes only through findings that do not block, a claim in the pull
  request description among them, is asked once which side is wrong. Such a review approves,
  because a claim the code does not back is corrected in the description with no commit, and the
  approval kept the summary the reviewer had written for a request for changes. A defect in the
  code that the reviewer wrote up as "the description promises this" was approved with it: on
  2026-11-24, of five reviews before the push of one pull request's heads, two were approvals
  whose summary asked for changes, and one of those listed under the description a failed
  download that stops every later one. The reviewer is now told that such a claim does not block
  and asked to give a defect in the code at its code line, with the severity the review rules
  give it there, or to keep the claim as a note; every finding is then weighed as before, so a
  secret in the description still blocks. It is asked once, and only with a turn left; a review
  that answers the same way approves as before, and its body now says that it asked for changes
  only for findings that do not block. A review held only by wording is not asked.
- Redline reads a Dependabot pull request's description without the text Dependabot copies in
  from the dependencies' repositories. Read from the top, a `<details>` block in exactly the
  form Dependabot writes, under its Release notes, Changelog or Commits summary line, is one line
  in the brief that names it; at the first line that is neither such a block nor plain text, the
  filter stops and the rest is read as written. Markdown is not interpreted. That text is another project's and does not ship; it could use up the 8,000
  characters the brief gives a description before Dependabot's own lines, and a credit line in a
  dependency's release notes blocked a dependency pull request as attribution. Dependabot's own
  lines and anything outside those blocks are read as before, so attribution or a secret there
  still blocks. A block of that shape is left out whoever wrote it. `local.mjs pack --pr` carries
  the author's account type, so a local review reads the description as CI does.
- A build lane turns a ticket into a change. `redline-build-run.yml` and `scripts/redline/build.mjs`
  start from a ticket's id, title and brief and a commit of the default branch, and leave one commit
  on top of that commit, as the fix lane leaves one on a pull request's head. The work in the
  checkout is the fix lane's own, split out of `fix.mjs` as `workCheckout` so both lanes run it: the
  run account, the allowlist, the test gate, the limits, the secret checks and the commit as askalf.
  The fix lane's behaviour is unchanged. A build writes nothing under `.github/`, must describe the
  pull request its commit becomes (`fix_describe`, asked for once, then the summary stands in),
  keeps the model's own subject prefix, and uploads the `redline-build` artifact: `build.json`,
  `notes.md`, `description.md` and `build.bundle`. It pushes nothing and opens no pull request. The
  ticket's title and brief show in the run's log, so on a public repository they are public. Its
  tools are pinned as `build-tools.json`. No repository calls the workflow yet: a caller pins a
  commit that is already on `main`, so it comes in a later change.
- A review before the push can be given Redline's earlier verdicts on the branch.
  `local.mjs pack --earlier <file>`, once per file and oldest first, adds a verdict the author
  kept to the earlier reviews the brief shows: a CI review's `verdict.json`, or the saved output
  of an earlier local review. A local review records nothing, and on a private repository no
  review is posted, so until now every local review of such a branch started with no memory of
  the last, and the rules that read earlier reviews (check their findings first, say when fixes
  are not converging) had nothing to read. A file in neither form is refused by name.
- A review before the push reads on the models the review in CI reads on. `local.mjs review` took
  its models from the env file alone and never laid the pins of `REDLINE_MODELS_FILE` over them, as
  `review.mjs` does. On a host that keeps model keys in the env file for callers pinned to an older
  Redline, a branch was read by one model before the push and by another in CI: on 2026-11-24 a
  local review ran on `gpt-6-astra` while the pins named `gpt-6.2-astra`. It now reads the pins
  the same way (`hostSettings`), prints the routine and deep models it holds, and stops when the
  models file cannot be read.
- The Redline model bump reads its records with the job's own token. It reads askalf/redline-rubric's
  artifacts because that repository is public (the bump's run of 2026-11-22 read a second-lens
  record with it), so the pin bump App's second token, minted with Actions read, and its warning
  are gone. The README says when another token would be needed: a private records repository.
- The fix lane's brief can carry lessons the lane drew from its earlier fixes that fell short: the
  five that best match the review, from a lessons service the host names in `fix-exec.env`
  (`FIX_LESSONS_URL`, `FIX_LESSONS_CLIENT_ID`, `FIX_LESSONS_CLIENT_SECRET`). Background only, below
  the findings and above the history; a run on a repository not known to be private asks for lessons
  drawn on public repositories only. Off without the settings or with `FIX_LESSONS=off`; a failed
  read leaves the brief as it was; the token is masked like the run's other secrets.
- The fix lane's brief carries the repository's earlier fixes by the lane: the newest five
  `## Fix at` comments ci posted on its other pull requests, the findings each answered, and the
  reviewer's next verdict there. Background only, below the findings the run answers; a failed read
  leaves the brief as it was; `FIX_HISTORY=off` turns it off.
- The fleet-status check's expression evaluator reads only its own tables. A function, context or
  property named after something every JavaScript object inherits (`__proto__(x)`, `toString()`,
  a context `constructor`, `github.event.constructor`) used to reach Object.prototype: the fuzzer
  found `__proto__(...)` throwing a TypeError, and the others read as built-ins where Actions has
  none. They are now an unknown function (a plain Error), a missing context or property (null),
  or, when trusted, UNKNOWN.
- `actions/tree-tested` takes `pinned-checkouts`: other repositories a job checks out at a commit
  its own tree names, such as a full sha read from a file of the checkout. The job log must show
  each one checked out at a full commit sha, into a directory of its own under the workspace, and
  at that commit. A checkout of a repository not named there still runs the push in full, as does
  a second checkout of the job's own repository or a "HEAD is now at" line outside a checkout.
  Each checkout's repository, ref and path are read from the inputs the runner prints for it.
- The bump job in `redline-pin-bump.yml` may run 45 minutes, up from 30. Twenty callers at the
  measured rate need about 29 minutes with room to spare, so the next caller would not have fit;
  45 covers thirty. `scripts/redline/pin-bump.test.mjs` now also fails a limit of an hour or more,
  since the App token the job mints lasts an hour.
- The pin bump moves `askalf/redline-rubric` too: it is the twentieth repository in `CALLERS`
  in `redline-pin-bump.yml`, since the rubric is reviewed on the runner host like the others and
  the `askalf-pin-bump` App is installed there. Its review, public-text and post callers are bumped
  with each wave.
- `actions/tree-tested` also requires the pull request's job to have asked for the same runner
  labels as the job asking. A workflow whose `runs-on` depends on who opened the pull request (a
  bot's or a fork's pull request on a hosted runner, its push on a self-hosted one) tested on
  another machine than the push would, so that push runs in full.
- A new action, `actions/tree-tested`: on a push to the default branch it says whether the
  pull request merged as that commit already passed the same workflow, with every job and every
  step green, at a head whose tree is the pushed tree byte for byte, and whether the job asking
  ran there too, with one checkout its log shows was the head merged into a base the head holds. A
  caller declares the job the same on push and on pull request (`same-on-pull-request: true`) and
  skips its build and test steps when the action says so. A direct push, a moved main, a skipped
  or failed job or step, a job the pull request did not run, two checkouts, or a read that fails
  runs the job in full, as before. Replayed job by job against the last eight pushes of four
  repositories on 2026-11-12, it would have skipped 75 of 170 runner minutes. The pin bump moves it like the other actions.
- A second lens, off unless a caller turns it on. A caller on a self-hosted runner that passes
  `second-reviewer-login` gets every head the review approves read once more in the same job, as
  that account, with a second env file and rubric the host keeps for it, and
  `redline-post-verdict.yml` posts that verdict with the `second-reviewer-token` secret. The
  second lens has its own artifact (`redline-verdict-second`), history and round cap, never
  changes the job's result, and approves a pull request that only moves pins without a model call
  once every pin is seen to move in place to a commit on `ci-repo`'s main that is ahead of the
  one it replaces. With it a ruleset can require two approving reviews. Callers that pass nothing new run exactly as before. See "A second lens" in
  `scripts/redline/README.md`.
- A fallback stays inside the reviewer's model family. A review whose model was parked or
  unroutable continued on `REDLINE_FALLBACK_MODEL` whatever that model was, so a host that read on
  one vendor's models could have a review finished by another vendor's without anyone choosing
  that. `review.mjs` now uses the fallback only when it is of the stopped model's family
  (`modelFamily`: `claude`, `gpt`, or an unlisted id's leading name); otherwise the run logs why
  and fails, as it does with no fallback. A host that reads on a family other than Claude sets
  `REDLINE_FALLBACK_MODEL` to a model of that family: the default, `claude-opus-5-5`, no longer
  serves it. The hosted quickstart says how to choose the reviewer's family.
- A starter rubric for hosted mode is public at
  [askalf/redline-rubric](https://github.com/askalf/redline-rubric), linked from the README and
  the hosted quickstart. This repository still ships no prompt.
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
