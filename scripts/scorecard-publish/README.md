# The Scorecard publish check

`check.mjs` is what `actions/scorecard-publish-check` runs, on `workflow_run` of a repository's
Scorecard workflow. `check.test.mjs` tests it without the network.

## Why

`scorecard-action` signs its results and posts them to scorecard.dev. When that post fails it
retries three times, prints a warning and ends green. The README badge reads scorecard.dev, so a
failed publish shows only as a badge that is stale, or that reads "invalid repo path" when
scorecard.dev serves "not found" for the repository. That happened to askalf/pitlane on
2026-11-09 and lasted fifteen hours, until a clean publish.

## The rules

A run is checked when it is a `workflow_run` that succeeded on the default branch of a public
repository. Any other run is left alone and the step passes: a failed run is already red, a run
on another branch does not publish, and a private repository never does.

For a checked run the script reads `https://api.scorecard.dev/projects/github.com/<owner>/<name>`,
the address the badge reads, up to four times, 15 s apart.

| What scorecard.dev serves | The run was | Outcome |
|---|---|---|
| a result that carries a time of day, no earlier than the run's start less a minute for clock skew | any | published; the step passes |
| anything else: an older result, a date with no time, 404, an error, no answer | `schedule`, `push`, `branch_protection_rule` | the Scorecard workflow is dispatched on the default branch, once, with a warning; the step passes |
| anything else | `workflow_dispatch` | the step fails |

The date. A result the action published is dated to the second: the API served
`2026-11-09T10:25:29Z` and `2026-11-10T01:38:45Z` for askalf/pitlane's publishes of those days. A
date with no time of day is OpenSSF's own weekly scan of the repository, which no run of ours
wrote, so it is never taken for a run's publish, whatever its day.

A dispatch is never answered with another dispatch, so one failed publish costs at most one extra
Scorecard run. The dispatched run is checked like any other when it finishes, and that is where a
publish that fails twice turns red. A dispatch a person sends is held to the same rule: it is not
retried.

The dispatch goes to the workflow file the checked run came from and needs `actions: write` on
the job token. Nothing is checked out and nothing else is written.

The run's facts reach the script as the action's inputs, each defaulting to the `workflow_run`
event's own field, so a caller passes none. The script reads no file. The default branch is used as
GitHub names it and goes into the dispatch as a JSON string. A `workflow_run` that
arrives with no run id fails the step: a runner that did not fill the inputs in must be a red
run, not a check that never checks.

## Dry run

The action's `dry-run: 'true'` prints what would be dispatched and dispatches nothing.
