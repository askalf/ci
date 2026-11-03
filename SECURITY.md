# Security Policy

askalf/ci holds the mechanics of a gate: reusable workflows that review, fix and re-pin pull
requests on other repositories, and composite actions those repositories' watchers end with.
A report that lets a pull request through the gate, or gives a caller more than the gate
means to give it, gets priority.

## Reporting a vulnerability

Please **do not open a public issue** for security reports.

- **Preferred:** [GitHub private vulnerability reporting](https://github.com/askalf/ci/security/advisories/new),
  which opens a private advisory only the maintainers see.
- **Email:** support@askalf.org with `ci security` in the subject.

You will get an acknowledgement within 72 hours. Please include a minimal reproduction where you can.

## Supported versions

Callers pin a full commit of `main`. Only `main` receives fixes; there are no release branches.
A fix reaches every caller through the pin bump.

## In scope

Anything that breaks a boundary this repository draws:

- A caller pointing the review or the fix at a script that is not a commit on `main` here
- The review running code from the pull request it reads, or a read-only tool writing anything
- The fix lane writing outside the pull request branch it was asked to fix
- A prompt file, a credential file or a token reaching a job's log, a run page, a process argument
  or a pull request
- A fork's pull request being reviewed, or its workflows run, before the contributor gate let it in
- The pin bump rewriting anything in a caller other than the pins it owns
- A drift report or fleet-status action acting on data a pull request controls

## Out of scope

- The verdicts the review gives: a review that approves a change you think it should not have is
  a quality report, not a security one, and belongs in a normal issue
- What a calling repository does with the permissions it grants the called workflow
- Findings that need write access to this repository already

## Threat model

What an adopter should know about the review itself.

- **What the reviewer reads.** The pull request's diff, title, description and commit messages,
  the files of the checked-out head, and earlier reviews of the same pull request. Earlier reviews
  and the context the workflow gathers are handed to the model as data, never as instructions.
- **What it can do.** Four tools, listed in `scripts/redline/tools.json` and pinned with
  truecopy: list, read and search inside the checkout (every path confined to it by its real
  path), and submit the verdict. None of them writes, runs code from the pull request or reaches
  the network.
- **What a finding must carry.** Every finding has to quote text that is in the diff, the pull
  request text or a commit message; a submitted review whose quote is not there is refused and
  sent back to the model, so it is never posted. Text in a pull request that tries to steer the review has to get past that rule and the
  read-only tools.
- **Where the credential lives.** The model endpoint's key is in a file on the self-hosted runner
  host, readable by the account that runs the `redline` runner. It never goes through GitHub.
- **Residual risk: same-repository branches.** A pull request opened from a branch of the calling
  repository runs that branch's version of the caller workflow on the `redline` runner, so anyone
  who can push a branch there can run steps on that runner and read what its account can read,
  the credential file included. We treat write access to a calling repository as trusted. A fork's
  pull request is different: it is reviewed only on a dispatch, after the contributor gate, and
  none of its code runs.
- **Known item: the pin bump's token.** `redline-pin-bump.yml` uses `REDLINE_PIN_BUMP_TOKEN`, a
  long-lived fine-grained token with Contents, Pull requests and Workflows write on every
  repository in `CALLERS`. Moving it to a GitHub App with short-lived installation tokens is
  planned.
