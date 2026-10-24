# Redline in CI

Redline is the gating code review on Sprayberry Labs' public repositories, and this directory is
the whole of it: the review, the first-party fix that answers a review, and the pin that ties each
repository to one commit of both.

## The review: `redline-review.yml` and `review.mjs`

Each repository's `.github/workflows/redline.yml` runs on `pull_request` and calls
`redline-review.yml` at a pinned commit, on that repository's `redline` runner (ephemeral, its own
account, reads only). `review.mjs` gives the model the PR, its diff and the changed files in full (numbered, up to
120,000 characters in all, larger ones named for `redline_read`), read-only tools over the
checkout, and ends when the model submits a verdict. The job's status is the verdict: APPROVE
passes, REQUEST_CHANGES fails. The finished review goes up as the `redline-verdict` artifact and
forge posts it as `sprayberry-redline` after checking where the run came from. The reviewer's brief is
`/etc/askalf/redline-prompt.md` on the runner host, named by `REDLINE_PROMPT_FILE`, never a file in
this repository; `review.test.mjs` runs it all against a stubbed GitHub and model, with the three-line
stand-in in `test-fixtures/`. `tools.json` is `TOOLS` as a file, pinned in the repository's
`truecopy.lock` and verified by `truecopy-gate.yml`; `dump-tools.mjs --check` fails when the two
drift apart. A finding must quote the diff, the PR text or a commit message, or, for a changed file
the diff could not show, that file in the checkout. The changed files sent in full are there to read, not to quote:
an unchanged line in one cannot carry a finding. A changed file the base commit's root
`.gitattributes` marks `redline-protected` (captured payloads, vendored code) is named in the brief
as captured data: a wording finding on it (its own rule `reads-as-generated`, `ai-attribution` or
`misleading-text`; each finding carries a rule) is sent back once and then dropped, since nobody
writes that text by hand. A correctness or security finding, or a secret, stands there as anywhere, a finding there
with no rule is asked about once and then stands, and a mark the pull request itself adds counts
for nothing until it has merged. A `reads-as-generated` finding (how a sentence reads) is minor
wherever it is, whatever severity the model gave it, and a review that asked for changes only for
such findings approves. `redline_search` runs in a child process killed
after 10 seconds, so a pattern that backtracks without end cannot stall the review.

## Before the push: `local.mjs`

The same review, of a local branch that has no PR head yet, so a round of findings costs a minute
instead of a push, a CI run and a dispatch. `local.mjs pack` runs in the repository to review and
writes a tar to stdout: the change as `review.mjs` reads a PR from GitHub (per-file patches, commits,
the base commit's `.gitattributes`) and the head's tracked files. With `--pr <n>` it also reads that
PR's title, description and Redline's earlier requests through `gh`; without it the title is the
last commit's subject (`--title` and `--body-file` set them). `local.mjs review` runs on the
runner host, where the env file and the prompt are, and calls the same `reviewChange()` with the
same model routing and grounding. It posts nothing; it exits 0 on APPROVE, 1 on REQUEST_CHANGES and
2 when no review finished.

```sh
node <ci checkout>/scripts/redline/local.mjs pack --pr 98 | ssh <runner host> /opt/askalf/redline-local.sh
```

Only committed work is reviewed, against the merge base with origin's default branch (`--base`
names another). A local review spends the same model budget as one in CI, the deep key included
when the change routes there.

## Dashes and credits: `public-text.yml` and `public-text.mjs`

Each repository's `.github/workflows/public-text.yml` runs on `pull_request` and calls
`public-text.yml` at a pinned commit, on a GitHub-hosted runner. `public-text.mjs` reads the PR
through the API (no checkout) and fails when an added line, the title, the description or a commit
message carries an em or en dash, or when the title, the description or a commit message credits a
model or an AI tool (a co-author trailer, a "generated with" footer, a session link), naming every
one. Credits are read in that text only, since code and docs may name these tools for other
reasons. Context and removed lines are never read, and captured data is skipped. It is a workflow of its own because forge posts a review only when the
review run's conclusion agrees with the verdict.

## The fix: `redline-fix-run.yml` and `fix.mjs`

When a review requests changes, forge dispatches the repository's `.github/workflows/redline-fix.yml`
(`workflow_dispatch`: `pr`, `head`, `review`, `dry_run`), which calls `redline-fix-run.yml` at the
same pinned commit on `[self-hosted, <repo>-exec]`, the repository's non-root exec runner. The job
checks that the checkout is exactly the reviewed head, then `fix.mjs`:

- reads the review (the `### N. Blocking:` findings, the `Minor:` list, the inline comments) and
  the PR with the workflow's read-only token;
- installs the checkout's dependencies once (npm, pnpm, yarn or bun, as detected), with
  dependencies' lifecycle scripts skipped (`--ignore-scripts`; for yarn 2 and later the build-skipping flag of the version
  `yarn --version` reports, `--skip-builds` in 2 and `--mode=skip-build` from 3, since a
  `dependenciesMeta` `built: true` overrides `YARN_ENABLE_SCRIPTS`; an unreadable version installs
  nothing);
- lets the model `fix_list`, `fix_read`, `fix_search`, `fix_write` (inside the checkout; under
  `.github/` only a file the pull request itself changes, and never `redline*.yml`, the review's
  and this lane's own workflows; never a `.gitattributes`, never a file the reviewed head marks `redline-protected`
  in `.gitattributes`, such as captured payloads and vendored code; the marks are read from that
  commit, so nothing the run does to `.gitattributes` lifts them) and `fix_run` an allowlist only: the package.json `test`, `lint`, `typecheck`
  and `build` scripts and `node <file>`, without a shell, in a scrubbed environment, and
  `fix_describe` replace the PR description for a finding on it (whole text, no attribution, no
  em dashes, never when the brief showed only part of the current one);
- runs the test script on the files as they finally are, however they were changed (a test run
  goes stale when a file changes after it, by `fix_write` or by a `node <file>`); a failing suite is bounced to the
  model once, then reported. The bounce, `fix.json` (`tests.failing`) and the notes name the failed
  tests the output reports (TAP `not ok`, jest/vitest `FAIL`); the gate is the exit code alone;
- commits everything changed except `.github/**` the PR does not change (and any `.github/**`
  removal), `.gitattributes`, `redline-protected` files, files over 1 MB and what the install dirtied, as
  askalf, with a sanitised `fix:` subject and no body (the review is the run's `review` input
  and in the PR thread). A command can still change a protected file on disk; the commit starts
  again from the reviewed head, leaves that change out, and is checked for a protected path before
  the bundle is written;
- writes `fix.json` (`outcome`: `fixed`, `no_change`, `tests_failed` or `refused`; the commits,
  files, tests, turns, notes and `description`), `notes.md`, `description.md` when the description
  is replaced, and, for a fix, `fix.bundle` (`<head>..HEAD`). A dry
  run writes `diff.patch` instead of committing.

Limits: 40 turns, 30 files, 400 KB of diff; past any of them the outcome is `refused`. Wall time
counts from the start of the run, install included: at 45 minutes the model must call `finish_fix`,
and no command, test or model call starts past 52 minutes; a run out of time is `refused`, never `fixed`. A
job killed at its 60-minute timeout still uploads a `fix.json` that says so. The job exits 0 for
`fixed`, and for `no_change` with `description: true` (the fix was a new description, which the
caller applies); 1 for anything else. `fix-tools.json` is the fixer's `TOOLS` as a file, pinned in `truecopy.lock` like the
reviewer's. The artifact is `redline-fix`. Nothing on the runner can push:
forge verifies the artifact and pushes the commit to the PR branch with its own token, then
comments with the notes. The model is reached through a dario key socket named by `DARIO_SOCKET`
in the env file, so no runner holds the key itself: the socket is the credential, and only the
exec accounts can connect to it, never an account that runs untrusted code. `DARIO_API_KEY` in
the same file still works, and is what a host without the socket uses.
The commands the checkout supplies (the install, the PR's tests, the model's `node <file>`) run
as a separate run account, named by `FIX_RUN_AS` in the env file; see the host setup below. The
script also checks everything that leaves the runner for the key and the read token: the diff,
the staged blobs (a clean filter can stage bytes the working tree lacks; each is sized first,
refused past 1 MB, and an unreadable one is a refusal), `fix.json` and `notes.md`; one carrying
a secret is refused with nothing kept, and the job log masks them.
The fixer's brief is `/etc/askalf/fix-prompt.md` on the same host, named by `FIX_PROMPT_FILE`, with
the env file's owner and mode; `fix.test.mjs` covers the parsing, the sandbox, the allowlist, the
limits, the commit and bundle on a real repository, and both workflows.

## Host setup for the fix lane

The exec account can spend the model key, so nothing the checkout supplies may run as it. Each exec
runner needs, on its host:

- **A run account of its own**, one per runner, so a kill or a write never reaches another
  repository's job. No login, no secrets, and not in the group that reads the env file and the
  brief. The exec account may `sudo -n` to it and to nothing else. `fix.mjs` runs each command as
  `sudo -n -u <run account> -- env -i ...`, then, as the same account, kills every process it has
  (`kill -KILL -1`; `ps` must then show none) and gives the exec account back whatever it locked
  (`chmod`, `setfacl`). Either check failing refuses the run.
- **ACLs**, for `setfacl`, on a filesystem mounted with ACL support. Every directory above the
  runner's work directory, and the tool cache setup-node installs into, must be searchable by the
  run account. The run account cannot write `.git`, so a test that runs git in the checkout fails
  in this lane.
- **Egress through a forward proxy only.** The run account reaches the proxy (`FIX_PROXY`) and
  nothing else, dario and every other local service included. The proxy allows the package
  registries the repositories use and denies the rest; a repository whose tests need the internet
  fails in this lane.
- **dario's key socket**, in a directory the exec accounts can reach and the run accounts cannot.
  Firewall rules do not see unix sockets, so the directory's mode is the guard.
- **The env file**, holding `DARIO_SOCKET` (or `DARIO_API_KEY` on a host without the socket),
  `FIX_RUN_AS` and `FIX_PROXY`.

The concrete accounts, paths, rules and hand checks are kept with the hosts, not here.

Each run proves the setup before it runs anything: sudo to the run account works, the run account
is neither root nor the exec account (`id -u`), it cannot read the env file or the brief or
connect to the key socket, it can write the checkout, and it cannot write `.git`. Its processes are
killed only after it has passed all of these, so a refused account is never sent `kill -1`. The
script's own git then works on a private copy of `.git`, with a HOME of its own and no global or
system config, so nothing the run account writes (a replaced `.git`, a `.gitconfig`) reaches it. A
run that fails any of these is `refused`, and its notes say which. Without `FIX_RUN_AS` the commands
run as the exec account, and the job log warns that they could read the key (or, with the socket,
spend it).

## The pin: `pin.mjs` and `redline-pin-bump.yml`

Both callers pin `askalf/ci` by full sha and pass the same sha as `redline-ref`, which the
reusable workflow checks is a commit on `main` before fetching the script at it. A push to `main`
that changes any of this runs `redline-pin-bump.yml`, which rewrites `redline.yml` and, where a
repository has one, `redline-fix.yml` in every caller (this repository's own included) through
`pin.mjs` and opens one bump PR per repository. `node scripts/redline/pin.mjs --caller <sha> <repo>-exec` prints a new repository's
`redline-fix.yml`.

The commit a bump pins is the newest one on `main` that changes what a caller runs. This
repository's own bump PR moves pins inside those same files (the action pins in the reusable
workflows and the bump workflow), so its merge is not one: a commit whose files read the same
before and after through `pin.mjs --mask`, which hides only the revision of the pins `pin.mjs`
rewrites, is skipped. Without that, each of those merges would start the next wave from the
top of `CALLERS`, and the callers after the first few would never be bumped.

A caller is bumped only when it grants every permission the reusable workflow at the new commit
asks for (`pin.mjs --grants <called.yml> < caller.yml` prints what it lacks). GitHub will not start
a called workflow that asks for more than its caller grants: every run ends in `startup_failure`
before any job runs. So a reusable workflow that needs a new permission lands first, each caller
grants it in a PR of its own, and the next bump moves the pin; until then the bump names each
caller that lacks it, and so does every later run while a caller already pinned there lacks it.
The check reads one plain workflow shape, the one these files are written in (plain keys, the
root at column 0, block jobs, values that close on their line, no tags, anchors, aliases or merge
keys), and refuses any other: a form it does not read is reported, never taken for no permissions.
