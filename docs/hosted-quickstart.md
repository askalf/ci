# Redline on a GitHub-hosted runner: the whole setup

What a repository outside askalf adds to get Redline as its merge gate, with no runner host: two
workflow files, three secrets, one reviewer account and one ruleset. The reference for every input
is the README ([Without a runner host](../README.md#without-a-runner-host)); this page is the
order to do it in.

It applies to a public repository. On a private one the review still runs and passes or fails its
check, but the post that puts the verdict on the pull request does not run.

## 1. The reviewer account

Redline's verdict is posted as an ordinary review, and the ruleset in step 5 waits on that review,
so it has to come from an account that is not the pull request's author.

- Create a second GitHub account for it, or use a GitHub App. Give it write access to the
  repository: an approval from an account without it does not satisfy a required review.
- Make a token for that account that can submit pull request reviews on the repository.

## 2. The secrets

In the repository's Actions secrets:

| Secret | What it is |
|---|---|
| `REDLINE_MODEL_API_KEY` | the model endpoint's key; make one for this, with a spending limit |
| `REDLINE_PROMPT` | the rubric: the reviewer's whole system prompt, your own text, up to 48 KB |
| `REDLINE_REVIEWER_TOKEN` | the reviewer account's token from step 1 |

No rubric yet? [askalf/redline-rubric](https://github.com/askalf/redline-rubric) is a starter to
copy and edit: `gh secret set REDLINE_PROMPT < rubric.md`.

Anyone who can push a branch to the repository can write a workflow that reads the first two, as
with any repository secret. The third is read only by a `workflow_run` job, which runs the default
branch's copy of its file. Dependabot's pull requests read Dependabot secrets, so set the first two
there as well if Redline should review them.

## 3. `.github/workflows/redline.yml`

`<sha>` is one full commit sha of this repository's `main`, the same in both places
(`gh api repos/askalf/ci/commits/main --jq .sha` prints the newest). `<your-login>` is the account
that will dispatch a review by hand, usually yours.

```yaml
name: Redline
# The post finds a dispatched review by this title; keep it exact.
run-name: ${{ github.event_name == 'workflow_dispatch' && format('Redline review {0}#{1} @ {2}{3}', github.repository, inputs.pr, inputs.head, inputs.reread && ' (re-read)' || '') || github.event.pull_request.title }}

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  workflow_dispatch:
    inputs:
      pr:
        description: Pull request number.
        required: true
        type: string
      head:
        description: The full commit sha to review. The run fails if the PR is not at it.
        required: true
        type: string
      reread:
        description: Review the head again even when a Redline verdict already stands there.
        required: false
        default: false
        type: boolean

permissions:
  actions: read
  contents: read
  pull-requests: read

concurrency:
  group: redline-${{ github.event_name }}-${{ github.event.pull_request.number || inputs.pr }}${{ inputs.head && format('-{0}-{1}', inputs.head, inputs.reread) || '' }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  review:
    if: github.event_name == 'workflow_dispatch' || (github.event.pull_request.draft == false && github.event.pull_request.head.repo.full_name == github.repository)
    uses: askalf/ci/.github/workflows/redline-review.yml@<sha>
    with:
      redline-ref: <sha>
      hosted-runner: ubuntu-latest
      model: <a model id your endpoint serves>
      reviewer-login: <the reviewer account's login>
      dispatch-actor: <your-login>
      pr: ${{ inputs.pr }}
      head: ${{ inputs.head }}
      reread: ${{ inputs.reread == true }}
    secrets:
      model-api-key: ${{ secrets.REDLINE_MODEL_API_KEY }}
      reviewer-prompt: ${{ secrets.REDLINE_PROMPT }}
```

The endpoint defaults to `https://api.anthropic.com`; pass `model-url` for another one that
answers the Anthropic Messages API.

## 4. `.github/workflows/redline-post.yml`

The same `<sha>`, the same `reviewer-login` and the same `dispatch-actor` as above.

```yaml
name: Redline post

on:
  workflow_run:
    workflows: [Redline]
    types: [completed]

permissions:
  actions: read
  contents: read
  pull-requests: read

jobs:
  post:
    uses: askalf/ci/.github/workflows/redline-post-verdict.yml@<sha>
    with:
      redline-ref: <sha>
      reviewer-login: <the reviewer account's login>
      dispatch-actor: <your-login>
    secrets:
      reviewer-token: ${{ secrets.REDLINE_REVIEWER_TOKEN }}
```

Merge both files to the default branch before expecting a review: a `workflow_run` workflow runs
only from there.

## 5. The ruleset

On the default branch, require one approving review, and dismiss stale approvals on a new push so
that the approval a merge rides on is of its latest commit. Do not make the `review / redline` job
a required check: the posted review is the gate, and
[What holds a merge](../README.md#what-holds-a-merge) says why the job stays unrequired.

## What a pull request sees

A pull request from a branch of the repository gets a `review / redline` job. When it finishes,
`Redline post` posts its verdict as the reviewer account: an approval, or a request for changes
whose findings each quote the text they are about.

Two cases get no posted review from their own run:

- **A pull request that changes a workflow.** Its own run executed the workflow files it brought,
  so the post refuses it. Review it from the default branch, as the `dispatch-actor` account:

  ```sh
  gh workflow run redline.yml -f pr=<number> -f head=<the PR's head sha>
  ```

- **A pull request from a fork.** It gets no secrets and is not reviewed on `pull_request`. The
  same dispatch reviews it, once its workflows have been let through the contributor gate.

## Keeping the pin current

Nothing moves `<sha>` for you: the pin bump in this repository writes only to the repositories it
lists. Move both files to a newer `main` commit when the changelog names a change you want, in one
commit, keeping the `uses` line and `redline-ref` equal.
