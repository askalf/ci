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
