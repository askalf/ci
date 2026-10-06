# Redline in CI

Redline is the gating code review on Sprayberry Labs' public repositories, and this directory is
the whole of it: the review, the first-party fix that answers a review, and the pin that ties each
repository to one commit of both.

## The review: `redline-review.yml` and `review.mjs`

Each repository's `.github/workflows/redline.yml` runs on `pull_request` and calls
`redline-review.yml` at a pinned commit, on that repository's `redline` runner (ephemeral, its own
account, reads only). `review.mjs` gives the model the PR and its diff, read-only tools over the
checkout, and ends when the model submits a verdict. The job's status is the verdict: APPROVE
passes, REQUEST_CHANGES fails. The finished review goes up as the `redline-verdict` artifact and
forge posts it as `sprayberry-redline` after checking where the run came from. The reviewer's brief is
`/etc/askalf/redline-prompt.md` on the runner host, named by `REDLINE_PROMPT_FILE`, never a file in
this repository; `review.test.mjs` runs it all against a stubbed GitHub and model, with the three-line
stand-in in `test-fixtures/`. `tools.json` is `TOOLS` as a file, pinned in the repository's
`truecopy.lock` and verified by `truecopy-gate.yml`; `dump-tools.mjs --check` fails when the two
drift apart. A finding must quote the diff, the PR text or a commit message, or, for a changed file
the diff could not show, that file in the checkout. `redline_search` runs in a child process killed
after 10 seconds, so a pattern that backtracks without end cannot stall the review.

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
- lets the model `fix_list`, `fix_read`, `fix_search`, `fix_write` (inside the checkout, never
  under `.github/`, never a `.gitattributes`, never a file the reviewed head marks `redline-protected`
  in `.gitattributes`, such as captured payloads and vendored code; the marks are read from that
  commit, so nothing the run does to `.gitattributes` lifts them) and `fix_run` an allowlist only: the package.json `test`, `lint`, `typecheck`
  and `build` scripts and `node <file>`, without a shell, in a scrubbed environment, and
  `fix_describe` replace the PR description for a finding on it (whole text, no attribution, no
  em dashes, never when the brief showed only part of the current one);
- runs the test script on the files as they finally are, however they were changed (a test run
  goes stale when a file changes after it, by `fix_write` or by a `node <file>`); a failing suite is bounced to the
  model once, then reported. The bounce, `fix.json` (`tests.failing`) and the notes name the failed
  tests the output reports (TAP `not ok`, jest/vitest `FAIL`); the gate is the exit code alone;
- commits everything changed except `.github/**`, `.gitattributes`, `redline-protected` files,
  files over 1 MB and what the install dirtied, as
  askalf, with a sanitised `fix:` subject and a body naming the review. A command can still change
  a protected file on disk; the commit starts again from the reviewed head, leaves that change out,
  and is checked for a protected path before the bundle is written;
- writes `fix.json` (`outcome`: `fixed`, `no_change`, `tests_failed` or `refused`; the commits,
  files, tests, turns, notes and `description`), `notes.md`, `description.md` when the description
  is replaced, and, for a fix, `fix.bundle` (`<head>..HEAD`). A dry
  run writes `diff.patch` instead of committing.

Limits: 40 turns, 30 files, 400 KB of diff; past any of them the outcome is `refused`. Wall time
counts from the start of the run, install included: at 45 minutes the model must call `finish_fix`,
and no command, test or model call starts past 52 minutes; a run out of time is `refused`, never `fixed`. A
job killed at its 60-minute timeout still uploads a `fix.json` that says so. The job exits 0 only
for `fixed`. `fix-tools.json` is the fixer's `TOOLS` as a file, pinned in `truecopy.lock` like the
reviewer's. The artifact is `redline-fix`. Nothing on the runner can push:
forge verifies the artifact and pushes the commit to the PR branch with its own token, then
comments with the notes. The model key is the named dario key `first-party-fix` in
`/etc/askalf/fix-exec.env`, root:gha-exec 640, readable by the exec account and by no other
(never by gha-oss, which runs untrusted upstream candidates' suites on the same host).
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

The exec account reads the model key, so nothing the checkout supplies may run as it. Each exec
runner gets a run account of its own: one per runner, so a kill or a write never reaches another
repository's job. Below, `gha-exec` stands for the exec runner's account and `gha-exec-run` for its
run account.

1. **The run account.** No login, no home secrets, and not in the group that reads
   `fix-exec.env` and `fix-prompt.md`:
   ```
   useradd --system --no-create-home --shell /usr/sbin/nologin gha-exec-run
   ```
2. **sudo, to that account only.** In `/etc/sudoers.d/redline-fix` (check with `visudo -c`):
   ```
   gha-exec ALL=(gha-exec-run) NOPASSWD: ALL
   ```
   `fix.mjs` runs `sudo -n -u gha-exec-run -- env -i ...` for each command, then, as the same
   account, `kill -KILL -1`, `chmod -R u+rwX` and `setfacl -R -m u:<exec account>:rwX,...`.
   `kill -1` signals all of the account's processes at once, so one that keeps forking cannot
   escape it, and `ps` must then show none alive. The `chmod` and `setfacl` give the exec account
   back whatever the run account locked to itself, and every path must then be reachable. Either
   check failing refuses the run.
3. **ACLs and paths.** The `acl` package, for `setfacl`, on a filesystem mounted with ACL support.
   Every directory above the runner's work directory must be searchable by the run account (`x`),
   and the tool cache setup-node installs into must be readable and searchable by it, since the
   tests run that node. The run account cannot write `.git` and does not own it, so a test that
   runs git in the checkout fails in this lane.
4. **Egress.** The run account reaches a forward proxy and nothing else; dario and every other
   local service included. With nftables:
   ```
   table inet redline_fix {
     chain out {
       type filter hook output priority 0; policy accept;
       meta skuid "gha-exec-run" ip daddr 127.0.0.1 tcp dport 3128 accept
       meta skuid "gha-exec-run" drop
     }
   }
   ```
   The proxy (Squid, for example) allows the package registries the repositories use, such as
   `registry.npmjs.org`, `registry.yarnpkg.com` and `codeload.github.com`, and denies the rest.
   A repository whose tests need the internet fails in this lane.
5. **The env file.** Next to `DARIO_API_KEY` in `/etc/askalf/fix-exec.env`:
   ```
   FIX_RUN_AS=gha-exec-run
   FIX_PROXY=http://127.0.0.1:3128
   ```

Each run proves the setup before it runs anything: sudo to the run account works, the run account
is neither root nor the exec account (`id -u`), it cannot read the env file or the brief, it can
write the checkout, and it cannot write `.git`. Its processes are killed only after it has passed
all of these, so a refused account is never sent `kill -1`. The
script's own git then works on a private copy of `.git`, with a HOME of its own and no global or
system config, so nothing the run account writes (a replaced `.git`, a `.gitconfig`) reaches it. A run
that fails any of these is `refused`, and its notes say which. Without `FIX_RUN_AS` the commands
run as the exec account, and the job log warns that they could read the key.

To check a host by hand, as the exec account:
```
sudo -n -u gha-exec-run -- cat /etc/askalf/fix-exec.env           # Permission denied
sudo -n -u gha-exec-run -- curl -sS -m 5 http://127.0.0.1:3456/   # fails: dario is not reachable
sudo -n -u gha-exec-run -- curl -sS -m 5 https://example.com/      # fails: no direct egress
sudo -n -u gha-exec-run -- env HTTPS_PROXY=http://127.0.0.1:3128 \
  curl -sS -m 10 -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/   # 200
```

## The pin: `pin.mjs` and `redline-pin-bump.yml`

Both callers pin `askalf/ci` by full sha and pass the same sha as `redline-ref`, which the
reusable workflow checks is a commit on `main` before fetching the script at it. A push to `main`
that changes any of this runs `redline-pin-bump.yml`, which rewrites `redline.yml` and, where a
repository has one, `redline-fix.yml` in every caller (this repository's own included) through
`pin.mjs` and opens one bump PR per repository. `node scripts/redline/pin.mjs --caller <sha> <repo>-exec` prints a new repository's
`redline-fix.yml`.
