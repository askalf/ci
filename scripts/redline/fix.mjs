// Redline fix: the first-party answer to a Redline REQUEST_CHANGES, computed as a CI job.
//
// One run answers one review at one head. It reads the review (body findings and inline comments)
// and the PR with the workflow's read-only token, installs the checkout's dependencies once, and
// lets the model read, write and run inside the checkout until it calls finish_fix. The edits
// become one commit on top of the reviewed head, written out as a git bundle; nothing here pushes
// or comments. The ops tick verifies the artifact and pushes it with the token it already holds, so no
// token that can write ever sits on the runner.
//
// Output, under FIX_OUT (uploaded as the redline-fix artifact):
//   fix.json     { version, repo, pr, base_head, new_head, outcome, commits, files, tests, turns, model, notes }
//                outcome: fixed | no_change | tests_failed | refused. Always written, whatever happened.
//                run: { id, attempt } is the workflow run and attempt that wrote it, null outside
//                one. The brief's "Fix run" line says the same, so each model call and the
//                artifact name one execution: a rerun keeps the run id and raises the attempt.
//   notes.md     the notes field: markdown for the PR comment the ops tick posts.
//   description.md  the PR's new description, only when fix_describe answered a finding on it
//                (fix.json `description: true`); the ops tick sets it as the PR body.
//   fix.bundle   outcome fixed, not a dry run: the new commit, `git bundle create <base_head>..HEAD`.
//   diff.patch   a dry run, or tests_failed: the staged diff instead of a commit.
// The process exits 0 only for outcome fixed, so the job's own status says whether there is a fix.
//
// Hardening, each with a reason:
//   - The review must be a CHANGES_REQUESTED review of this PR at this head: an old review, a
//     review on another PR, a moved head or a fork PR is refused before the model is called.
//   - A Dependabot PR is refused there too. Its branch is in this repository, but its head brings
//     a package version nobody here wrote, and the tests this run executes would load it beside
//     the run's credentials (install skips package scripts; the tests still import the code).
//   - fix_write stays inside the checkout (symlinks resolved). Under .github/ it writes only a
//     file the pull request itself changes, and never the review's or this lane's own workflow:
//     a workflow change runs with the PR's own permissions on the next push, which the PR's own
//     change to that file already does; a workflow the PR leaves alone, or a new one, is never
//     this lane's to add. The trusted review reads every head before anything merges.
//   - A file the repository marks `redline-protected` in .gitattributes (captured payloads,
//     vendored code, recorded fixtures) is never written by fix_write and never enters the commit.
//     The marks are read from the reviewed head's tree before the install runs and judged in a
//     scratch repository, never in the checkout, so a command that empties a .gitattributes, or
//     stages or commits on its own, cannot lift one. A command may still change a protected file
//     on disk; the commit starts again from the reviewed head and leaves that change out. No
//     .gitattributes is written or committed.
//   - run takes an allowlist only, without a shell: the package.json test, lint, typecheck and
//     build scripts through the detected package manager, and node <file> inside the checkout.
//     Commands run as the runner's account with a scrubbed environment: the GitHub token and the
//     model key are never in a child's environment.
//   - The install skips dependencies' lifecycle scripts (--ignore-scripts; for yarn 2 and later
//     the build-skipping flag of the version `yarn --version` reports, --skip-builds in 2 and
//     --mode=skip-build from 3, since a dependenciesMeta `built: true` overrides
//     YARN_ENABLE_SCRIPTS; a version it cannot read installs nothing): a package's postinstall
//     would otherwise run on the exec runner, as the account that can read the model key, before
//     anything is checked.
//   - Turns, files changed and diff size are bounded; past those the run is refused, never trimmed
//     into a partial fix. Wall time is counted from the start, install included: at timeMs the
//     model must finish, and no command or test runs past hardMs, inside the job's timeout.
//   - Every command the checkout supplies (the install, the tests, node <file>) runs as the run
//     account FIX_RUN_AS names in the env file, through sudo, from an empty environment: not the
//     account that reads FIX_ENV_FILE. Before anything runs, the run account is proved to work,
//     to be neither root nor this account, and to read neither the env file nor the brief; its
//     processes are killed only once it has passed. It gets the checkout to write, its .git
//     read-only, and a HOME of its own. This process's git reads nothing the run account can
//     write: it has a HOME of its own with no global or system config, and works on a private
//     copy of .git, so a command that replaces the checkout's .git (its directory is writable) or
//     writes a .gitconfig cannot make this process's git run its code. After every command the
//     run account's processes are killed, so none can swap a file while this process reads it. FIX_PROXY sends the package managers through the host's proxy; the host's
//     egress rule keeps the run account to that proxy. Without FIX_RUN_AS the commands run as this
//     account, with a warning in the log (README: host setup).
//   - Whatever would leave the runner (the diff, the bundle, fix.json, notes.md and the job log)
//     is checked for the key and the read token: a diff or record that carries one is refused
//     with nothing kept, and the log masks them.
//   - When the repository has a test script it runs at least once after the last edit; a failing
//     suite is bounced to the model once, then reported as tests_failed with no bundle. The bounce,
//     fix.json (tests.failing) and the notes name the failed tests the output reports (TAP
//     `not ok`, jest/vitest `FAIL`). The names are for reading only: the gate is the exit code.
//   - The commit is authored and committed as askalf; its message is one sanitised subject line
//     and no body, checked for trailers before the bundle is written. The review it answers is
//     the run's `review` input.
//   - The model key is read from FIX_ENV_FILE and sent in a header; it is never printed and never
//     in argv. With DARIO_SOCKET there is no key: dario's key socket is the credential, and the run
//     account must not be able to connect to it. The only HTTP made is to api.github.com (reads)
//     and to dario.
//
// CLI (the workflow's fix step):
//   REPO=owner/name PR=<n> HEAD_SHA=<sha> REVIEW_URL=<review html_url> CHECKOUT=<dir> \
//   GH_READ_TOKEN=... FIX_ENV_FILE=/etc/askalf/fix-exec.env FIX_PROMPT_FILE=/etc/askalf/fix-prompt.md \
//   FIX_OUT=<dir> [DRY_RUN=1] node fix.mjs
// The env file holds DARIO_SOCKET (dario's key socket for the fix lane's named key) or
// DARIO_API_KEY (that key itself), and optionally DARIO_URL
// (default http://127.0.0.1:3456), FIX_MODEL (default claude-opus-5-5) and FIX_EFFORT (unset by
// default; see fixEffort for the rounds it applies to). FIX_PROMPT_FILE names the
// system prompt, installed on the runner host: this repository is public and carries no prompt, so
// there is no bundled fallback, and a variable that is unset, a file that cannot be read or an empty
// file ends the run.
//
// build.mjs is a second entry point on the same work in the checkout (workCheckout, hostSetup and
// runToExit below). It starts from a ticket and a base commit where this one starts from a review
// and a head; the run account, the allowlist, the test gate, the limits, the secret checks and the
// commit are this file's, so what is said of them above holds there too.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, lstatSync, realpathSync, statSync, readdirSync, appendFileSync, mkdtempSync, readlinkSync, cpSync, chmodSync } from 'node:fs';
import { join, resolve, relative, dirname, basename, sep, posix } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseEnvFile, readPrompt, safePath, runTool as readTool, rejectsForcedToolChoice, metaPhrase, gh, ghAll, callModelWith, buildDiff, OutOfTime, darioAccess, withDarioSocket, PROTECTED_ATTR, protectedFromCheckAttr } from './review.mjs';
export { PROTECTED_ATTR, protectedFromCheckAttr };

export const AUTHOR = { name: 'askalf', email: '263217947+askalf@users.noreply.github.com' };
export const DEFAULT_MODEL = 'claude-opus-5-5';

/** The levels FIX_EFFORT may name, lowest first: the wire values of `output_config.effort`. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The effort one fix round runs at. A round is counted from the reviewer's change requests on the
 * pull request (priorRounds), not from fix runs: one with no earlier change request runs at
 * FIX_EFFORT, and one after an earlier change request runs at `high`, or at FIX_EFFORT when that
 * is higher. An earlier change request does not prove that a fix ran for it, or at what level; the
 * author may have answered it by hand, and then the first fix run is already at `high`. Unset or
 * not a level: undefined, and the request carries no effort field, exactly as before.
 */
export function fixEffort(setting, rounds) {
  const s = String(setting ?? '').trim().toLowerCase();
  if (!EFFORT_LEVELS.includes(s)) return undefined;
  if (!(rounds > 0)) return s;
  return EFFORT_LEVELS.indexOf(s) >= EFFORT_LEVELS.indexOf('high') ? s : 'high';
}

/**
 * The rounds before this one: earlier change requests on the pull request from the reviewer who
 * wrote the review being answered. Review ids grow with time, so earlier means a smaller id.
 */
export function priorRounds(reviews, current) {
  const who = current?.user?.login;
  if (!who || !Number.isInteger(current?.id)) return 0;
  return (Array.isArray(reviews) ? reviews : []).filter((r) => r && r.state === 'CHANGES_REQUESTED'
    && r.user?.login === who && Number.isInteger(r.id) && r.id < current.id).length;
}

/** Pages of 100 reviews read before the round is taken as unknown. */
export const REVIEW_PAGES_MAX = 30;

/**
 * The rounds before the review being answered, read from the pull request's reviews page by page.
 * GitHub lists them oldest first, so the scan ends at the page that holds the review being
 * answered, or at the last page. It never stops at a fixed count: a change request on page four
 * is an earlier round like one on page one. Past maxPages with the answered review not yet seen,
 * the count is unknown and `capped` is true; the caller then treats the run as a later round, so
 * the cap can only cost effort, never quality.
 */
export async function reviewRounds(ctx, repo, n, current, maxPages = REVIEW_PAGES_MAX) {
  let rounds = 0;
  for (let page = 1; page <= maxPages; page++) {
    const rows = await gh(ctx, `/repos/${repo}/pulls/${n}/reviews?per_page=100&page=${page}`);
    const list = Array.isArray(rows) ? rows : [];
    rounds += priorRounds(list, current);
    if (list.length < 100 || list.some((r) => r?.id === current?.id)) return { rounds, capped: false };
  }
  return { rounds, capped: true };
}
// Dependabot by its exact login in each API's spelling (REST, GraphQL, gh), never a substring.
export const DEPENDABOT_AUTHOR = /^(app\/)?dependabot(\[bot\])?$/i;
export const FIX_VERSION = 1;
export const OUTCOMES = ['fixed', 'no_change', 'tests_failed', 'refused'];
export const SCRIPTS = ['test', 'lint', 'typecheck', 'build'];
export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'];
export const LIMITS = {
  turns: 40, forceFinishAt: 36, timeMs: 45 * 60_000, hardMs: 52 * 60_000, files: 30, diffBytes: 400_000, fileBytes: 1_000_000,
  writeBytes: 400_000, runDefaultS: 600, runMaxS: 900, installS: 600, runOutChars: 16_000,
  maxTokens: 16_000, modelTimeoutMs: 240_000, textOnlyTurns: 3, testBounces: 1,
  notesChars: 6_000, bodyChars: 8_000, diffChars: 120_000, subjectChars: 72, descriptionChars: 20_000,
};

// ---------- the review ----------

/** https://github.com/o/r/pull/7#pullrequestreview-123 -> { repo: 'o/r', pr: 7, id: 123 }, else null. */
export function parseReviewUrl(url) {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)#pullrequestreview-(\d+)$/.exec(String(url ?? '').trim());
  return m ? { repo: m[1], pr: Number(m[2]), id: Number(m[3]) } : null;
}

function splitPlace(place) {
  const m = /^(.*?):(\d+)$/.exec(String(place).trim());
  return m ? { file: m[1], line: Number(m[2]) } : { file: String(place).trim(), line: null };
}

/**
 * Redline's review body as findings: `### N. Blocking: \`file:line\`` sections (quote lines, the
 * problem, an optional fenced "Suggested fix:"), then the `Minor:` list. Tolerant: a body with
 * neither becomes one blocking finding carrying the whole text, so a hand-written review is still
 * answered. Returns { summary, findings: [{ n, severity, file, line, quote, problem, suggestion }], rule }.
 */
export function parseReviewBody(body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  const findings = [];
  const heads = [...text.matchAll(/^### (\d+)\. (Blocking|Minor): `([^`\n]+)`\s*$/gm)];
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    const end = i + 1 < heads.length ? heads[i + 1].index : text.length;
    let section = text.slice(h.index + h[0].length, end);
    const cut = section.search(/^(?:Minor:\s*$|rule:[a-z0-9-]+\s*$|<!-- redline:head=|_[^_\n]+_\s*$)/m);
    if (cut >= 0) section = section.slice(0, cut);
    const quote = section.split('\n').filter((l) => l.startsWith('>')).map((l) => l.replace(/^> ?/, '')).join('\n').trim();
    let rest = section.split('\n').filter((l) => !l.startsWith('>')).join('\n');
    let suggestion = '';
    const sug = /\n\s*Suggested fix:\s*\n\s*(`{3,})[^\n]*\n([\s\S]*?)\n\1[ \t]*(?:\n|$)/.exec(rest);
    if (sug) { suggestion = sug[2].trim(); rest = rest.slice(0, sug.index); }
    const { file, line } = splitPlace(h[3]);
    findings.push({ n: Number(h[1]), severity: h[2].toLowerCase(), file, line, quote, problem: rest.trim(), suggestion });
  }
  const minorAt = /^Minor:\s*$/m.exec(text);
  if (minorAt) {
    for (const l of text.slice(minorAt.index + minorAt[0].length).split('\n')) {
      const m = /^- `([^`]+)`: (.*)$/.exec(l);
      if (!m) { if (l.trim()) break; continue; }
      const { file, line } = splitPlace(m[1]);
      findings.push({ n: findings.length + 1, severity: 'minor', file, line, quote: '', problem: m[2].trim(), suggestion: '' });
    }
  }
  const summary = (/^\*\*Verdict: [^*\n]+\*\*\s*(.*)$/m.exec(text)?.[1] ?? '').trim();
  const rule = /^rule:([a-z0-9-]+)\s*$/m.exec(text)?.[1] ?? null;
  if (!findings.length) {
    const plain = text.replace(/<!-- redline:head=[0-9a-f]+ -->/g, '').trim();
    if (plain) findings.push({ n: 1, severity: 'blocking', file: null, line: null, quote: '', problem: plain, suggestion: '' });
  }
  return { summary, findings, rule };
}

/** The review's inline comments as items: { path, line, body }; empty bodies dropped. */
export function inlineItems(comments) {
  return (Array.isArray(comments) ? comments : [])
    .map((c) => ({ path: String(c.path ?? ''), line: c.line ?? c.original_line ?? null, body: String(c.body ?? '').trim() }))
    .filter((c) => c.body);
}

// ---------- this repository's fix history ----------

/** How much of the repository's earlier fixes the brief carries. */
export const HISTORY = { fixes: 5, notesChars: 1_200, findings: 6, problemChars: 200, reviewPages: 10 };
/** The account ci posts its fix comments as, and the heading of an applied fix (askalf/platform apps/ci/src/runtime/fix-ci.ts). */
export const FIX_POSTER = 'askalf';
export const FIX_APPLIED_HEADING = '## Fix at';

/**
 * The lane's applied fixes on the repository's other pull requests, newest first: the comments ci
 * posted as FIX_POSTER under `## Fix at <head>`, each with the fixer's notes. `comments` is the
 * repository's issue comments, newest first. Pure.
 */
export function appliedFixComments(comments, currentPr, max = HISTORY.fixes) {
  const out = [];
  for (const c of Array.isArray(comments) ? comments : []) {
    if (out.length >= max) break;
    if (c?.user?.login !== FIX_POSTER) continue;
    const body = String(c.body ?? '').replace(/\r\n/g, '\n');
    const m = /^## Fix at ([0-9a-f]{7,40})[ \t]*(?:\n|$)/.exec(body);
    if (!m) continue;
    const pr = Number(/\/issues\/(\d+)$/.exec(String(c.issue_url ?? ''))?.[1]);
    if (!Number.isSafeInteger(pr) || pr <= 0 || pr === currentPr) continue;
    const at = Date.parse(String(c.created_at ?? ''));
    if (!Number.isFinite(at)) continue;
    out.push({ pr, head: m[1], at, notes: body.slice(m[0].length).trim() });
  }
  return out;
}

/**
 * What the reviewer asked before a fix and said next after it, from that pull request's reviews:
 * the reviewer's last change request at or before the fix, and the first approval or change request
 * after it. Pure.
 */
export function fixVerdicts(reviews, at, reviewer) {
  const by = (Array.isArray(reviews) ? reviews : [])
    .filter((r) => r?.user?.login === reviewer && Number.isFinite(Date.parse(String(r.submitted_at ?? ''))))
    .sort((a, b) => Date.parse(a.submitted_at) - Date.parse(b.submitted_at));
  const asked = by.filter((r) => r.state === 'CHANGES_REQUESTED' && Date.parse(r.submitted_at) <= at).at(-1) ?? null;
  const next = by.find((r) => Date.parse(r.submitted_at) > at && (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED')) ?? null;
  return { asked, next: next === null ? 'no verdict yet' : next.state === 'APPROVED' ? 'approved' : 'changes requested again' };
}

/** One finding of an earlier review, on one line. Pure. */
export function historyFinding(f) {
  const place = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ''}` : '';
  const problem = String(f.problem ?? '').replace(/\s+/g, ' ').trim().slice(0, HISTORY.problemChars);
  return `${f.severity}${place}: ${problem}`;
}

/**
 * Every review of a pull request, page by page: GitHub lists them oldest first, so the change
 * request a fix answered and the verdict after it can sit past the first page. Null when the pull
 * request has more than maxPages pages: an entry read in part could pair the fix with the wrong
 * findings and verdict, so it is left out instead.
 */
export async function allReviews(ctx, repo, pr, maxPages = HISTORY.reviewPages) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const rows = await gh(ctx, `/repos/${repo}/pulls/${pr}/reviews?per_page=100&page=${page}`);
    const list = Array.isArray(rows) ? rows : [];
    out.push(...list);
    if (list.length < 100) return out;
  }
  return null;
}

/**
 * The repository's earlier fixes by this lane: one read of its newest issue comments, then each
 * fixed pull request's reviews (allReviews), at most HISTORY.fixes of them; a pull request with more
 * reviews than allReviews reads is left out. Every entry is the repository's own pull request
 * history, which anyone who can read the repository can read.
 */
export async function repoFixHistory(ctx, repo, currentPr, reviewer) {
  const comments = await gh(ctx, `/repos/${repo}/issues/comments?sort=created&direction=desc&per_page=100`);
  const out = [];
  for (const f of appliedFixComments(comments, currentPr)) {
    const reviews = await allReviews(ctx, repo, f.pr);
    if (reviews === null) continue;
    const { asked, next } = fixVerdicts(reviews, f.at, reviewer);
    const findings = asked ? parseReviewBody(asked.body).findings.slice(0, HISTORY.findings).map(historyFinding) : [];
    out.push({ pr: f.pr, next, findings, notes: f.notes.slice(0, HISTORY.notesChars) });
  }
  return out;
}

/** One earlier fix as brief lines. Pure. */
export function formatHistory(h) {
  return [
    `- PR #${h.pr}; the reviewer's next verdict: ${h.next}`,
    `  Asked: ${h.findings.length ? h.findings.join(' | ') : '(the change request it answered was not found)'}`,
    `  The fix's notes: ${String(h.notes).replace(/\n+/g, ' ').trim() || '(none)'}`,
  ].join('\n');
}

// ---------- lessons from earlier fixes ----------

/** How many lessons the brief carries, each cut to textChars; the text they are matched on; the read's time limit. */
export const LESSONS = { k: 5, textChars: 300, queryChars: 6_000, timeoutMs: 8_000 };

/**
 * Where the lessons read goes, from the env file: FIX_LESSONS_URL (https only),
 * FIX_LESSONS_CLIENT_ID and FIX_LESSONS_CLIENT_SECRET, the lessons service's own access token. Null
 * when any is missing or FIX_LESSONS=off: the brief then goes without lessons. Pure.
 */
export function lessonsAccess(secrets) {
  if (String(secrets?.FIX_LESSONS ?? '').trim().toLowerCase() === 'off') return null;
  const url = String(secrets?.FIX_LESSONS_URL ?? '').trim();
  const id = String(secrets?.FIX_LESSONS_CLIENT_ID ?? '').trim();
  const secret = String(secrets?.FIX_LESSONS_CLIENT_SECRET ?? '').trim();
  if (!url || !id || !secret) return null;
  try { if (new URL(url).protocol !== 'https:') return null; } catch { return null; }
  return { url, id, secret };
}

/** The text a lessons read is matched on: the review's summary, each finding, each inline comment, cut. Pure. */
export function lessonQuery(review, items) {
  return [
    review?.summary ?? '',
    ...(review?.findings ?? []).map((f) => [f.file ?? '', f.problem ?? '', f.suggestion ?? ''].join(' ')),
    ...(items ?? []).map((c) => c.body ?? ''),
  ].join('\n').slice(0, LESSONS.queryChars);
}

/**
 * Lessons this lane drew from its earlier fixes that fell short (general advice, written without
 * names or paths), matching this review, at most LESSONS.k. isPublic asks for lessons drawn on
 * public repositories only. A redirect is an answer, never followed: it means the token was not
 * taken. Throws on any failure; the caller leaves the brief as it was.
 */
export async function fetchLessons(ctx, text, isPublic) {
  const res = await ctx.fetch(ctx.lessons.url, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json', 'cf-access-client-id': ctx.lessons.id, 'cf-access-client-secret': ctx.lessons.secret },
    body: JSON.stringify({ text, public: isPublic, k: LESSONS.k }),
    signal: AbortSignal.timeout(LESSONS.timeoutMs),
  });
  if (res.status !== 200) throw new Error(`the lessons read answered ${res.status}`);
  const v = await res.json();
  return (Array.isArray(v?.lessons) ? v.lessons : [])
    .map((l) => String(l?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, LESSONS.textChars))
    .filter(Boolean)
    .slice(0, LESSONS.k);
}

export function formatFinding(f) {
  const where = f.file ? ` \`${f.file}${f.line ? `:${f.line}` : ''}\`` : '';
  const parts = [`[${f.n}] ${f.severity}${where}`];
  if (f.quote) parts.push(f.quote.split('\n').map((l) => `> ${l}`).join('\n'));
  parts.push(f.problem || '(no text)');
  if (f.suggestion) parts.push(`Suggested fix:\n${f.suggestion}`);
  return parts.join('\n');
}

// ---------- the toolchain ----------

/**
 * From the checkout's root listing and its package.json: which package manager, which of the
 * SCRIPTS exist, the install command and the variables it runs with (installEnv). No package.json:
 * { pm: null, scripts: [], install: null },
 * and run then takes node <file> only. A `packageManager` field wins over lockfiles.
 */
export function detectRunner(rootFiles, pkg) {
  const files = new Set(rootFiles ?? []);
  if (!pkg || typeof pkg !== 'object') return { pm: null, scripts: [], install: null };
  const declaredAt = /^(npm|pnpm|yarn|bun)@(\d+)?/.exec(String(pkg.packageManager ?? ''));
  const declared = declaredAt?.[1];
  const pm = declared ?? (files.has('pnpm-lock.yaml') ? 'pnpm' : files.has('yarn.lock') ? 'yarn' : (files.has('bun.lockb') || files.has('bun.lock')) ? 'bun' : 'npm');
  const scripts = SCRIPTS.filter((s) => typeof pkg.scripts?.[s] === 'string' && pkg.scripts[s].trim());
  // Yarn 2 and later (Berry) take neither --frozen-lockfile nor --ignore-scripts. The flag that
  // skips builds depends on the version (berryInstall), read from `yarn --version` before the
  // install; YARN_ENABLE_SCRIPTS=false is set as well, but a dependenciesMeta `built: true`
  // overrides it, so it is never the only guard.
  const berry = pm === 'yarn' && (files.has('.yarnrc.yml') || (declared === 'yarn' && Number(declaredAt[2]) >= 2));
  // Dependencies' lifecycle scripts never run: see the hardening note at the top.
  const install = {
    npm: files.has('package-lock.json') ? ['npm', 'ci', '--no-audit', '--no-fund', '--ignore-scripts'] : ['npm', 'install', '--no-audit', '--no-fund', '--ignore-scripts'],
    pnpm: ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'],
    yarn: berry ? ['yarn', 'install', '--immutable'] : ['yarn', 'install', '--frozen-lockfile', '--ignore-scripts'],
    bun: ['bun', 'install', '--frozen-lockfile', '--ignore-scripts'],
  }[pm];
  return { pm, scripts, install, berry, installEnv: berry ? { YARN_ENABLE_SCRIPTS: 'false' } : {} };
}

/**
 * Yarn Berry's install for the version `yarn --version` printed: --skip-builds in 2, renamed
 * --mode=skip-build in 3. Null for anything else, so an unknown version installs nothing rather
 * than running dependencies' builds. Pure.
 */
export function berryInstall(versionOutput) {
  const major = Number(/^\s*(\d+)\.\d+\.\d+\s*$/m.exec(String(versionOutput ?? ''))?.[1]);
  if (major === 2) return ['yarn', 'install', '--immutable', '--skip-builds'];
  if (major >= 3) return ['yarn', 'install', '--immutable', '--mode=skip-build'];
  return null;
}

/** The allowlist as the model sees it. */
export function allowedCommands(plan) {
  const out = [];
  if (plan.pm) for (const s of plan.scripts) out.push(s === 'test' ? `${plan.pm} test` : `${plan.pm} run ${s}`);
  out.push('node <file>', 'node --test <file>');
  return out;
}

/**
 * A run command against the allowlist: { argv } or { error }. No shell is ever involved, so the
 * command is split on whitespace and any quoting, redirection, chaining or expansion character
 * is refused outright. node takes one file inside the checkout, optionally after --test.
 */
export function allowedArgv(command, plan, root) {
  const s = String(command ?? '').trim();
  if (!s) return { error: 'command is empty' };
  if (/[;&|<>$`'"(){}\\\n\r*?~!#%^]/.test(s)) return { error: 'the command runs without a shell: no quoting, redirection, chaining or expansion' };
  const [bin, ...rest] = s.split(/\s+/);
  const list = `the allowed commands are: ${allowedCommands(plan).join(', ')}`;
  if (plan.pm && bin === plan.pm) {
    if (rest.length === 1 && rest[0] === 'test' && plan.scripts.includes('test')) return { argv: [bin, 'test'] };
    if (rest.length === 2 && rest[0] === 'run' && SCRIPTS.includes(rest[1]) && plan.scripts.includes(rest[1])) return { argv: [bin, 'run', rest[1]] };
    return { error: `not in the allowlist; ${list}` };
  }
  if (bin === 'node') {
    const flags = rest.slice(0, -1);
    const file = rest.at(-1);
    if (!file || flags.some((f) => f !== '--test')) return { error: 'node takes one file inside the checkout, optionally after --test' };
    let abs;
    try { abs = safePath(root, file); } catch (e) { return { error: e.message }; }
    if (lstatSync(abs).isDirectory()) return { error: 'that is a directory, not a file' };
    return { argv: ['node', ...flags, relative(realpathSync(root), abs).split(sep).join('/')] };
  }
  return { error: `not in the allowlist; ${list}` };
}

// ---------- the filesystem ----------

/**
 * The attribute a repository sets on files that are data, not code: a payload captured from a
 * live system and rebuilt by a script, vendored code, a recorded fixture. Their text is what was
 * captured, so a review finding about it is answered by declining that finding, never by an edit
 * (dario's src/cc-template-data.json is Claude Code's own request as captured; a hand edit would
 * change the wire dario sends). A repository opts a path in with `<pattern> redline-protected`.
 */
// PROTECTED_ATTR and protectedFromCheckAttr come from review.mjs: the reviewer reads the same mark.

/** The review's and this lane's own workflows: never written from here, whatever the PR changes. */
export const LANE_WORKFLOWS = /^\.github\/workflows\/redline[^/]*\.ya?ml$/;

/**
 * The paths under .github/ a run may write: the files the pull request itself changes and that
 * exist at its head (added, modified or renamed; a removed one has no file to write), except the
 * lane's own workflows. A workflow this lane changed runs with the PR's own permissions on the
 * next push, which the PR's own change to that file already does; a file the PR leaves alone, or
 * a new one, is never this lane's to add. Pure: `files` is the compare of the PR's base with the
 * reviewed head (headCompare), `atHead` that head's own blobs (headBlobs). A path counts only when
 * the reviewed tree holds it as a regular file with the very blob the compare names, so a file a
 * later push added or changed is never in the set, whatever any files list said.
 */
export function editableGithub(files, atHead = new Map()) {
  const out = new Set();
  for (const f of Array.isArray(files) ? files : []) {
    const p = String(f?.filename ?? '');
    if (/^\.github\//.test(p) && f?.status !== 'removed' && !LANE_WORKFLOWS.test(p) && f?.sha && atHead.get(p) === f.sha) out.add(p);
  }
  return out;
}

/**
 * The PR's changed files as of the reviewed head: the compare of the base with that commit, which
 * no later push can change (the PR's files list follows the PR's current head instead). The
 * compare stops at 300 files; a .github file past that is simply not writable.
 */
export async function headCompare(ctx, repo, baseSha, headSha) {
  const c = await gh(ctx, `/repos/${repo}/compare/${baseSha}...${headSha}`);
  return Array.isArray(c?.files) ? c.files : [];
}

/**
 * Why a checkout-relative path may not be written, or '' when it may. `github` is editableGithub's
 * set, or null for a run that writes nothing under .github/ at all (the build lane: it has no pull
 * request whose own files it could be held to). `lane` names the lane in the reasons. Pure.
 */
function writeRule(rel, github = new Set(), lane = 'fix lane') {
  if (/(^|\/)(?:\.git|node_modules)(?:\/|$)/.test(rel)) return 'path is under .git or node_modules';
  if (github === null && /^\.github(?:\/|$)/.test(rel)) return `nothing under .github/ is written by the ${lane}`;
  if (LANE_WORKFLOWS.test(rel)) return 'the review and fix workflows are never written by the fix lane';
  if (/^\.github(?:\/|$)/.test(rel) && !github.has(rel)) return 'under .github/ the fix lane writes only a file this pull request already changes';
  if (/(?:^|\/)\.gitattributes$/.test(rel)) return `.gitattributes is never written by the ${lane}`;
  return '';
}

/**
 * Where a write to `abs` lands, relative to the real checkout: the existing part of the path
 * resolved through its symlinks, the rest as given. A directory symlink inside the checkout
 * (`alias -> data`) makes `alias/payload.json` land on `data/payload.json`, so every rule about
 * where a write may go is checked on this path as well as on the one the model named.
 */
export function landingPath(root, abs) {
  const rootReal = realpathSync(root);
  let dir = abs;
  const tail = [];
  while (!existsSync(dir)) { tail.unshift(basename(dir)); dir = dirname(dir); }
  return relative(rootReal, join(realpathSync(dir), ...tail)).split(sep).join('/');
}

/**
 * Resolve a path the model wants to write. Inside the checkout, symlinks included; never under
 * .git or node_modules, under .github only a path in `github` (editableGithub: the files the PR
 * changes, less the lane's own workflows; null: nothing there at all) and never a .gitattributes,
 * checked on the path as named and on where it lands through any directory symlink. Returns the
 * absolute path or throws.
 */
export function safeWritePath(root, p, github = new Set(), lane = 'fix lane') {
  const rel = posix.normalize(String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, ''));
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../')) throw new Error('path is outside the checkout');
  const named = writeRule(rel, github, lane);
  if (named) throw new Error(named);
  const rootReal = realpathSync(root);
  const abs = resolve(rootReal, rel);
  const inside = (x) => x === rootReal || x.startsWith(rootReal + sep);
  if (!inside(abs)) throw new Error('path is outside the checkout');
  let dir = dirname(abs);
  while (!existsSync(dir)) dir = dirname(dir);
  if (!inside(realpathSync(dir))) throw new Error('path resolves outside the checkout');
  let st = null;
  try { st = lstatSync(abs); } catch { /* a new file */ }
  if (st?.isSymbolicLink()) throw new Error('path is a symlink');
  if (st?.isDirectory()) throw new Error('path is a directory');
  const landed = writeRule(landingPath(root, abs), github, lane);
  if (landed) throw new Error(`${landed} (through a directory symlink)`);
  return abs;
}

/**
 * Which changed paths become the commit. Everything the checkout shows as changed is staged
 * (`git add -A`) except: paths under .github/ that are not in `github` (editableGithub's set; null
 * leaves out every path there), a .gitattributes, paths marked redline-protected (`protectedSet`),
 * files over LIMITS.fileBytes, and paths the install step dirtied that the model did not write (a
 * lockfile rewritten by npm is not the fix). `work` names what the run produces in that last
 * reason. Pure: `sizeOf(path)` supplies sizes. Returns { keep, skipped: [{ path, why }] }.
 */
export function stageable(paths, { installDirty = [], written = new Set(), sizeOf = () => 0, protectedSet = new Set(), github = new Set(), work = 'fix' } = {}) {
  const keep = [];
  const skipped = [];
  for (const p of paths) {
    if (/^\.github(?:\/|$)/.test(p) && !github?.has(p)) skipped.push({ path: p, why: github === null ? 'under .github/' : 'under .github/ and not a file the PR changes' });
    else if (/(?:^|\/)\.gitattributes$/.test(p)) skipped.push({ path: p, why: 'a .gitattributes' });
    else if (protectedSet.has(p)) skipped.push({ path: p, why: `marked ${PROTECTED_ATTR}` });
    else if (installDirty.includes(p) && !written.has(p)) skipped.push({ path: p, why: `changed by the install, not by the ${work}` });
    else if (sizeOf(p) > LIMITS.fileBytes) skipped.push({ path: p, why: `larger than ${LIMITS.fileBytes} bytes` });
    else keep.push(p);
  }
  return { keep, skipped };
}

// ---------- public text ----------

/** A trailer or credit line that never goes into a commit or a comment from this lane. */
export const TRAILER_LINE = /^\s*(?:Co-Authored-By|Signed-off-by|Generated (?:with|by)|Made with|Claude-Session|Reviewed-by)\b.*$/i;
/** Words a commit subject from this lane never carries; a subject with one falls back to the default. */
export const SUBJECT_BANNED = /co-authored|signed-off|generated|\bclaude\b|\banthropic\b|\bopenai\b|\bgpt\b|\bcopilot\b|\bcodex\b|\bgemini\b|\bAI\b|\bLLM\b|\bmodel\b|\bprompt\b|\bredline\b/i;
const CLOSERS = /\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\b\s*:?\s*(?:[\w.-]+\/[\w.-]+)?#\d+/gi;

/**
 * One line from the model as a commit subject's text: the first line, with issue closers and refs,
 * links, em dashes and trailing punctuation removed, and cut at a word to `max` characters. The
 * model's own prefix (`fix:`, `docs(x)!:`) is removed unless `keepPrefix`; a prefix kept with
 * nothing after it is no subject. A line with nothing left, or one `banned` matches (by default
 * SUBJECT_BANNED: a credit to a tool, or a name of the machinery), is replaced by `fallback`. Pure.
 */
export function cleanSubject(line, { keepPrefix = false, fallback, max, banned = SUBJECT_BANNED }) {
  let s = String(line ?? '').split('\n')[0].trim();
  s = s.replace(/\s*[\u2013\u2014]\s*/g, ', ').replace(/\s+/g, ' ');
  if (!keepPrefix) s = s.replace(/^(?:fix|feat|chore|refactor|docs|test|ci|build|perf|style)(?:\([^)]*\))?!?:\s*/i, '');
  s = s.replace(CLOSERS, '').replace(/(?:[\w.-]+\/[\w.-]+)?#\d+/g, '').replace(/https?:\/\/\S+/g, '').replace(/\(\s*\)/g, '');
  s = s.replace(/\s{2,}/g, ' ');
  const bare = keepPrefix && /^[\w.-]+(?:\([^)]*\))?!?:[\s.,:;-]*$/.test(s.trim());
  s = s.replace(/^[\s,:;-]+|[\s.,:;-]+$/g, '');
  if (!s || bare || banned.test(s)) s = fallback;
  if (s.length > max) s = s.slice(0, max).replace(/\s+\S*$/, '').replace(/[\s.,:;-]+$/, '');
  return s;
}

/**
 * The commit subject: `fix: <one line from the model>`, with the model's own prefix, issue
 * closers and refs, em dashes and trailing punctuation removed, and capped. A line that credits
 * a tool or names the machinery is replaced by the default.
 */
export function commitSubject(line) {
  return `fix: ${cleanSubject(line, { fallback: 'address the review', max: LIMITS.subjectChars - 'fix: '.length })}`;
}

/** Whether a commit message carries an attribution trailer. Checked on the commit itself before the bundle. */
export function hasAttributionTrailer(message) {
  return /^(?:Co-Authored-By|Signed-off-by|Claude|Generated)/im.test(String(message ?? ''));
}

/**
 * A bare `#12` or `owner/repo#12` outside code becomes a code span so the comment links no
 * unrelated issue. Fenced blocks and inline code are left as they are.
 */
export function neutraliseRefs(md) {
  const out = [];
  let fenced = false;
  for (const line of String(md ?? '').split('\n')) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) { fenced = !fenced; out.push(line); continue; }
    if (fenced) { out.push(line); continue; }
    out.push(line.split(/(`+[^`]*`+)/).map((part, i) => (i % 2 ? part : part.replace(/(^|[^\w`&#])((?:[\w.-]+\/[\w.-]+)?#\d+)\b/g, '$1`$2`'))).join(''));
  }
  return out.join('\n');
}

/** Notes fit for the PR comment: no trailer lines, no em dashes, refs neutralised, capped. */
export function cleanNotes(md) {
  let s = String(md ?? '').replace(/\r\n/g, '\n').split('\n').filter((l) => !TRAILER_LINE.test(l)).join('\n');
  s = s.replace(/\s*[\u2013\u2014]\s*/g, ', ');
  s = neutraliseRefs(s).trim();
  if (s.length > LIMITS.notesChars) s = `${s.slice(0, LIMITS.notesChars - 20).trimEnd()}\n\n(truncated)`;
  return s;
}

/** A one-line reading of a test run's output: TAP totals, a jest summary line, else the tail. */
export function summariseTests(out) {
  const s = String(out ?? '');
  const pass = /^# pass (\d+)/m.exec(s)?.[1];
  const failed = /^# fail (\d+)/m.exec(s)?.[1];
  if (pass !== undefined || failed !== undefined) return `${pass ?? 0} pass, ${failed ?? 0} fail`;
  const jest = /^Tests:\s+(.+)$/m.exec(s)?.[1];
  if (jest) return jest.trim();
  const own = /^\s*(\d+) pass, (\d+) fail\b/m.exec(s);
  if (own) return `${own[1]} pass, ${own[2]} fail`;
  return s.trim().split('\n').filter((l) => l.trim()).slice(-3).join(' | ').slice(-300);
}

/** How many failed test names a bounce, fix.json and the notes carry. */
export const FAILING_NAMES_MAX = 20;

/**
 * The failed tests a run's output names: TAP `not ok` lines without a TODO or SKIP directive
 * (nested ones included) and jest/vitest `FAIL <file>` lines, in order, unique, at most
 * FAILING_NAMES_MAX. Empty when the output names none. Pure.
 */
export function failingTests(out) {
  const ids = [];
  for (const line of String(out ?? '').split('\n')) {
    const tap = /^\s*not ok \d+(?:\s+-)?\s*(.*?)\s*$/.exec(line);
    const jest = tap ? null : /^\s*FAIL\s+(\S.*?)\s*$/.exec(line);
    let id = null;
    if (tap && !/#\s*(TODO|SKIP)\b/i.test(tap[1])) id = tap[1].replace(/\s+#.*$/, '') || '(unnamed)';
    else if (jest) id = jest[1];
    if (id !== null && !ids.includes(id)) ids.push(id);
    if (ids.length >= FAILING_NAMES_MAX) break;
  }
  return ids;
}

export function renderNotes({ outcome, summary = '', reason = '', files = [], tests = null, skipped = [], described = false }) {
  const parts = [];
  if (outcome === 'refused') parts.push(reason || 'The fix was refused.');
  else {
    if (summary) parts.push(summary);
    if (described) parts.push('The pull request description is replaced.');
    if (outcome === 'no_change') parts.push('No file changed.');
    if (files.length) parts.push(`Files: ${files.map((f) => `\`${f}\``).join(', ')}`);
    if (skipped.length) parts.push(`Left out: ${skipped.map((s) => `\`${s.path}\` (${s.why})`).join(', ')}`);
    if (tests) {
      parts.push(`Tests: \`${tests.command}\` exited ${tests.exit_code}${tests.summary ? ` (${tests.summary})` : ''}`);
      if (tests.failing?.length) parts.push(`Failed: ${tests.failing.map((t) => `\`${t}\``).join(', ')}`);
    } else if (outcome !== 'no_change') parts.push('Tests: no test script in the repository.');
  }
  return cleanNotes(parts.join('\n\n'));
}

// ---------- credentials ----------

/** The credentials of this run that must never leave the runner: the model key and the read token. */
export function runSecrets(ctx) {
  return [ctx.darioKey, ctx.readToken, ctx.lessons?.secret].filter((v) => typeof v === 'string' && v.length >= 8);
}

/** Whether text carries any of the secrets. */
export function leaksSecret(text, secrets) {
  const t = String(text ?? '');
  return secrets.some((v) => t.includes(v));
}

/**
 * The first of paths (relative to root) whose raw bytes carry a secret, or null. A binary file
 * reaches the diff base85-encoded, so the diff text alone cannot show it; the files themselves can.
 */
export function fileWithSecret(root, paths, secrets) {
  if (!secrets.length) return null;
  for (const p of paths) {
    let bytes;
    try {
      const abs = join(root, p);
      const st = lstatSync(abs);
      bytes = st.isSymbolicLink() ? Buffer.from(readlinkSync(abs)) : st.isFile() ? readFileSync(abs) : null;
    } catch { bytes = null; }
    if (bytes && secrets.some((v) => bytes.includes(v))) return p;
  }
  return null;
}

/**
 * Why the staged blobs of paths cannot go into the bundle, or '' when they can. Each index entry
 * (`git ls-files -s`, paths taken literally) is sized, refused past LIMITS.fileBytes (a clean
 * filter can stage far more than the working-tree file holds), then read whole and checked for
 * a secret, a symlink's target included. Fails closed: an entry that cannot be listed, sized or
 * read is a refusal. A path with no index entry is a deletion and carries nothing.
 */
export function stagedProblem(root, env, paths, secrets) {
  if (!paths.length) return '';
  const gitOut = (args, maxBuffer) => spawnSync('git', ['--literal-pathspecs', ...args], { cwd: root, env, maxBuffer });
  const ls = gitOut(['ls-files', '-s', '-z', '--', ...paths], 64 * 1024 * 1024);
  if (ls.status !== 0) return 'the staged files could not be listed';
  for (const row of ls.stdout.toString('utf8').split('\0').filter(Boolean)) {
    const m = /^(\d+) ([0-9a-f]{40,64}) \d+\t([\s\S]+)$/.exec(row);
    if (!m) return 'an index entry could not be read';
    const [, mode, sha, p] = m;
    if (mode === '160000') continue; // a gitlink names a commit, it carries no bytes
    const sized = gitOut(['cat-file', '-s', sha], 1024);
    const size = sized.status === 0 ? Number(sized.stdout.toString().trim()) : NaN;
    if (!Number.isFinite(size)) return `the staged ${p} could not be sized`;
    if (size > LIMITS.fileBytes) return `the staged ${p} is ${size} bytes; the limit is ${LIMITS.fileBytes}`;
    const blob = gitOut(['cat-file', 'blob', sha], LIMITS.fileBytes + 1024);
    if (blob.status !== 0 || blob.stdout.length !== size) return `the staged ${p} could not be read`;
    if (secrets.some((v) => blob.stdout.includes(v))) return 'The change carried a credential of this run, so nothing is committed.';
  }
  return '';
}

/** text with every secret replaced by ***, for the job log. */
export function maskSecrets(text, secrets) {
  let t = String(text ?? '');
  for (const v of secrets) t = t.split(v).join('***');
  return t;
}

// ---------- fix.json ----------

/**
 * The workflow run and attempt this process is part of, from the runner's environment
 * (GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT); null when either is not a positive integer, as outside a
 * workflow. Pure.
 */
export function runIdentity(env = process.env) {
  // Decimal digits only, then the same positive safe-integer bound runProblem holds a record to.
  const whole = (v) => {
    const s = String(v ?? '');
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  const id = whole(env.GITHUB_RUN_ID);
  const attempt = whole(env.GITHUB_RUN_ATTEMPT);
  return id !== null && attempt !== null ? { id, attempt } : null;
}

/** Why a value is not a run identity { id, attempt }, both positive integers; null when it is one. Pure. */
export function runProblem(run) {
  const ok = run !== null && typeof run === 'object' && !Array.isArray(run)
    && Number.isSafeInteger(run.id) && run.id > 0 && Number.isSafeInteger(run.attempt) && run.attempt > 0;
  return ok ? null : 'run must be null or { id, attempt }, both positive integers';
}

/** fix.json exactly as the ops tick reads it. */
export function fixRecord({ repo, pr, headSha, newHead = null, outcome, commits = [], files = [], tests = null, turns = 0, model = '', notes = '', description = false, run = null }) {
  return {
    version: FIX_VERSION, repo, pr, base_head: headSha, new_head: newHead, outcome, commits, files, tests, turns, model, notes: String(notes ?? ''), description: description === true,
    run: run && runProblem(run) === null ? { id: run.id, attempt: run.attempt } : null,
  };
}

/** Why a parsed fix.json is malformed, or null. The ops tick applies its own checks as well. */
export function fixProblem(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'not an object';
  if (v.version !== FIX_VERSION) return `version must be ${FIX_VERSION}`;
  if (typeof v.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(v.repo)) return 'repo must be owner/name';
  if (!Number.isInteger(v.pr) || v.pr <= 0) return 'pr must be a positive integer';
  if (typeof v.base_head !== 'string' || !/^[0-9a-f]{40}$/.test(v.base_head)) return 'base_head must be a full commit sha';
  if (v.new_head !== null && (typeof v.new_head !== 'string' || !/^[0-9a-f]{40}$/.test(v.new_head))) return 'new_head must be a full commit sha or null';
  if (!OUTCOMES.includes(v.outcome)) return `outcome must be one of ${OUTCOMES.join(', ')}`;
  if (!Array.isArray(v.commits)) return 'commits must be an array';
  for (const [i, c] of v.commits.entries()) {
    if (!c || typeof c.sha !== 'string' || !/^[0-9a-f]{40}$/.test(c.sha) || typeof c.subject !== 'string' || !c.subject.trim()) return `commit ${i + 1} needs sha and subject`;
  }
  if (v.outcome === 'fixed' && v.commits.length > 0 && v.new_head !== v.commits.at(-1).sha) return 'new_head must be the last commit';
  if (v.outcome !== 'fixed' && (v.new_head !== null || v.commits.length)) return `${v.outcome} carries no commit`;
  if (!Array.isArray(v.files) || v.files.some((f) => typeof f !== 'string' || !f)) return 'files must be an array of paths';
  if (v.tests !== null && (!v.tests || typeof v.tests.command !== 'string' || !Number.isInteger(v.tests.exit_code) || typeof v.tests.summary !== 'string')) return 'tests must be null or { command, exit_code, summary }';
  if (!Number.isInteger(v.turns) || v.turns < 0) return 'turns must be a non-negative integer';
  if (typeof v.model !== 'string') return 'model must be a string';
  if (typeof v.notes !== 'string' || v.notes.length > LIMITS.notesChars) return `notes must be a string of at most ${LIMITS.notesChars} characters`;
  if (/[\u2013\u2014]/.test(v.notes)) return 'notes must not contain an em dash';
  if (v.description !== undefined && typeof v.description !== 'boolean') return 'description must be a boolean';
  if (v.description === true && v.outcome !== 'fixed' && v.outcome !== 'no_change') return `${v.outcome} carries no description`;
  // Absent in a record written before the field existed; null outside a workflow run.
  if (v.run !== undefined && v.run !== null && runProblem(v.run)) return runProblem(v.run);
  return null;
}

/** An attribution line in a PR description: a trailer, a "Generated with" line or a session link. */
export const DESCRIPTION_ATTRIBUTION = /^\s*(?:Co-Authored-By:.*|.*Generated with \[?Claude Code\]?.*|.*claude\.ai\/code\/session_\S*.*|Claude-Session:.*)$/im;

/**
 * Why `text` cannot replace the PR description `current`, or null. The whole description is
 * replaced, so it is refused when the brief showed the model only part of the current one. Pure.
 */
export function descriptionProblem(text, current) {
  const t = String(text ?? '').replace(/\r\n/g, '\n').trim();
  // Measured exactly as buildBrief cuts it (the raw body, sliced at bodyChars), so a body the
  // brief showed only in part is never replaced whole, whatever whitespace or line endings it has.
  const raw = String(current ?? '');
  if (raw.length > LIMITS.bodyChars) return `the current description is ${raw.length} characters and the brief shows ${LIMITS.bodyChars}, so it is not rewritten whole here`;
  const c = raw.replace(/\r\n/g, '\n').trim();
  if (!t) return 'the description is empty';
  if (t.length > LIMITS.descriptionChars) return `the description is longer than ${LIMITS.descriptionChars} characters`;
  if (t === c) return 'that is the current description';
  if (DESCRIPTION_ATTRIBUTION.test(t)) return 'the description carries an attribution line';
  if (/[\u2013\u2014]/.test(t)) return 'the description contains an em or en dash';
  return null;
}

/** Write fix.json and notes.md into dir, creating it. */
export function saveFix(dir, record, description = null) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fix.json'), `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(join(dir, 'notes.md'), `${record.notes}\n`);
  if (record.description === true && typeof description === 'string') writeFileSync(join(dir, 'description.md'), `${description}\n`);
}

/**
 * The job's exit status for a record: 0 for fixed, and for a run that changed no file but replaced
 * the PR description (the ops tick sets the description from the artifact); 1 for anything else.
 */
export function exitCode(record) {
  return record.outcome === 'fixed' || (record.outcome === 'no_change' && record.description === true) ? 0 : 1;
}

// ---------- tools ----------

// Every tool name is fix_* (or finish_fix), never a common tool name. dario maps a non-Claude-Code
// client's tools named like read_file, write_file, run, search or list_files onto Claude Code's own
// (Read, Write, Bash, Grep, Glob) and sends the rest as mcp__client__<name>. A set split across the
// two forms can leave the model unable to find finish_fix; names no client uses all go out one way.
export const TOOLS = [
  { name: 'fix_list', description: 'List a directory of the checkout (directories end with /).',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Directory relative to the repo root; default the root.' } } } },
  { name: 'fix_read', description: 'Read numbered lines of a file in the checkout. At most 400 lines per call.',
    input_schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 } } } },
  { name: 'fix_search', description: 'Search the checkout with a JavaScript regular expression. At most 80 matches.',
    input_schema: { type: 'object', required: ['pattern'], properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Directory or file to search; default the root.' } } } },
  { name: 'fix_write', description: 'Write a whole file in the checkout (created if absent). Read it first and write it back complete. Never under .git/ or node_modules/; under .github/ only the files the brief lists as writable there.',
    input_schema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } } },
  { name: 'fix_run', description: `Run one allowed command in the checkout, without a shell; stdout and stderr together, capped. Default timeout ${LIMITS.runDefaultS}s, at most ${LIMITS.runMaxS}s. The allowed commands are listed in the brief.`,
    input_schema: { type: 'object', required: ['command'], properties: { command: { type: 'string' }, timeout_seconds: { type: 'integer', minimum: 1, maximum: LIMITS.runMaxS } } } },
  { name: 'fix_describe', description: 'Replace the pull request description with the complete new text. Only for a finding on the PR description or title: start from the current description in the brief and change only what the finding asks. No attribution lines and no em dashes.',
    input_schema: { type: 'object', required: ['body'], properties: { body: { type: 'string', description: 'The whole new description, markdown.' } } } },
  { name: 'finish_fix', description: 'Finish. Call exactly once, last, after the tests have run on your edits.',
    input_schema: { type: 'object', required: ['outcome', 'summary'], properties: {
      outcome: { type: 'string', enum: ['fixed', 'refused'], description: 'fixed when the findings are answered in code; refused when none can be.' },
      subject: { type: 'string', description: 'fixed: one line for the commit, imperative, under 60 characters, no prefix, no issue numbers, no trailers.' },
      summary: { type: 'string', description: 'Markdown for the PR comment: per finding, what changed, where, and why it answers it. Plain sentences.' },
      tests_run: { type: 'string', description: 'The test command you ran last and its result.' },
      reason: { type: 'string', description: 'refused: why no finding can be fixed in this PR.' } } } },
];

export const FINISH_REQUIRED = 'The budget is spent. Your next response must be a finish_fix tool call with outcome, subject, summary and '
  + 'tests_run, describing what you changed so far. Do not call any other tool and do not answer in text.';
const TEXT_ONLY_NUDGE = 'That text was discarded: only tool calls act here. Continue with the tools, or call finish_fix.';
const BUDGET_SPENT = 'The budget is spent. Call finish_fix now with what you have.';

/** Put FINISH_REQUIRED in the last user turn, once (the turn about to be sent; nothing answered is edited). */
export function askForFinish(messages) {
  const last = messages.at(-1);
  if (!last || last.role !== 'user') return;
  if (typeof last.content === 'string') {
    if (!last.content.includes(FINISH_REQUIRED)) last.content = `${last.content}\n\n${FINISH_REQUIRED}`;
    return;
  }
  if (Array.isArray(last.content) && !last.content.some((b) => b.type === 'text' && b.text === FINISH_REQUIRED)) {
    last.content.push({ type: 'text', text: FINISH_REQUIRED });
  }
}

/**
 * Validate finish_fix input. Returns { sub } or { error }. Prose that names the machinery is
 * bounced. `subjectOf` makes the commit subject from the model's line: commitSubject here, the
 * build lane's own in build.mjs.
 */
export function checkFinish(input, subjectOf = commitSubject) {
  if (!input || typeof input !== 'object') return { error: 'finish_fix needs an object' };
  const outcome = input.outcome ?? 'fixed';
  if (outcome !== 'fixed' && outcome !== 'refused') return { error: 'outcome must be fixed or refused' };
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const prose = [];
  if (outcome === 'refused') {
    if (!str(input.reason)) return { error: 'refused needs a reason' };
    prose.push(['reason', input.reason]);
  } else {
    if (!str(input.summary)) return { error: 'summary is required' };
    if (!str(input.subject)) return { error: 'subject is required: one line for the commit' };
    prose.push(['summary', input.summary]);
    if (str(input.tests_run)) prose.push(['tests_run', input.tests_run]);
  }
  for (const [where, text] of prose) {
    const hit = metaPhrase(text);
    if (hit) return { error: `${where} says "${hit}". The comment is public and describes only the change: say what changed, where and why, and never mention attribution, generation, models, rules or lanes. Rewrite and call finish_fix again.` };
  }
  if (outcome === 'refused') return { sub: { outcome, reason: str(input.reason) } };
  return { sub: { outcome, subject: subjectOf(input.subject), summary: str(input.summary), tests_run: str(input.tests_run) } };
}

// ---------- the loop ----------

export function capOutput(text, max = LIMITS.runOutChars) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max / 4)}\n(... ${s.length - max} chars omitted ...)\n${s.slice(-(max * 3) / 4)}` : s;
}

/**
 * The fix lane's own words where the shared work speaks, to the model and in the notes: the lane's
 * name, what a run produces, the line under the brief, the refusal for a checkout that is somewhere
 * else, and what the summary is to say about captured data. build.mjs has its own.
 */
const FIX_WORDS = {
  lane: 'fix lane',
  work: 'fix',
  ask: 'Answer the review and finish with finish_fix.',
  notAtStart: 'the checkout is not at the reviewed head',
  protectedNote: 'this finding is about data the fix lane does not change',
};

/**
 * The model loop with every side effect injected: ctx.call(messages, toolChoice) -> Messages
 * response, ctx.tool(name, input) -> string, ctx.finalize(input) -> { sub } | { error }, ctx.now,
 * ctx.log, ctx.canForce. Returns { sub, turns } or { refused, turns }; throws only on a broken
 * response. Text-only and empty replies are handled as in review.mjs: three in a row end the run,
 * an empty reply is not kept in the history. ctx.ask is the line under the brief and ctx.work the
 * name of what the run produces; a lane that leaves them out is the fix lane.
 */
export async function runLoop(ctx, brief) {
  const messages = [{ role: 'user', content: `${brief}\n\n${ctx.ask ?? FIX_WORDS.ask}` }];
  // The run's own start when given, so the install counts against the budget.
  const started = ctx.started ?? ctx.now();
  const canForce = ctx.canForce !== false;
  let textOnly = 0;
  let turns = 0;
  for (let turn = 1; turn <= LIMITS.turns; turn++) {
    turns = turn;
    const force = turn >= LIMITS.forceFinishAt || ctx.now() - started > LIMITS.timeMs;
    if (force && !canForce) askForFinish(messages);
    const res = await ctx.call(messages, !force ? null : canForce ? { type: 'tool', name: 'finish_fix' } : { type: 'auto' });
    if (!Array.isArray(res?.content)) throw new Error(`the model returned no message content: ${JSON.stringify(res ?? null).slice(0, 300)}`);
    const uses = res.content.filter((b) => b.type === 'tool_use');
    const text = res.content.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join(' ').replace(/\s+/g, ' ').trim();
    ctx.log?.(`turn ${turn}${force ? (canForce ? ' (forced)' : ' (finish required)') : ''}: ${uses.map((u) => u.name).join(', ') || 'no tool call'}; stop=${res.stop_reason ?? '-'}`
      + (uses.length ? '' : ` text=${JSON.stringify(text.slice(0, 200))}`));
    if (!uses.length) {
      if (++textOnly >= LIMITS.textOnlyTurns) return { refused: `${textOnly} text-only answers in a row: the model did not call finish_fix`, turns };
      if (res.content.length) {
        messages.push({ role: 'assistant', content: res.content });
        messages.push({ role: 'user', content: TEXT_ONLY_NUDGE });
      }
      continue;
    }
    textOnly = 0;
    messages.push({ role: 'assistant', content: res.content });
    const out = [];
    for (const u of uses) {
      if (u.name !== 'finish_fix') {
        out.push(force
          ? { type: 'tool_result', tool_use_id: u.id, is_error: true, content: BUDGET_SPENT }
          : { type: 'tool_result', tool_use_id: u.id, content: String(await ctx.tool(u.name, u.input ?? {})) });
        continue;
      }
      const r = await ctx.finalize(u.input ?? {});
      if (r.sub) return { sub: r.sub, turns };
      ctx.log?.(`  finish_fix bounced: ${String(r.error).split('\n')[0]}`);
      out.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: r.error });
    }
    messages.push({ role: 'user', content: out });
  }
  return { refused: `no ${ctx.work ?? FIX_WORDS.work} submitted within ${LIMITS.turns} turns`, turns };
}

/** The brief's lines on the toolchain: what was installed, what fix_run accepts, the test script. Pure. */
export function toolchainLines(plan, installNote) {
  return [
    `Toolchain: ${plan.pm ?? 'none'}; install: ${installNote}`,
    `run accepts: ${allowedCommands(plan).join(', ')}`,
    plan.scripts.includes('test') ? `Test script: \`${plan.pm} test\`. Run it after your edits.` : 'No test script in package.json.',
  ];
}

export function buildBrief({ pr, files, headSha, review, items, plan, installNote, diff, protectedFiles = [], githubFiles = [], history = [], lessons = [], run = null }) {
  const findings = review.findings;
  return [
    `Repository: ${pr.base.repo.full_name}`,
    `PR #${pr.number}: ${pr.title}`,
    `${pr.head.ref} -> ${pr.base.ref}; head ${headSha}`,
    // Directly under the head line, where a reader of the call's record finds which execution
    // made the call. fix.json carries the same pair (fixRecord).
    ...(run && runProblem(run) === null ? [`Fix run ${run.id}, attempt ${run.attempt}`] : []),
    '', 'PR description:', String(pr.body ?? '').slice(0, LIMITS.bodyChars) || '(empty)',
    '', `Files the PR changes (${files.length}):`, ...files.map((f) => `- ${f.status} +${f.additions} -${f.deletions} ${f.filename}`),
    githubFiles.length
      ? `Under .github/ you may write only these files, which this PR already changes: ${githubFiles.join(', ')}. No other file there, and no new file there.`
      : 'Nothing under .github/ is written in this run: the PR changes no file there that this lane may edit.',
    ...(protectedFiles.length
      ? ['', `Captured data, marked ${PROTECTED_ATTR} (never written by fix_write): ${protectedFiles.join(', ')}. A finding about the text inside one of these is answered in the summary, not by an edit.`]
      : []),
    '', `Review summary: ${review.summary || '(none)'}`,
    '', `Findings (${findings.length}):`, ...findings.map(formatFinding),
    '', `Inline comments (${items.length}):`, ...items.map((c, i) => `[${i + 1}] ${c.path}${c.line ? `:${c.line}` : ''}\n${c.body}`),
    ...(lessons.length
      ? ['', `Lessons this lane drew from its earlier fixes that fell short (${lessons.length}). General advice, background only: the findings above are what this run answers.`, ...lessons.map((l) => `- ${l}`)]
      : []),
    ...(history.length
      ? ['', `Earlier fixes on this repository by this lane, newest first (${history.length}). Background only: the findings above are what this run answers.`, ...history.map(formatHistory)]
      : []),
    '', ...toolchainLines(plan, installNote),
    '', 'PR diff:', diff || '(empty)',
  ].join('\n');
}

// ---------- processes ----------

/**
 * The environment of every child (install, run, git): PATH, a scratch HOME and TMPDIR, CI=1 and
 * nothing else, so the GitHub token and the model key in this process never reach a command the
 * model chose. DARIO_IGNORE_CC_CREDENTIALS keeps dario's own suite from touching the runner's
 * credentials. On Windows the system variables a process needs to start are kept.
 */
export function childEnv(env, home, proxy = '') {
  const out = { PATH: env.PATH ?? env.Path ?? '', HOME: home, TMPDIR: home, LANG: 'C.UTF-8', CI: '1', NO_COLOR: '1', DARIO_IGNORE_CC_CREDENTIALS: '1', ...proxyEnv(proxy) };
  if (process.platform === 'win32') {
    for (const k of ['SYSTEMROOT', 'SystemRoot', 'PATHEXT', 'COMSPEC', 'ComSpec']) if (env[k]) out[k] = env[k];
    Object.assign(out, { TEMP: home, TMP: home, USERPROFILE: home });
  }
  return out;
}

/**
 * The variables that send every package manager through the host's forward proxy (FIX_PROXY),
 * which allows the package registries and nothing else. A proxy, not a registry mirror: lockfiles
 * carry full registry URLs, and some installers fetch those as written. Empty without a proxy.
 */
export function proxyEnv(proxy) {
  const p = String(proxy ?? '').trim();
  if (!p) return {};
  return {
    HTTP_PROXY: p, HTTPS_PROXY: p, http_proxy: p, https_proxy: p, NO_PROXY: '', no_proxy: '',
    npm_config_proxy: p, npm_config_https_proxy: p, YARN_HTTP_PROXY: p, YARN_HTTPS_PROXY: p,
  };
}

/**
 * The account that runs every command the checkout supplies (the install, the tests, node <file>):
 * FIX_RUN_AS from the host's env file, a plain user name, or '' to run them as this account.
 * Throws on anything that is not a user name.
 */
export function runAccount(name) {
  const s = String(name ?? '').trim();
  if (!s) return '';
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(s)) throw new Error(`FIX_RUN_AS is not a user name: ${s.slice(0, 40)}`);
  return s;
}

/**
 * argv run as `runAs` through sudo with exactly `env` and nothing inherited: sudo resets the
 * environment, and env -i starts from empty. Pure.
 */
export function asRunAccount(runAs, env, argv) {
  return ['sudo', '-n', '-u', runAs, '--', 'env', '-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...argv];
}

/**
 * Why the account sudo reaches, whose `id -u` printed `uid`, cannot be the run account; null when
 * it can. Every process of the run account is killed with kill -1, so it is never root and never
 * this account (ownUid). Pure.
 */
export function runAccountUidProblem(uid, ownUid) {
  const s = String(uid ?? '').trim();
  if (!/^\d+$/.test(s)) return `the run account's uid could not be read (\`id -u\` printed ${JSON.stringify(s.slice(0, 40))})`;
  if (Number(s) === 0) return 'the run account is root, and its processes are all killed after every command';
  if (Number(s) === ownUid) return 'the run account is this account, and its processes are all killed after every command';
  return null;
}

/**
 * Run argv in cwd with a hard time cap: coreutils timeout on the runner, node's own elsewhere.
 * With runAs, the command runs as that account (asRunAccount). argv is already allowlisted, so on
 * Windows (a developer box, never the runner) a package manager's .cmd shim may go through the
 * shell node requires for it.
 */
function run(cwd, env, argv, seconds, runAs = '') {
  const win = process.platform === 'win32';
  const timed = win ? argv : ['timeout', '-k', '10', String(seconds), ...argv];
  const wrapped = runAs && !win ? asRunAccount(runAs, env, timed) : timed;
  const spawnEnv = runAs && !win ? { PATH: env.PATH ?? '' } : env;
  const r = spawnSync(wrapped[0], wrapped.slice(1), { cwd, env: spawnEnv, encoding: 'utf8', timeout: (seconds + 30) * 1000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, shell: win && PACKAGE_MANAGERS.includes(argv[0]) });
  const timedOut = r.status === 124 || r.error?.code === 'ETIMEDOUT';
  const exit = r.status ?? (timedOut ? 124 : r.signal ? 128 : -1);
  return { exit, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error && !timedOut ? `\n${r.error.message}` : ''}`, timedOut };
}

function git(cwd, env, args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout || r.error?.message || '').trim().slice(0, 300)}`);
  return r.status === 0 ? String(r.stdout ?? '').replace(/\n$/, '') : null;
}

/**
 * The reviewed head's .gitattributes files as { path: text }, read from its tree, not from the
 * checkout. Taken before the install runs; every redline-protected decision after that is made
 * against this snapshot. A symlinked .gitattributes is skipped, as git skips it.
 */
function headAttributes(root, env, headSha) {
  const out = {};
  for (const row of (git(root, env, ['ls-tree', '-r', '-z', headSha]) ?? '').split('\0')) {
    const tab = row.indexOf('\t');
    const [mode, type] = row.slice(0, tab).split(' ');
    const p = row.slice(tab + 1);
    if (tab < 0 || type !== 'blob' || !['100644', '100755'].includes(mode) || !/(?:^|\/)\.gitattributes$/.test(p)) continue;
    out[p] = git(root, env, ['cat-file', 'blob', `${headSha}:${p}`]) ?? '';
  }
  return out;
}

/** The reviewed head's regular files under .github/ as path -> blob sha, read from its tree. */
function headBlobs(root, env, headSha) {
  const out = new Map();
  for (const row of (git(root, env, ['ls-tree', '-r', '-z', headSha, '--', '.github']) ?? '').split('\0')) {
    const tab = row.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, sha] = row.slice(0, tab).split(' ');
    if (type === 'blob' && ['100644', '100755'].includes(mode)) out.set(row.slice(tab + 1), sha);
  }
  return out;
}

/**
 * The given paths that `attrs` (headAttributes) marks redline-protected. git decides, in a fresh
 * scratch repository holding only those files, with no global or system config, so nothing a
 * command did to the checkout or its .git reaches the answer. Throws when git cannot say.
 */
export function protectedPaths(attrs, paths) {
  if (!paths.length) return new Set();
  const dir = mkdtempSync(join(tmpdir(), 'redline-attrs-'));
  try {
    const env = { ...childEnv(process.env, dir), XDG_CONFIG_HOME: dir, GIT_CONFIG_NOSYSTEM: '1' };
    git(dir, env, ['init', '-q']);
    for (const [p, text] of Object.entries(attrs)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), text); }
    const r = spawnSync('git', ['check-attr', '-z', PROTECTED_ATTR, '--', ...paths], { cwd: dir, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`git check-attr failed: ${(r.stderr || r.error?.message || '').trim().slice(0, 200)}`);
    return protectedFromCheckAttr(r.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Paths git sees as changed (tracked or untracked, ignored files excluded), forward slashes. */
function changedPaths(root, env) {
  const raw = spawnSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout ?? '';
  const fields = raw.split('\0').filter((f) => f !== '');
  const out = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const xy = f.slice(0, 2);
    out.push(f.slice(3));
    if (/[RC]/.test(xy)) i++;
  }
  return out;
}

/** fetch restricted to the origins this script may talk to; anything else is refused before it leaves. */
export function onlyOrigins(fetchFn, urls) {
  const origins = new Set(urls.map((u) => new URL(u).origin));
  return (url, init) => {
    let o = '';
    try { o = new URL(String(url)).origin; } catch { o = ''; }
    return origins.has(o) ? fetchFn(url, init) : Promise.reject(new Error(`no request leaves for ${o || 'an invalid URL'}`));
  };
}

// ---------- the job ----------

/**
 * Answer one review at one head. ctx: { repo, pr, headSha, reviewUrl, checkout, out, readToken,
 * darioUrl, darioKey, model, system, fetch, sleep, now, log, dryRun, env }. Returns { record }, the
 * fix.json record; the bundle or diff is written under ctx.out. Throws only on a broken model
 * response or a git failure; the CLI turns that into a refused record.
 */
export async function runFix(ctx) {
  const result = await answerReview(ctx);
  return sealResult(ctx, result, 'fix.bundle', (fields) => fixRecord({ repo: ctx.repo, pr: ctx.pr, headSha: ctx.headSha, model: ctx.model, run: ctx.run, ...fields }));
}

/**
 * The last gate before anything is uploaded: the record, notes.md and description.md are public
 * through the ops tick (the description becomes a pull request's body), so the description is
 * checked with them. A result that carries a credential of the run is replaced by a refusal the
 * lane's own `record` writes, and the bundle or patch already written is removed.
 */
export function sealResult(ctx, result, bundle, record) {
  if (!leaksSecret(`${JSON.stringify(result.record)}\n${result.description ?? ''}`, runSecrets(ctx))) return result;
  for (const f of [bundle, 'diff.patch']) rmSync(join(ctx.out, f), { force: true });
  return { record: record({ outcome: 'refused', turns: result.record.turns,
    notes: renderNotes({ outcome: 'refused', reason: 'The result carried a credential of this run, so nothing from it is kept.' }) }) };
}

/**
 * The fix lane's own half: read the pull request and its review, and decide what is to be
 * answered. Everything it refuses is refused before the checkout is touched; the rest is
 * workCheckout's, with the job this hands it.
 */
async function answerReview(ctx) {
  const { repo, pr: n, headSha, out } = ctx;
  // The run's start: the reads below count against the budget, as the install does.
  const started = ctx.now();
  mkdirSync(out, { recursive: true });
  const base = { repo, pr: n, headSha, model: ctx.model, run: ctx.run };
  const record = (fields) => fixRecord({ ...base, ...fields });
  const refuse = (why, extra = {}) => ({ record: record({ outcome: 'refused', ...extra, notes: renderNotes({ outcome: 'refused', reason: why }) }) });

  const ref = parseReviewUrl(ctx.reviewUrl);
  if (!ref) return refuse(`REVIEW_URL is not a pull request review link: ${String(ctx.reviewUrl ?? '').slice(0, 200)}`);
  if (ref.repo.toLowerCase() !== repo.toLowerCase() || ref.pr !== n) return refuse('the review link names another repository or pull request');
  const pr = await gh(ctx, `/repos/${repo}/pulls/${n}`);
  if (pr.state !== 'open') return refuse(`the pull request is ${pr.state}`);
  if (pr.head.sha !== headSha) return refuse(`the head moved to ${pr.head.sha}; dispatch again at the new head`);
  if (pr.head.repo?.full_name !== repo) return refuse('fork pull requests are not fixed here');
  if (DEPENDABOT_AUTHOR.test(String(pr.user?.login ?? ''))) return refuse('Dependabot pull requests are not fixed here: the tests would load the new package version beside this run\'s credentials');
  const reviewRow = await gh(ctx, `/repos/${repo}/pulls/${n}/reviews/${ref.id}`);
  if (reviewRow.state !== 'CHANGES_REQUESTED') return refuse(`the review is ${reviewRow.state}, not CHANGES_REQUESTED`);
  if (reviewRow.commit_id !== headSha) return refuse(`the review is at ${reviewRow.commit_id}, not at the head`);
  const comments = await ghAll(ctx, `/repos/${repo}/pulls/${n}/reviews/${ref.id}/comments`, 3);
  const files = await ghAll(ctx, `/repos/${repo}/pulls/${n}/files`, 3);
  const compared = await headCompare(ctx, repo, pr.base.sha, headSha);
  const review = parseReviewBody(reviewRow.body);
  const items = inlineItems(comments);
  if (!review.findings.length && !items.length) return refuse('the review has no finding to answer');
  // Read only when FIX_EFFORT is set: without it no request names an effort and nothing is fetched.
  let effort;
  if (ctx.effort) {
    const { rounds, capped } = await reviewRounds(ctx, repo, n, reviewRow);
    effort = fixEffort(ctx.effort, capped ? Infinity : rounds);
    ctx.log?.(capped
      ? `  effort ${effort}: more than ${REVIEW_PAGES_MAX * 100} reviews before this one, so it is taken as a later change request`
      : `  effort ${effort ?? 'unset'}: change request ${rounds + 1} from this reviewer on this pull request`);
  }

  // The repository's earlier fixes, for the brief. Off with FIX_HISTORY=off; a failed read leaves the brief as it was.
  let history = [];
  if (ctx.history !== false) {
    try {
      history = await repoFixHistory(ctx, repo, n, reviewRow.user?.login ?? '');
      ctx.log?.(`  history: ${history.length} earlier fix(es) on this repository`);
    } catch (e) {
      ctx.log?.(`  history: not read (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  // Lessons from this lane's earlier fixes, for the brief. Off without the lessons settings in the
  // env file, or with FIX_LESSONS=off; a failed read leaves the brief as it was. A repository not
  // known to be private asks for public lessons only.
  let lessons = [];
  if (ctx.lessons) {
    try {
      lessons = await fetchLessons(ctx, lessonQuery(review, items), pr.base?.repo?.private !== true);
      ctx.log?.(`  lessons: ${lessons.length} from earlier fixes`);
    } catch (e) {
      ctx.log?.(`  lessons: not read (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  return workCheckout(ctx, {
    start: headSha, started, record, words: FIX_WORDS, effort,
    // Under .github/ only the pull request's own files, as the compare with the reviewed head has them.
    githubChanges: compared,
    tools: TOOLS, subject: commitSubject, refusedMessage: hasAttributionTrailer, bundle: 'fix.bundle',
    // fix_describe replaces the pull request's description, whole: a result on its own when no
    // file changed, and never when the brief showed only part of the current one.
    describe: {
      replaces: true,
      problem: (body) => descriptionProblem(body, pr.body),
      kept: (lines) => `the PR description is replaced with this text (${lines} lines) when the run finishes`,
    },
    brief: ({ plan, installNote, githubFiles, attrs }) => {
      const protectedFiles = [...protectedPaths(attrs, files.map((f) => f.filename))];
      return buildBrief({ pr, files, headSha, review, items, plan, installNote, diff: buildDiff(files, LIMITS.diffChars), protectedFiles, githubFiles, history, lessons, run: ctx.run });
    },
  });
}

/**
 * The work in the checkout, shared by the fix lane and the build lane (build.mjs): prove the run
 * account, install the toolchain, let the model read, write and run until it calls finish_fix,
 * hold the result to the test gate and the limits, and write one commit on top of job.start as a
 * bundle under ctx.out, which the lane has made. ctx is the run (the checkout, the model, the run
 * account, now, log, dryRun); job is what the lane wants done:
 *   start, started   the commit the work starts from; the run's start, which the budget counts from
 *   record(fields)   the lane's record, from outcome, notes, turns, tests, files, commits, newHead,
 *                    subject and description
 *   words            the lane's words to the model and in the notes (FIX_WORDS has the fix lane's)
 *   effort           the level every model request names, or nothing
 *   githubChanges    the compare whose files under .github/ may be written (editableGithub), or
 *                    null when nothing there may be
 *   tools, subject   the tools the model gets; the commit subject, made from the model's line
 *   refusedMessage   whether the commit's message carries what the lane's subject rule refuses,
 *                    checked on the commit itself before the bundle
 *   describe         fix_describe. problem(body) says why a text is refused and kept(lines) answers
 *                    the model. replaces: the text replaces an existing description, so it is a
 *                    result with no file changed and the notes say so. required: a change needs
 *                    one, so finish_fix without it is sent back once with `ask`, and fallback(sub)
 *                    stands in when it still does not come
 *   brief(facts)     the first user turn, from { plan, installNote, githubFiles, attrs, git }: the
 *                    toolchain, the writable .github files, the start commit's .gitattributes
 *                    (headAttributes) and this process's git on the checkout
 *   bundle           the bundle's file name
 *   replay           a verify run's candidate, in place of the model: { tree, subject, summary,
 *                    tests_run, ranBuild, description, turns }. The tree is written into the
 *                    checkout as the model's edits were, the test gate decides once with no turn
 *                    to answer it, and the commit is made as a build's is; the tree it commits must
 *                    be the candidate's. No model is called and nothing is installed here.
 * Returns { record, description, replay }: replay, for a fixed result, is what a verify run needs
 * besides the bundle (the summary, tests_run, and whether the model ran the build script). Throws
 * only on a broken model response or a git failure; the CLI turns that into a refused record.
 */
export async function workCheckout(ctx, job) {
  const { checkout: root, out } = ctx;
  const { start, started, words } = job;
  const deadline = started + LIMITS.hardMs;
  // Seconds a command may still run, inside hardMs; 0 when the budget is spent.
  const secondsLeft = (want) => { const left = Math.floor((deadline - ctx.now()) / 1000); return left < 30 ? 0 : Math.min(want, left); };
  const refuse = (why, extra = {}) => ({ record: job.record({ outcome: 'refused', ...extra, notes: renderNotes({ outcome: 'refused', reason: why }) }) });

  let runAs;
  try { runAs = runAccount(ctx.runAs); } catch (e) { return refuse(e.message); }
  const home = mkdtempSync(join(tmpdir(), 'redline-fix-home-'));
  const cenv = childEnv(ctx.env ?? process.env, home, ctx.proxy);
  const sudoEnv = { PATH: cenv.PATH };
  const me = userInfo().username;
  // git as this account reads no configuration the checkout's commands can write: a HOME of its
  // own, no global or system config, and with a run account a private copy of .git (below).
  const gitHome = mkdtempSync(join(tmpdir(), 'redline-fix-git-'));
  const genv = { ...cenv, HOME: gitHome, TMPDIR: gitHome, XDG_CONFIG_HOME: gitHome, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    ...(process.platform === 'win32' ? { USERPROFILE: gitHome } : {}) };
  const asRun = (args) => spawnSync('sudo', ['-n', '-u', runAs, '--', ...args], { env: sudoEnv, encoding: 'utf8', timeout: 120_000 });
  // Whether the run account may read (-r) or write (-w) a path, as the kernel decides it: bash's
  // own test calls faccessat, which honours ACLs. /usr/bin/test does not everywhere: Ubuntu 26.04's
  // (uutils) reads the mode bits only, so an ACL grant would read as no access, and a guard that
  // must find the key file unreadable would pass while an ACL lets the account read it.
  const runCan = (flag, path) => asRun(['bash', '-c', 'test "$1" "$2"', 'redline-access', flag, path]).status === 0;
  // After every command: no process of the run account outlives it (none can swap a file while
  // this process reads it), and what it created is readable here again, whatever modes it set.
  // kill -KILL -1, sent as the run account, signals all of its processes while the kernel holds
  // the task list, so a process that keeps forking cannot slip a child past it (pkill lists, then
  // signals). The account must then show no live process (a zombie holds no code); anything else,
  // or a ps that cannot say, throws, and the run is refused rather than read on.
  // Off until the run account has passed every check below, so a refused account (root, this
  // account, one that can read the key) is never sent kill -1, not even by the cleanup in finally.
  let armed = false;
  // The directories the run account works in: the checkout and its HOME, and while the test gate
  // runs (gateTests), the gate's checkout and HOME as well.
  const workDirs = [root, home];
  const settle = () => {
    if (!runAs || !armed) return;
    for (let round = 0; ; round++) {
      // bash's own kill, which calls kill(2) itself: Ubuntu 26.04's /usr/bin/kill does not stop
      // the account's processes for -1, and a chain that hops to new pids can slip past ps.
      asRun(['bash', '-c', 'kill -KILL -1']);
      const ps = spawnSync('ps', ['-u', runAs, '-o', 'stat='], { env: sudoEnv, encoding: 'utf8' });
      const live = String(ps.stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('Z'));
      if ((ps.status === 0 || ps.status === 1) && !live.length) break;
      if (ps.status !== 0 && ps.status !== 1) throw new Error(`could not confirm that the run account has no process left (ps exited ${ps.status})`);
      if (round >= 4) throw new Error(`the run account still has ${live.length} process(es) after five kills`);
    }
    // What it made is reachable here again, whatever it did to its own modes and ACLs (a command
    // can strip the inherited ACL and set 700): as owner, it gives itself traversal first, then
    // this account an explicit ACL entry, recursively. Then this account must reach every path;
    // a path it cannot is a refusal, never a file git silently skips.
    // Group execute is cleared before X is read. On a file with an ACL the group bits are its mask,
    // which the setfacl below sets from the named entries, and an entry inherited from a directory's
    // default carries x: X would then read the file as executable and give its owner x on the next
    // pass, and git would commit a file the run account made as 100755. Git reads the owner's bit
    // alone, so what X sees is then the owner's and others' bits, and a script made executable stays so.
    asRun(['chmod', '-R', 'g-x,u+rwX', ...workDirs]);
    asRun(['setfacl', '-R', '-m', `u:${me}:rwX,d:u:${me}:rwX`, ...workDirs]);
    const blocked = spawnSync('find', [...workDirs, '!', '-type', 'l', '(', '!', '-readable', '-o', '-type', 'd', '!', '-executable', ')', '-print', '-quit'],
      { env: sudoEnv, encoding: 'utf8' });
    const stuck = String(blocked.stdout ?? '').trim();
    if (stuck) throw new Error(`the run account left a path this account cannot reach: ${relative(root, stuck).slice(0, 200)}`);
  };
  const acl = (args) => { const r = spawnSync('setfacl', args, { env: sudoEnv, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`setfacl failed: ${String(r.stderr || r.error?.message || '').trim().slice(0, 200)}`); };
  // What the run account may do in a checkout and a HOME: write both, read the checkout's .git
  // and never write it. Default ACLs keep what it creates manageable here.
  const grant = (dir, dirHome) => {
    acl(['-R', '-m', `u:${runAs}:rwX,d:u:${runAs}:rwX,d:u:${me}:rwX`, dir]);
    acl(['-R', '-m', `u:${runAs}:rX,d:u:${runAs}:rX`, join(dir, '.git')]);
    acl(['-m', `u:${runAs}:rwx,d:u:${runAs}:rwX,d:u:${me}:rwX`, dirHome]);
  };
  // While the test gate runs (gateTests), the run account is denied this checkout and the
  // commands' HOME, so its suite reads neither; letIn gives both back. Nothing outside them is
  // removed or hidden: the exec rows' sandbox gives the job a /tmp of its own and lets it make no
  // namespace, so there is no private filesystem to give the suite, and a path a command left in
  // the job's temporary directories, named again by the suite, is not covered by the gate. The
  // pull request's own CI runs the suite where none of it exists.
  const shutOut = () => { for (const d of [root, home]) acl(['-m', `u:${runAs}:---`, d]); };
  const letIn = () => { for (const d of [root, home]) acl(['-m', `u:${runAs}:rwx`, d]); };
  // Every command the checkout supplies goes through here.
  const exec = (argv, seconds, extraEnv = {}) => { const r = run(root, { ...cenv, ...extraEnv }, argv, seconds, runAs); settle(); return r; };
  try {
    if (git(root, genv, ['rev-parse', 'HEAD'], { allowFail: true }) !== start) return refuse(words.notAtStart);
    if (changedPaths(root, genv).length) return refuse('the checkout is not clean');
    // The marks as the start commit has them, before any command can touch the checkout.
    const attrs = headAttributes(root, genv, start);
    // The .github files this run may write, pinned to the start commit: the compare with that
    // commit, each path checked against the blob its tree holds. Null: nothing there is written.
    const github = job.githubChanges === null ? null : editableGithub(job.githubChanges, headBlobs(root, genv, start));

    if (runAs) {
      // The run account must work, must not read the key or the brief, may write the checkout
      // but not its .git (whose config a command could otherwise point git at its own code), and
      // gets a scratch HOME of its own. Default ACLs keep what it creates manageable here.
      const id = asRun(['id', '-u']);
      if (id.status !== 0) return refuse(`commands cannot run as the run account: \`sudo -n -u ${runAs}\` failed`);
      const uidProblem = runAccountUidProblem(id.stdout, process.getuid?.());
      if (uidProblem) return refuse(uidProblem);
      for (const f of (ctx.guardFiles ?? []).filter(Boolean)) {
        if (runCan('-r', f)) return refuse(`the run account can read ${basename(f)}, which holds what it must never see`);
      }
      for (const s of (ctx.guardSockets ?? []).filter(Boolean)) {
        if (runCan('-w', s)) return refuse(`the run account can connect to ${basename(s)}, dario's key socket, and spend its key`);
      }
      // This account's git works on a private copy of .git that the run account cannot reach: the
      // checkout's own .git, which a command could rename and replace (its directory is writable),
      // is never read by this process again.
      try {
        const privateGit = join(gitHome, 'git');
        cpSync(git(root, genv, ['rev-parse', '--absolute-git-dir']), privateGit, { recursive: true });
        Object.assign(genv, { GIT_DIR: privateGit, GIT_WORK_TREE: realpathSync(root) });
      } catch (e) { return refuse(`the checkout's .git could not be copied aside: ${String(e.message).slice(0, 200)}`); }
      try { grant(root, home); } catch (e) { return refuse(e.message); }
      if (!runCan('-w', root)) return refuse('the run account cannot write the checkout (check that every directory above it is searchable)');
      if (runCan('-w', join(root, '.git'))) return refuse('the run account can write the checkout\'s .git');
      armed = true;
    } else {
      ctx.log?.(`::warning::FIX_RUN_AS is not set: the checkout's commands run as this account, which can ${(ctx.guardSockets ?? []).some(Boolean) ? 'spend the model key through dario\'s key socket' : 'read the model key'}`);
    }

    // Toolchain: detected once, installed once, before the model sees anything.
    const rootFiles = readdirSync(root);
    let pkg = null;
    try { pkg = rootFiles.includes('package.json') ? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) : null; } catch { pkg = null; }
    const plan = detectRunner(rootFiles, pkg);
    let installNote = 'no package.json, nothing installed';
    if (plan.berry) {
      const v = exec(['yarn', '--version'], 60, plan.installEnv);
      plan.install = v.exit === 0 ? berryInstall(v.out) : null;
      if (!plan.install) installNote = `nothing installed: \`yarn --version\` gave no yarn 2+ version (exit ${v.exit}), so no install could skip dependencies' builds`;
    }
    if (job.replay) {
      plan.install = null;
      installNote = 'a verify run installs in the test gate\'s checkout alone';
    }
    if (plan.install) {
      const r = exec(plan.install, LIMITS.installS, plan.installEnv);
      installNote = `\`${plan.install.join(' ')}\` exited ${r.exit}${r.exit ? ` (tail: ${r.out.slice(-600).replace(/\s+/g, ' ')})` : ''}`
        + '; dependency install scripts were skipped, so run the build script first if the tests need its output';
      ctx.log?.(`install: ${installNote.slice(0, 200)}`);
    }
    const installDirty = changedPaths(root, genv);

    const written = new Set();
    let description = null; // fix_describe's text, set as the PR body by the ops tick
    // The fix as it would be staged now: everything changed minus what the contract leaves out.
    // A command may have staged or committed on its own, so HEAD and the index go back to the
    // start commit first (the working tree is kept): every check, the test gate in finalize
    // included, sees all of the change against the start commit, and the commit is the whole of it.
    const sizeOf = (p) => { try { return statSync(join(root, p)).size; } catch { return 0; } };
    const staged = () => {
      git(root, genv, ['reset', '-q', start]);
      const changed = changedPaths(root, genv);
      return stageable(changed, { installDirty, written, sizeOf, protectedSet: protectedPaths(attrs, changed), github, work: words.work });
    };
    // The kept paths staged as one tree, the candidate the commit would be: its id, and the paths.
    const candidate = () => {
      const { keep } = staged();
      // Literal pathspecs: a file a command named `*` must not stage everything.
      if (keep.length) git(root, genv, ['--literal-pathspecs', 'add', '-A', '--', ...keep]);
      const tree = git(root, genv, ['write-tree']);
      git(root, genv, ['reset', '-q', start]);
      return { tree, keep };
    };
    const testArgv = plan.pm && plan.scripts.includes('test') ? [plan.pm, 'test'] : null;
    // Whether the model ran the build script here: the gate runs it again before the suite, since
    // a suite that reads the build's output (an ignored dist/) needs it, and the output made here
    // is not carried over.
    let ranBuild = false;
    // The toolchain the candidate declares, as detectRunner reads the checkout's: the names at the
    // tree's root and its package.json. The gate runs what the change declares, a first test script
    // or a new package manager among it; the allowlist the model works with stays the start's.
    // `broken`, saying why, when a package.json is there and cannot be read: the gate cannot say
    // what to run. A package.json that is a link, or that sits behind one, is read through it as
    // the checkout and npm read it, to a file in the same tree (blobAt); a link out of the tree is
    // refused.
    // A path in the tree as the checkout would open it: every component, a directory's as well as
    // the file's, is followed when it is a link, to a path that stays inside the tree, at most
    // eight links in all. Returns { sha } of the blob it reaches, or { broken } saying why not.
    const blobAt = (tree, wanted) => {
      let parts = wanted.split('/').filter(Boolean);
      let at = tree;
      let done = [];
      for (let links = 0; parts.length;) {
        const [name, ...rest] = parts;
        if (name === '.') { parts = rest; continue; }
        if (name === '..') {
          if (!done.length) return { broken: `the change's package.json leads outside the checkout` };
          done = done.slice(0, -1);
          at = done.length ? (git(root, genv, ['rev-parse', `${tree}:${done.join('/')}`]) ?? '') : tree;
          parts = rest;
          continue;
        }
        const [meta = ''] = (git(root, genv, ['ls-tree', '-z', at, '--', name]) ?? '').split('\t');
        const [mode, type, sha] = meta.split(' ');
        if (!sha) return { broken: `the change's package.json leads to ${[...done, name].join('/')}, which is not in it` };
        if (mode === '120000') {
          if (++links > 8) return { broken: 'the change\'s package.json goes through more than eight links' };
          const target = git(root, genv, ['cat-file', 'blob', sha]) ?? '';
          if (posix.isAbsolute(target)) return { broken: `the change's package.json links to ${target.slice(0, 120)}, outside the checkout` };
          parts = [...target.split('/').filter(Boolean), ...rest];
          continue;
        }
        if (!rest.length) return type === 'blob' ? { sha } : { broken: `the change's package.json is not a file (${[...done, name].join('/')})` };
        if (type !== 'tree') return { broken: `the change's package.json leads through ${[...done, name].join('/')}, which is not a directory` };
        at = sha;
        done = [...done, name];
        parts = rest;
      }
      return { broken: 'the change\'s package.json names no file' };
    };
    const manifestOf = (tree) => {
      const found = blobAt(tree, 'package.json');
      return 'broken' in found ? found : { text: git(root, genv, ['cat-file', 'blob', found.sha]) ?? '' };
    };
    const planOf = (tree) => {
      const names = (git(root, genv, ['ls-tree', '-z', '--name-only', tree]) ?? '').split('\0').filter(Boolean);
      if (!names.includes('package.json')) return { plan: detectRunner(names, null) };
      const m = manifestOf(tree);
      if ('broken' in m) return m;
      try { return { plan: detectRunner(names, JSON.parse(m.text)) }; } catch { return { broken: 'the change\'s package.json does not parse, so what its tests are cannot be read' }; }
    };
    // The test gate. The suite runs on the candidate tree alone, in a checkout of its own made from
    // the tree's objects, with the install (and the build, when the model ran it) run there afresh
    // and a HOME of its own, and never in this checkout: an ignored file a command left here (a
    // local config, a build's output), a file in the commands' HOME, or a change the commit leaves
    // out can make a suite pass here that fails on the commit. What the suite writes there is
    // thrown away with it, so the commit is the tree that was tested and nothing the suite did. With
    // a run account the suite cannot reach this checkout or the commands' HOME (shutOut). A path
    // outside the checkouts and HOMEs, which a command and the suite can each name, is not covered.
    // The gate's checkout has a .git of its own, a copy of this process's, with HEAD and the index
    // at a commit of the candidate on the start commit, and the run account's git trusts that
    // checkout alone, from a config it can read and not change, so a suite that finds its tests
    // through git finds them. The first step that fails is the
    // result: an install or a build that fails fails the gate, whatever a test would say after it.
    // Returns { command, exit, out, timedOut, tree, stage } (stage: manifest, install, build or
    // test), or null when neither the start commit nor the change has a test script.
    const gateTests = (tree, subject) => {
      const found = planOf(tree);
      if ('broken' in found) return { command: 'package.json', exit: 1, out: found.broken, timedOut: false, tree, stage: 'manifest' };
      const p = found.plan;
      const testCmd = p.pm && p.scripts.includes('test') ? [p.pm, 'test'] : null;
      if (!testCmd) {
        if (!testArgv) return null;
        return { command: 'package.json', exit: 1, out: `the change leaves no \`test\` script in package.json, and the start commit has one (\`${testArgv.join(' ')}\`)`, timedOut: false, tree, stage: 'manifest' };
      }
      ctx.log?.('  running the test script in a clean checkout of the change');
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'redline-gate-')));
      const gateHome = mkdtempSync(join(tmpdir(), 'redline-gate-home-'));
      // The run account's git config for the gate: this checkout is safe, and nothing else is
      // set. In a directory of this account's, which the run account reads and cannot change.
      const trust = mkdtempSync(join(tmpdir(), 'redline-gate-trust-'));
      const genvGate = { ...genv, GIT_DIR: join(dir, '.git'), GIT_WORK_TREE: dir };
      const result = (stage, argv, exit, out, timedOut = false) => ({ command: argv.join(' '), exit, out, timedOut, tree, stage });
      try {
        cpSync(git(root, genv, ['rev-parse', '--absolute-git-dir']), join(dir, '.git'), { recursive: true });
        // HEAD, the index and the files all the candidate: a commit of its tree on the start commit,
        // with the subject it would carry, so a suite that finds its tests through git finds them.
        git(dir, genvGate, ['read-tree', tree]);
        git(dir, genvGate, ['checkout-index', '-a', '-f']);
        const who = { GIT_AUTHOR_NAME: AUTHOR.name, GIT_AUTHOR_EMAIL: AUTHOR.email, GIT_COMMITTER_NAME: AUTHOR.name, GIT_COMMITTER_EMAIL: AUTHOR.email };
        git(dir, genvGate, ['update-ref', '--no-deref', 'HEAD', git(dir, { ...genvGate, ...who }, ['commit-tree', tree, '-p', start, '-m', subject])]);
        const gitTrust = join(trust, 'gitconfig');
        writeFileSync(gitTrust, `[safe]\n\tdirectory = ${dir}\n`);
        // The modes set outright: a file's creation mode passes through this account's umask.
        chmodSync(gitTrust, 0o644);
        chmodSync(trust, 0o755);
        if (runAs) {
          grant(dir, gateHome);
          shutOut();
        }
        workDirs.push(dir, gateHome);
        const env = { ...childEnv(ctx.env ?? process.env, gateHome, ctx.proxy), ...(runAs ? { GIT_CONFIG_GLOBAL: gitTrust } : {}) };
        const gexec = (argv, seconds, extraEnv = {}) => { const r = run(dir, { ...env, ...extraEnv }, argv, seconds, runAs); settle(); return r; };
        // A step with no time left is a failed step: a change is never reported without its tests.
        const step = (stage, argv, cap, extraEnv = {}) => {
          const s = secondsLeft(cap);
          return s ? gexec(argv, s, extraEnv) : { exit: 124, out: `not run: the time budget was spent before the ${stage} in the clean checkout`, timedOut: true };
        };
        let install = p.install;
        if (p.berry) {
          const v = step('install', ['yarn', '--version'], 60, p.installEnv);
          install = v.exit === 0 ? berryInstall(v.out) : null;
          if (!install) return result('install', ['yarn', '--version'], v.exit || 1, `\`yarn --version\` gave no yarn 2+ version (exit ${v.exit}), so no install could skip dependencies' builds:\n${v.out}`, v.timedOut);
        }
        if (install) {
          const i = step('install', install, LIMITS.installS, p.installEnv);
          if (i.exit !== 0) return result('install', install, i.exit, i.out, i.timedOut);
        }
        if (ranBuild && p.scripts.includes('build')) {
          const b = step('build', [p.pm, 'run', 'build'], LIMITS.runMaxS);
          if (b.exit !== 0) return result('build', [p.pm, 'run', 'build'], b.exit, b.out, b.timedOut);
        }
        const t = step('test', testCmd, LIMITS.runMaxS);
        return result('test', testCmd, t.exit, t.out, t.timedOut);
      } finally {
        workDirs.splice(2);
        if (runAs) letIn();
        for (const d of [dir, gateHome, trust]) {
          try { rmSync(d, { recursive: true, force: true }); } catch (e) { ctx.log?.(`::warning::could not remove ${d}: ${e.code ?? e.message}`); }
        }
      }
    };

    const tool = (name, input) => {
      if (name === 'fix_list') return readTool(root, 'redline_list', input);
      if (name === 'fix_read') return readTool(root, 'redline_read', input);
      if (name === 'fix_search') return readTool(root, 'redline_search', input);
      if (name === 'fix_write') {
        try {
          const abs = safeWritePath(root, input.path, github, words.lane);
          const content = String(input.content ?? '');
          if (Buffer.byteLength(content) > LIMITS.writeBytes) return `error: content is larger than ${LIMITS.writeBytes} bytes`;
          const rel = relative(realpathSync(root), abs).split(sep).join('/');
          const landing = landingPath(root, abs);
          const marked = protectedPaths(attrs, [...new Set([rel, landing])]);
          if (marked.has(rel) || marked.has(landing)) return `error: ${landing} is marked ${PROTECTED_ATTR} in .gitattributes: it is captured data and is never edited here. Leave it as it is and say in the summary that ${words.protectedNote}`;
          const now = staged().keep;
          if (!now.includes(rel) && now.length >= LIMITS.files) return `error: the ${words.work} already changes ${now.length} files, the limit; no further file is written`;
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, content);
          written.add(rel);
          return `wrote ${rel} (${content.split('\n').length} lines)`;
        } catch (e) { return `error: ${e.message}`; }
      }
      if (name === 'fix_describe') {
        const why = job.describe.problem(input.body);
        if (why) return `error: ${why}`;
        description = String(input.body).replace(/\r\n/g, '\n').trim();
        return job.describe.kept(description.split('\n').length);
      }
      if (name === 'fix_run') {
        const a = allowedArgv(input.command, plan, root);
        if (a.error) return `error: ${a.error}`;
        const s = secondsLeft(Math.min(LIMITS.runMaxS, Math.max(1, Number(input.timeout_seconds) || LIMITS.runDefaultS)));
        if (!s) return 'error: the time budget is spent; call finish_fix now';
        if (a.argv[0] === plan.pm && a.argv[1] === 'run' && a.argv[2] === 'build') ranBuild = true;
        const r = exec(a.argv, s);
        return `exit ${r.exit}${r.timedOut ? ' (timed out)' : ''}\n${capOutput(r.out)}`;
      }
      return `error: unknown tool ${name}`;
    };

    let bounces = 0;
    let tests = null;
    let askedToDescribe = false;
    // Edits the commit will not carry (staged().skipped: a protected file, .github/ where nothing
    // there is written, a .gitattributes, an install's own change, a file over the size limit) are
    // never in the gate's checkout, which holds the candidate tree alone. Once a gate has run they
    // are put back here as the start commit has them, by this process's git, so the checkout the
    // model goes on working in is the tree the gate tested; with no test script anywhere no gate
    // runs and nothing is put back. What was put back is kept for the notes, which name every file
    // left out.
    const undone = new Map();
    const undoSkipped = () => {
      const { skipped } = staged();
      for (const { path, why } of skipped) {
        const tracked = git(root, genv, ['cat-file', '-e', `${start}:${path}`], { allowFail: true }) !== null;
        if (tracked) git(root, genv, ['--literal-pathspecs', 'checkout', start, '--', path]);
        else git(root, genv, ['--literal-pathspecs', 'clean', '-f', '-q', '--', path]);
        undone.set(path, why);
      }
      git(root, genv, ['reset', '-q', start]);
      return skipped.map((x) => x.path);
    };
    const finalize = async (input) => {
      const checked = checkFinish(input, job.subject);
      if (checked.error) return checked;
      if (checked.sub.outcome === 'refused') return { sub: checked.sub };
      // Where a change needs a description of its own, one that comes without is sent back once.
      if (job.describe.required && description === null && !askedToDescribe && staged().keep.length) {
        askedToDescribe = true;
        return { error: job.describe.ask };
      }
      if (staged().keep.length) {
        // The tree is the kept paths alone, so it is the same before and after a left-out edit is put back.
        const t = gateTests(candidate().tree, checked.sub.subject);
        // A change with no test script anywhere has no tests to report, whatever an earlier one had.
        tests = t;
        if (t) {
          const putBack = undoSkipped();
          if (t.exit !== 0 && bounces < LIMITS.testBounces) {
            bounces++;
            const failed = t.stage === 'test' ? failingTests(t.out) : [];
            const named = failed.length ? `\nFailed: ${failed.join(', ')}` : '';
            const what = { install: 'The install fails', build: 'The build script fails', test: 'The test script fails' }[t.stage];
            const head = t.stage === 'manifest' ? `The change cannot be tested: ${t.out}.`
              : `${what} at your change, in a clean checkout of it (\`${t.command}\` exited ${t.exit}${t.timedOut ? ', timed out' : ''}):${named}\n${capOutput(t.out, 6_000)}`;
            return { error: `${head}\n\nThe gate checks out the change alone, with a HOME of its own, installs afresh${ranBuild ? ', runs the build script' : ''} and runs the tests: a file the commit does not carry (an ignored one, or one left out) is not there.`
              + `${putBack.length ? `\n\nThese edits are not in the commit, so the gate ran without them, and they are now put back here as the start commit has them: ${putBack.join(', ')}.` : ''}\n\nFix it and run the tests again, then call finish_fix.` };
          }
        }
      }
      return { sub: checked.sub };
    };

    let loop;
    let calls = 0;
    if (job.replay) {
      // A verify run: the candidate's tree in this checkout as the model's edits were (the index
      // and HEAD stay at the start commit), every path it changes counted as written, and the
      // gate run once. A failing gate is the result: there is no model to answer it.
      const r = job.replay;
      git(root, genv, ['read-tree', '-m', '-u', start, r.tree]);
      git(root, genv, ['reset', '-q', start]);
      for (const p of changedPaths(root, genv)) written.add(p);
      ranBuild = r.ranBuild === true;
      description = typeof r.description === 'string' ? r.description : null;
      bounces = LIMITS.testBounces;
      const f = await finalize({ outcome: 'fixed', subject: r.subject, summary: r.summary, tests_run: r.tests_run });
      if (f.error) return refuse(`the candidate could not be finished: ${f.error}`, { turns: r.turns });
      loop = { turns: r.turns, sub: f.sub };
    } else {
      const brief = job.brief({ plan, installNote, githubFiles: github ? [...github].sort() : [], attrs, git: (args) => git(root, genv, args) });
      try {
        loop = await runLoop({
          call: (messages, toolChoice) => (calls++, callModelWith(ctx, { system: ctx.system, messages, tools: job.tools, toolChoice, maxTokens: LIMITS.maxTokens, timeoutMs: LIMITS.modelTimeoutMs, deadline, effort: job.effort })),
          tool: async (name, input) => tool(name, input), finalize, now: ctx.now, started, log: ctx.log, canForce: !rejectsForcedToolChoice(ctx.model),
          ask: words.ask, work: words.work,
        }, brief);
      } catch (e) {
        // Past hardMs no model call starts: nothing is reported as fixed without the model finishing.
        if (e instanceof OutOfTime) return refuse(`The time budget was spent before the ${words.work} finished (${e.message}).`, { turns: calls });
        throw e;
      }
    }
    const turns = loop.turns;
    const testsRecord = tests ? {
      command: tests.command, exit_code: tests.exit, summary: summariseTests(tests.out),
      ...(tests.exit !== 0 ? { failing: failingTests(tests.out) } : {}),
    } : null;
    if (loop.refused) return refuse(loop.refused, { turns, tests: testsRecord });
    const sub = loop.sub;
    if (sub.outcome === 'refused') return refuse(sub.reason, { turns, tests: testsRecord });

    const st = staged();
    // The notes name every file left out, those the test gate put back among them.
    const skipped = [...st.skipped, ...[...undone].filter(([path]) => !st.skipped.some((x) => x.path === path)).map(([path, why]) => ({ path, why }))];
    // A change that needs a description and never got one is described by what stands in for it.
    if (job.describe.required && description === null && st.keep.length) description = job.describe.fallback(sub);
    const described = description !== null;
    if (!st.keep.length) {
      // With no file changed a description is a result only where it replaces an existing one.
      const kept = described && job.describe.replaces === true;
      return { record: job.record({ outcome: 'no_change', turns, tests: testsRecord, description: kept, notes: renderNotes({ outcome: 'no_change', summary: sub.summary, skipped, tests: testsRecord, described: kept }) }), description: kept ? description : null };
    }
    if (st.keep.length > LIMITS.files) return refuse(`the ${words.work} changes ${st.keep.length} files; the limit is ${LIMITS.files}`, { turns, tests: testsRecord });
    // Literal pathspecs: a file a command named `*` must not stage everything.
    git(root, genv, ['--literal-pathspecs', 'add', '-A', '--', ...st.keep]);
    // The commit is the tree the gate tested: nothing runs between the gate and here, so a tree
    // that differs is a fault, never a change to carry untested.
    if (tests && git(root, genv, ['write-tree']) !== tests.tree) throw new Error('the change is not the tree its tests ran on');
    if (job.replay && git(root, genv, ['write-tree']) !== job.replay.tree) throw new Error('the change this verify run would commit is not the candidate\'s tree');
    const diff = git(root, genv, ['diff', '--cached', '--binary', start]) ?? '';
    const diffBytes = Buffer.byteLength(diff);
    if (diffBytes > LIMITS.diffBytes) return refuse(`the diff is ${diffBytes} bytes; the limit is ${LIMITS.diffBytes}`, { turns, tests: testsRecord });
    // The index is what the bundle carries: a clean filter (a .gitattributes rule and a .git/config
    // entry a command can write) can stage bytes the working tree does not have.
    if (leaksSecret(diff, runSecrets(ctx)) || fileWithSecret(root, st.keep, runSecrets(ctx))) {
      return refuse('The change carried a credential of this run, so nothing is committed.', { turns });
    }
    const blobIssue = stagedProblem(root, genv, st.keep, runSecrets(ctx));
    if (blobIssue) return refuse(blobIssue, { turns });
    const common = { turns, tests: testsRecord, files: st.keep };
    const notes = (outcome) => renderNotes({ outcome, summary: sub.summary, files: st.keep, skipped, tests: testsRecord, described: described && job.describe.replaces === true && outcome === 'fixed' });

    if (testsRecord && testsRecord.exit_code !== 0) {
      writeFileSync(join(out, 'diff.patch'), `${diff}\n`);
      return { record: job.record({ ...common, outcome: 'tests_failed', notes: notes('tests_failed') }) };
    }
    if (ctx.dryRun) {
      writeFileSync(join(out, 'diff.patch'), `${diff}\n`);
      return { record: job.record({ ...common, outcome: 'fixed', subject: sub.subject, description: described, notes: notes('fixed') }), description };
    }

    // One commit as askalf, hooks off, then the message is checked and the bundle written.
    // An empty hooks directory where the run account cannot reach: its HOME is writable to it, and
    // --no-verify does not skip post-commit.
    const hooks = join(gitHome, 'no-hooks');
    mkdirSync(hooks, { recursive: true });
    git(root, genv, ['-c', `user.name=${AUTHOR.name}`, '-c', `user.email=${AUTHOR.email}`, '-c', `core.hooksPath=${hooks}`,
      'commit', '--quiet', '--no-verify', '-m', sub.subject]);
    // The message is the subject alone, and the lane's own check on a commit's message
    // (job.refusedMessage) passes it.
    const message = (git(root, genv, ['log', '-1', '--format=%B']) ?? '').replace(/\n+$/, '');
    if (message !== sub.subject) throw new Error('the commit message is not the subject alone');
    if (job.refusedMessage(message)) throw new Error('the commit message carries an attribution');
    const newHead = git(root, genv, ['rev-parse', 'HEAD']);
    // The commit holds the kept paths and nothing protected, checked on the commit itself. Under
    // .github/ it holds only the PR's own files, and removes none: a fix answers a finding in a
    // workflow, it does not take the workflow away. Where nothing there is written, it holds none.
    const landed = (git(root, genv, ['diff', '--name-only', '-z', '--no-renames', start, 'HEAD']) ?? '').split('\0').filter(Boolean);
    const removed = (git(root, genv, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=D', start, 'HEAD']) ?? '').split('\0').filter(Boolean);
    const stray = landed.filter((p) => !st.keep.includes(p) || /(?:^|\/)\.gitattributes$/.test(p) || (/^\.github(?:\/|$)/.test(p) && (!github?.has(p) || removed.includes(p))));
    const marked = protectedPaths(attrs, landed);
    if (stray.length || marked.size) throw new Error(`the commit carries a path the ${words.lane} leaves out: ${[...new Set([...stray, ...marked])].join(', ').slice(0, 300)}`);
    const commits = (git(root, genv, ['log', '--format=%H%x00%s', `${start}..HEAD`]) ?? '').split('\n').filter(Boolean)
      .map((l) => { const [sha, subject] = l.split('\0'); return { sha, subject }; }).reverse();
    const bundle = join(out, job.bundle);
    git(root, genv, ['bundle', 'create', bundle, `${start}..HEAD`]);
    git(root, genv, ['bundle', 'verify', bundle]);
    return { record: job.record({ ...common, outcome: 'fixed', subject: sub.subject, newHead, commits, description: described, notes: notes('fixed') }), description,
      replay: { summary: sub.summary, tests_run: sub.tests_run ?? '', ran_build: ranBuild } };
  } finally {
    // Cleanup never replaces the result: a failure here is a warning.
    try { settle(); } catch (e) { ctx.log?.(`::warning::${e.message}`); }
    for (const dir of [home, gitHome]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch (e) { ctx.log?.(`::warning::could not remove ${dir}: ${e.code ?? e.message}`); }
    }
  }
}

// ---------- CLI ----------

/**
 * What either entry point (this file's and build.mjs's) reads from the runner host before its own
 * inputs: the env file, the prompt, the output directory, dario's address and credential, the
 * effort and lessons settings, the run account and the proxy. A setup error is annotated and ends
 * the process with 2. `work` names the lane's run in the one warning that needs it. Returns
 * { need, secrets, effort, fetchTo, ctx }: need(name) reads a variable the lane cannot run without,
 * fetchTo(origins) is the run's fetch, limited to those origins, dario and the lessons service,
 * and ctx holds the fields every lane's run reads.
 */
export function hostSetup(env, work) {
  const need = (k, src = env) => { if (!src[k]) { console.error(`::error::${k} is not set`); process.exit(2); } return src[k]; };
  let secrets;
  try { secrets = parseEnvFile(readFileSync(need('FIX_ENV_FILE'), 'utf8')); } catch (e) {
    console.error(`::error::FIX_ENV_FILE: cannot read ${env.FIX_ENV_FILE} (${e.code ?? e.message})`); process.exit(2);
  }
  let system;
  try { system = readPrompt(env, 'FIX_PROMPT_FILE'); } catch (e) { console.error(`::error::${e.message}`); process.exit(2); }
  // The runner's workspace outlives the job, so an earlier run's output is removed before this
  // one can leave anything to be uploaded.
  const out = resolve(need('FIX_OUT'));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const dario = darioAccess(secrets);
  if (dario.error) { console.error(`::error::${dario.error}`); process.exit(2); }
  if (dario.warning) console.log(`::warning::${dario.warning}`);
  const { darioUrl, darioKey, darioSocket } = dario;
  const effortSetting = String(secrets.FIX_EFFORT ?? '').trim().toLowerCase();
  if (effortSetting && !EFFORT_LEVELS.includes(effortSetting)) {
    console.log(`::warning::FIX_EFFORT is not one of ${EFFORT_LEVELS.join(', ')}; the ${work} runs with no effort field`);
  }
  const lessons = lessonsAccess(secrets);
  return {
    need, secrets,
    effort: EFFORT_LEVELS.includes(effortSetting) ? effortSetting : '',
    fetchTo: (origins) => onlyOrigins(withDarioSocket(globalThis.fetch, darioUrl, darioSocket), [...origins, darioUrl, ...(lessons ? [lessons.url] : [])]),
    ctx: {
      out,
      run: runIdentity(env),
      darioUrl, darioKey, model: secrets.FIX_MODEL || DEFAULT_MODEL,
      lessons,
      system,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(),
      dryRun: env.DRY_RUN === '1' || env.DRY_RUN === 'true',
      // The run account and the proxy are host settings, from the same env file as the key.
      runAs: secrets.FIX_RUN_AS || '', proxy: secrets.FIX_PROXY || '',
      guardFiles: [env.FIX_ENV_FILE, env.FIX_PROMPT_FILE],
      // A key socket is a credential the run account must not be able to use.
      guardSockets: [darioSocket],
    },
  };
}

/**
 * The end of either entry point: run the lane and leave its record, whatever happens. `lane` is
 * { name, run, record, save, exit }: the lane's name in the log, its run (ctx -> { record,
 * description }), its record from the fields a refusal carries, the writer of its files and the
 * exit status of a record. Ends the process.
 */
export async function runToExit(ctx, lane) {
  // The job log of a public repository is public: no line in it carries the key or the token.
  const hidden = runSecrets(ctx);
  ctx.log = (line) => console.log(maskSecrets(line, hidden));
  const refused = (reason) => lane.record({ outcome: 'refused', notes: renderNotes({ outcome: 'refused', reason }) });
  // A job killed at its timeout or cancelled still leaves the ops tick a record that says so.
  lane.save(ctx.out, refused(`The ${lane.name} run ended before it finished: the job timed out or was cancelled.`));
  let record;
  let description = null;
  let replay = null;
  try { ({ record, description = null, replay = null } = await lane.run(ctx)); } catch (e) {
    console.error(`::error::the ${lane.name} run could not finish: ${maskSecrets(e.message, hidden)}`);
    record = refused(`The ${lane.name} run could not finish: ${maskSecrets(e.message, hidden)}`);
  }
  lane.save(ctx.out, record, description, replay);
  const line = `Redline ${lane.name}: ${record.outcome}${record.new_head ? ` at ${record.new_head}` : ''}${record.files.length ? ` (${record.files.length} file${record.files.length === 1 ? '' : 's'})` : ''}`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n\n${record.notes}\n`);
  process.exit(lane.exit(record));
}

async function main() {
  const host = hostSetup(process.env, 'fix');
  const { need, secrets } = host;
  const ctx = {
    repo: need('REPO'), pr: Number(need('PR')), headSha: need('HEAD_SHA'), reviewUrl: need('REVIEW_URL'), checkout: need('CHECKOUT'),
    readToken: need('GH_READ_TOKEN'),
    effort: host.effort,
    history: String(secrets.FIX_HISTORY ?? '').trim().toLowerCase() !== 'off',
    fetch: host.fetchTo(['https://api.github.com']),
    ...host.ctx,
  };
  await runToExit(ctx, { name: 'fix', run: runFix, record: (fields) => fixRecord({ ...ctx, ...fields }), save: saveFix, exit: exitCode });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => { console.error(`::error::the fix run failed: ${e.message}`); process.exit(2); });
}
