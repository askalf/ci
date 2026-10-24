# Fleet status

The fleet review lanes as two actions. Each repository's `fleet-status.yml` posts two commit
statuses on every pull request head, and a merge waits on both:

| context | green when |
|---|---|
| `fleet/verify` | the PR is docs, assets, `.github` config or a bot branch; or every check the base branch requires has passed at the head; or, where the base branch requires none, the `verified` label is on and askalf's latest `## Verification at <sha>` comment names the head. A fork PR is never verified by the label and comment: where nothing is required, the operator verifies and merges it. |
| `fleet/review` | Redline approved the head. On a code PR, Redline's deterministic low-risk approval is not a verdict, and a same-repo code PR waits on verification first. |

| piece | what it is |
|---|---|
| `actions/fleet-status` | runs `fleet-status.mjs`: reads the PR through the REST API and posts what differs from the head's newest statuses, then reads again and corrects a stale overwrite (three passes at most). `all-open: true` does every open same-repo PR, the backfill. |
| `actions/fleet-status-check` | runs `check.mjs` over a caller's `.github/workflows`, as that repository's `self-test` job. |
| `fleet-status.test.mjs` | the lane rules, and the CLI against a stubbed GitHub. |
| `check.test.mjs` | the checker over `test-fixtures/caller`, a caller that passes, and over copies with one thing broken each. |

## Why the status job may run for a fork

A fork's `pull_request` and `pull_request_review` events run the PR merge ref's workflow with a
read-only token, so they cannot post a status. The lanes reach a fork PR through the events that
run the default branch's workflow with a write token: `issue_comment` (a verification comment),
and `workflow_run` after a fork run of a listed workflow finishes (its CI, or the review relay for
a review). That is safe only because the job runs no PR code: its one step is this action at a
pinned commit, which checks out nothing. `check.mjs` holds every caller to that shape, along with
the job `if:` that keeps a fork's own `pull_request` events out.

## A caller

```yaml
jobs:
  status:
    if: >-
      ...                      # the fork and comment rules; fleet-status-check reads them
    runs-on: ${{ github.repository == 'askalf/<repo>' && fromJSON('["self-hosted","<repo>-exec"]') || 'ubuntu-latest' }}
    permissions:
      contents: read
      pull-requests: read
      issues: read
      checks: read
      statuses: write
    steps:
      - uses: askalf/ci/actions/fleet-status@<sha>
        with:
          pr: ${{ github.event.pull_request.number || github.event.issue.number || github.event.workflow_run.pull_requests[0].number }}
          head-repo: ${{ github.event.workflow_run.head_repository.full_name }}
          head-branch: ${{ github.event.workflow_run.head_branch }}
```

The `workflow_run` list names every workflow that runs on `pull_request` or
`pull_request_target`, so a required check finishing refreshes the lanes; the checker fails a list
that misses one. The home repository and runner label are read from the status job's `runs-on`, so
the same check passes in a fork repository. The checker reads workflows line by line, so it also
fails any line outside the plain YAML it reads (a quoted key, a value continued on the next line, a
flow mapping, an escape in a quoted string, an anchor or alias). Both actions are pinned by full sha and moved by the pin bump, like the Redline
workflows.
