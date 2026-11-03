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
