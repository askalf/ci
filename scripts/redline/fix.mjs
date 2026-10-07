// Redline fix: the first-party answer to a Redline REQUEST_CHANGES, computed as a CI job.
//
// One run answers one review at one head. It reads the review (body findings and inline comments)
// and the PR with the workflow's read-only token, installs the checkout's dependencies once, and
// lets the model read, write and run inside the checkout until it calls finish_fix. The edits
// become one commit on top of the reviewed head, written out as a git bundle; nothing here pushes
// or comments. Forge verifies the artifact and pushes it with the token it already holds, so no
// token that can write ever sits on the runner.
//
// Output, under FIX_OUT (uploaded as the redline-fix artifact):
//   fix.json     { version, repo, pr, base_head, new_head, outcome, commits, files, tests, turns, model, notes }
//                outcome: fixed | no_change | tests_failed | refused. Always written, whatever happened.
//   notes.md     the notes field: markdown for the PR comment forge posts.
//   description.md  the PR's new description, only when fix_describe answered a finding on it
//                (fix.json `description: true`); forge sets it as the PR body.
//   fix.bundle   outcome fixed, not a dry run: the new commit, `git bundle create <base_head>..HEAD`.
//   diff.patch   a dry run, or tests_failed: the staged diff instead of a commit.
// The process exits 0 only for outcome fixed, so the job's own status says whether there is a fix.
//
// Hardening, each with a reason:
//   - The review must be a CHANGES_REQUESTED review of this PR at this head: an old review, a
//     review on another PR, a moved head or a fork PR is refused before the model is called.
//   - fix_write stays inside the checkout (symlinks resolved) and never touches .github/: a
//     workflow change from this lane would run with the PR's own permissions on the next push.
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
//     and a body naming the review, checked for trailers before the bundle is written.
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
// (default http://127.0.0.1:3456) and FIX_MODEL (default claude-opus-5-5). FIX_PROMPT_FILE names the
// system prompt, installed on the runner host: this repository is public and carries no prompt, so
// there is no bundled fallback, and a variable that is unset, a file that cannot be read or an empty
// file ends the run.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, lstatSync, realpathSync, statSync, readdirSync, appendFileSync, mkdtempSync, readlinkSync, cpSync } from 'node:fs';
import { join, resolve, relative, dirname, basename, sep, posix } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseEnvFile, readPrompt, safePath, runTool as readTool, rejectsForcedToolChoice, metaPhrase, gh, ghAll, callModelWith, buildDiff, OutOfTime, darioAccess, withDarioSocket } from './review.mjs';

export const AUTHOR = { name: 'askalf', email: '263217947+askalf@users.noreply.github.com' };
export const DEFAULT_MODEL = 'claude-opus-5-5';
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
    const plain = text.replace(/<!-- redline:(head|diff)=[0-9a-f]+ -->/g, '').trim();
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
export const PROTECTED_ATTR = 'redline-protected';

/** The paths `git check-attr -z redline-protected -- <paths>` reports as set or valued. Pure. */
export function protectedFromCheckAttr(raw) {
  const f = String(raw ?? '').split('\0');
  const out = new Set();
  for (let i = 0; i + 2 < f.length; i += 3) {
    if (f[i] && !['unspecified', 'unset', 'false'].includes(f[i + 2])) out.add(f[i]);
  }
  return out;
}

/** Why a checkout-relative path may not be written, or '' when it may. Pure. */
function writeRule(rel) {
  if (/(^|\/)(?:\.git|node_modules)(?:\/|$)/.test(rel)) return 'path is under .git or node_modules';
  if (/^\.github(?:\/|$)/.test(rel)) return 'nothing under .github/ is written by the fix lane';
  if (/(?:^|\/)\.gitattributes$/.test(rel)) return '.gitattributes is never written by the fix lane';
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
 * .git or node_modules, never under .github (a workflow or action definition changed by this lane
 * would run with the PR's own permissions on the next push) and never a .gitattributes, checked
 * on the path as named and on where it lands through any directory symlink. Returns the absolute
 * path or throws.
 */
export function safeWritePath(root, p) {
  const rel = posix.normalize(String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, ''));
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../')) throw new Error('path is outside the checkout');
  const named = writeRule(rel);
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
  const landed = writeRule(landingPath(root, abs));
  if (landed) throw new Error(`${landed} (through a directory symlink)`);
  return abs;
}

/**
 * Which changed paths become the commit. Everything the checkout shows as changed is staged
 * (`git add -A`) except: paths under .github/, a .gitattributes, paths marked redline-protected
 * (`protectedSet`), files over LIMITS.fileBytes, and paths the install step dirtied that the model
 * did not write (a lockfile rewritten by npm is not the fix). Pure: `sizeOf(path)` supplies sizes.
 * Returns { keep, skipped: [{ path, why }] }.
 */
export function stageable(paths, { installDirty = [], written = new Set(), sizeOf = () => 0, protectedSet = new Set() } = {}) {
  const keep = [];
  const skipped = [];
  for (const p of paths) {
    if (/^\.github(?:\/|$)/.test(p)) skipped.push({ path: p, why: 'under .github/' });
    else if (/(?:^|\/)\.gitattributes$/.test(p)) skipped.push({ path: p, why: 'a .gitattributes' });
    else if (protectedSet.has(p)) skipped.push({ path: p, why: `marked ${PROTECTED_ATTR}` });
    else if (installDirty.includes(p) && !written.has(p)) skipped.push({ path: p, why: 'changed by the install, not by the fix' });
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
 * The commit subject: `fix: <one line from the model>`, with the model's own prefix, issue
 * closers and refs, em dashes and trailing punctuation removed, and capped. A line that credits
 * a tool or names the machinery is replaced by the default.
 */
export function commitSubject(line) {
  let s = String(line ?? '').split('\n')[0].trim();
  s = s.replace(/\s*[\u2013\u2014]\s*/g, ', ').replace(/\s+/g, ' ');
  s = s.replace(/^(?:fix|feat|chore|refactor|docs|test|ci|build|perf|style)(?:\([^)]*\))?!?:\s*/i, '');
  s = s.replace(CLOSERS, '').replace(/(?:[\w.-]+\/[\w.-]+)?#\d+/g, '').replace(/https?:\/\/\S+/g, '').replace(/\(\s*\)/g, '');
  s = s.replace(/\s{2,}/g, ' ').replace(/^[\s,:;-]+|[\s.,:;-]+$/g, '');
  if (!s || SUBJECT_BANNED.test(s)) s = 'address the review';
  const max = LIMITS.subjectChars - 'fix: '.length;
  if (s.length > max) s = s.slice(0, max).replace(/\s+\S*$/, '').replace(/[\s.,:;-]+$/, '');
  return `fix: ${s}`;
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
  return [ctx.darioKey, ctx.readToken].filter((v) => typeof v === 'string' && v.length >= 8);
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

/** fix.json exactly as forge reads it. */
export function fixRecord({ repo, pr, headSha, newHead = null, outcome, commits = [], files = [], tests = null, turns = 0, model = '', notes = '', description = false }) {
  return { version: FIX_VERSION, repo, pr, base_head: headSha, new_head: newHead, outcome, commits, files, tests, turns, model, notes: String(notes ?? ''), description: description === true };
}

/** Why a parsed fix.json is malformed, or null. Forge applies its own checks as well. */
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
  { name: 'fix_write', description: 'Write a whole file in the checkout (created if absent). Read it first and write it back complete. Never under .github/, .git/ or node_modules/.',
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

/** Validate finish_fix input. Returns { sub } or { error }. Prose that names the machinery is bounced. */
export function checkFinish(input) {
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
  return { sub: { outcome, subject: commitSubject(input.subject), summary: str(input.summary), tests_run: str(input.tests_run) } };
}

// ---------- the loop ----------

export function capOutput(text, max = LIMITS.runOutChars) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max / 4)}\n(... ${s.length - max} chars omitted ...)\n${s.slice(-(max * 3) / 4)}` : s;
}

/**
 * The model loop with every side effect injected: ctx.call(messages, toolChoice) -> Messages
 * response, ctx.tool(name, input) -> string, ctx.finalize(input) -> { sub } | { error }, ctx.now,
 * ctx.log, ctx.canForce. Returns { sub, turns } or { refused, turns }; throws only on a broken
 * response. Text-only and empty replies are handled as in review.mjs: three in a row end the run,
 * an empty reply is not kept in the history.
 */
export async function runLoop(ctx, brief) {
  const messages = [{ role: 'user', content: `${brief}\n\nAnswer the review and finish with finish_fix.` }];
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
  return { refused: `no fix submitted within ${LIMITS.turns} turns`, turns };
}

export function buildBrief({ pr, files, headSha, review, items, plan, installNote, diff, protectedFiles = [] }) {
  const findings = review.findings;
  return [
    `Repository: ${pr.base.repo.full_name}`,
    `PR #${pr.number}: ${pr.title}`,
    `${pr.head.ref} -> ${pr.base.ref}; head ${headSha}`,
    '', 'PR description:', String(pr.body ?? '').slice(0, LIMITS.bodyChars) || '(empty)',
    '', `Files the PR changes (${files.length}):`, ...files.map((f) => `- ${f.status} +${f.additions} -${f.deletions} ${f.filename}`),
    ...(protectedFiles.length
      ? ['', `Captured data, marked ${PROTECTED_ATTR} (never written by fix_write): ${protectedFiles.join(', ')}. A finding about the text inside one of these is answered in the summary, not by an edit.`]
      : []),
    '', `Review summary: ${review.summary || '(none)'}`,
    '', `Findings (${findings.length}):`, ...findings.map(formatFinding),
    '', `Inline comments (${items.length}):`, ...items.map((c, i) => `[${i + 1}] ${c.path}${c.line ? `:${c.line}` : ''}\n${c.body}`),
    '', `Toolchain: ${plan.pm ?? 'none'}; install: ${installNote}`,
    `run accepts: ${allowedCommands(plan).join(', ')}`,
    plan.scripts.includes('test') ? `Test script: \`${plan.pm} test\`. Run it after your edits.` : 'No test script in package.json.',
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
  // Last gate before anything is uploaded: fix.json, notes.md and description.md are public
  // through forge (the description becomes the PR body), so the description is checked with them.
  if (leaksSecret(`${JSON.stringify(result.record)}\n${result.description ?? ''}`, runSecrets(ctx))) {
    for (const f of ['fix.bundle', 'diff.patch']) rmSync(join(ctx.out, f), { force: true });
    return { record: fixRecord({ repo: ctx.repo, pr: ctx.pr, headSha: ctx.headSha, model: ctx.model, outcome: 'refused', turns: result.record.turns,
      notes: renderNotes({ outcome: 'refused', reason: 'The result carried a credential of this run, so nothing from it is kept.' }) }) };
  }
  return result;
}

async function answerReview(ctx) {
  const { repo, pr: n, headSha, checkout: root, out } = ctx;
  const started = ctx.now();
  const deadline = started + LIMITS.hardMs;
  // Seconds a command may still run, inside hardMs; 0 when the budget is spent.
  const secondsLeft = (want) => { const left = Math.floor((deadline - ctx.now()) / 1000); return left < 30 ? 0 : Math.min(want, left); };
  mkdirSync(out, { recursive: true });
  const base = { repo, pr: n, headSha, model: ctx.model };
  const refuse = (why, extra = {}) => ({ record: fixRecord({ ...base, outcome: 'refused', ...extra, notes: renderNotes({ outcome: 'refused', reason: why }) }) });

  const ref = parseReviewUrl(ctx.reviewUrl);
  if (!ref) return refuse(`REVIEW_URL is not a pull request review link: ${String(ctx.reviewUrl ?? '').slice(0, 200)}`);
  if (ref.repo.toLowerCase() !== repo.toLowerCase() || ref.pr !== n) return refuse('the review link names another repository or pull request');
  const pr = await gh(ctx, `/repos/${repo}/pulls/${n}`);
  if (pr.state !== 'open') return refuse(`the pull request is ${pr.state}`);
  if (pr.head.sha !== headSha) return refuse(`the head moved to ${pr.head.sha}; dispatch again at the new head`);
  if (pr.head.repo?.full_name !== repo) return refuse('fork pull requests are not fixed here');
  const reviewRow = await gh(ctx, `/repos/${repo}/pulls/${n}/reviews/${ref.id}`);
  if (reviewRow.state !== 'CHANGES_REQUESTED') return refuse(`the review is ${reviewRow.state}, not CHANGES_REQUESTED`);
  if (reviewRow.commit_id !== headSha) return refuse(`the review is at ${reviewRow.commit_id}, not at the head`);
  const comments = await ghAll(ctx, `/repos/${repo}/pulls/${n}/reviews/${ref.id}/comments`, 3);
  const files = await ghAll(ctx, `/repos/${repo}/pulls/${n}/files`, 3);
  const review = parseReviewBody(reviewRow.body);
  const items = inlineItems(comments);
  if (!review.findings.length && !items.length) return refuse('the review has no finding to answer');

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
    asRun(['chmod', '-R', 'u+rwX', root, home]);
    asRun(['setfacl', '-R', '-m', `u:${me}:rwX,d:u:${me}:rwX`, root, home]);
    const blocked = spawnSync('find', [root, home, '!', '-type', 'l', '(', '!', '-readable', '-o', '-type', 'd', '!', '-executable', ')', '-print', '-quit'],
      { env: sudoEnv, encoding: 'utf8' });
    const stuck = String(blocked.stdout ?? '').trim();
    if (stuck) throw new Error(`the run account left a path this account cannot reach: ${relative(root, stuck).slice(0, 200)}`);
  };
  // Every command the checkout supplies goes through here.
  const exec = (argv, seconds, extraEnv = {}) => { const r = run(root, { ...cenv, ...extraEnv }, argv, seconds, runAs); settle(); return r; };
  try {
    if (git(root, genv, ['rev-parse', 'HEAD'], { allowFail: true }) !== headSha) return refuse('the checkout is not at the reviewed head');
    if (changedPaths(root, genv).length) return refuse('the checkout is not clean');
    // The marks as the reviewed head has them, before any command can touch the checkout.
    const attrs = headAttributes(root, genv, headSha);

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
      const acl = (args) => { const r = spawnSync('setfacl', args, { env: sudoEnv, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`setfacl failed: ${String(r.stderr || r.error?.message || '').trim().slice(0, 200)}`); };
      try {
        acl(['-R', '-m', `u:${runAs}:rwX,d:u:${runAs}:rwX,d:u:${me}:rwX`, root]);
        acl(['-R', '-m', `u:${runAs}:rX,d:u:${runAs}:rX`, join(root, '.git')]);
        acl(['-m', `u:${runAs}:rwx,d:u:${runAs}:rwX,d:u:${me}:rwX`, home]);
      } catch (e) { return refuse(e.message); }
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
    if (plan.install) {
      const r = exec(plan.install, LIMITS.installS, plan.installEnv);
      installNote = `\`${plan.install.join(' ')}\` exited ${r.exit}${r.exit ? ` (tail: ${r.out.slice(-600).replace(/\s+/g, ' ')})` : ''}`
        + '; dependency install scripts were skipped, so run the build script first if the tests need its output';
      ctx.log?.(`install: ${installNote.slice(0, 200)}`);
    }
    const installDirty = changedPaths(root, genv);

    const written = new Set();
    let description = null; // fix_describe's text, set as the PR body by forge
    // The fix as it would be staged now: everything changed minus what the contract leaves out.
    // A command may have staged or committed on its own, so HEAD and the index go back to the
    // reviewed head first (the working tree is kept): every check, the test gate in finalize
    // included, sees all of the change against the reviewed head, and the commit is the whole of it.
    const sizeOf = (p) => { try { return statSync(join(root, p)).size; } catch { return 0; } };
    const staged = () => {
      git(root, genv, ['reset', '-q', headSha]);
      const changed = changedPaths(root, genv);
      return stageable(changed, { installDirty, written, sizeOf, protectedSet: protectedPaths(attrs, changed) });
    };
    const runs = [];
    let seq = 0;
    // The worktree's changed paths and their bytes, hashed: a test run counts for the fix only
    // while the stamp it left is the current one, however the files changed since (fix_write, or
    // a node <file> the model ran).
    // Measured against the reviewed head, as staged() measures, so a command's own commit cannot
    // hide a change from it.
    const stamp = () => {
      git(root, genv, ['reset', '-q', headSha]);
      const h = createHash('sha256');
      for (const p of changedPaths(root, genv).sort()) {
        h.update(`${p}\0`);
        try {
          const abs = join(root, p);
          const s = lstatSync(abs);
          // The executable bit as git records it (100755 or 100644): a script that lost it fails
          // the suite with the same bytes.
          h.update(s.isSymbolicLink() ? `link:${readlinkSync(abs)}` : s.isFile() ? Buffer.concat([Buffer.from(s.mode & 0o100 ? 'x:' : '-:'), readFileSync(abs)]) : 'other');
        } catch { h.update('gone'); }
        h.update('\0');
      }
      return h.digest('hex');
    };
    const testArgv = plan.pm && plan.scripts.includes('test') ? [plan.pm, 'test'] : null;
    const isTest = (argv) => testArgv !== null && argv[0] === testArgv[0] && (argv[1] === 'test' || (argv[1] === 'run' && argv[2] === 'test'));
    const record = (argv, r) => {
      const row = { command: argv.join(' '), exit: r.exit, out: r.out, timedOut: r.timedOut, seq: ++seq, isTest: isTest(argv) };
      if (row.isTest) row.stamp = stamp();
      runs.push(row);
      return row;
    };

    const tool = (name, input) => {
      if (name === 'fix_list') return readTool(root, 'redline_list', input);
      if (name === 'fix_read') return readTool(root, 'redline_read', input);
      if (name === 'fix_search') return readTool(root, 'redline_search', input);
      if (name === 'fix_write') {
        try {
          const abs = safeWritePath(root, input.path);
          const content = String(input.content ?? '');
          if (Buffer.byteLength(content) > LIMITS.writeBytes) return `error: content is larger than ${LIMITS.writeBytes} bytes`;
          const rel = relative(realpathSync(root), abs).split(sep).join('/');
          const landing = landingPath(root, abs);
          const marked = protectedPaths(attrs, [...new Set([rel, landing])]);
          if (marked.has(rel) || marked.has(landing)) return `error: ${landing} is marked ${PROTECTED_ATTR} in .gitattributes: it is captured data and is never edited here. Leave it as it is and say in the summary that this finding is about data the fix lane does not change`;
          const now = staged().keep;
          if (!now.includes(rel) && now.length >= LIMITS.files) return `error: the fix already changes ${now.length} files, the limit; no further file is written`;
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, content);
          written.add(rel);
          return `wrote ${rel} (${content.split('\n').length} lines)`;
        } catch (e) { return `error: ${e.message}`; }
      }
      if (name === 'fix_describe') {
        const why = descriptionProblem(input.body, pr.body);
        if (why) return `error: ${why}`;
        description = String(input.body).replace(/\r\n/g, '\n').trim();
        return `the PR description is replaced with this text (${description.split('\n').length} lines) when the run finishes`;
      }
      if (name === 'fix_run') {
        const a = allowedArgv(input.command, plan, root);
        if (a.error) return `error: ${a.error}`;
        const s = secondsLeft(Math.min(LIMITS.runMaxS, Math.max(1, Number(input.timeout_seconds) || LIMITS.runDefaultS)));
        if (!s) return 'error: the time budget is spent; call finish_fix now';
        const r = record(a.argv, exec(a.argv, s));
        return `exit ${r.exit}${r.timedOut ? ' (timed out)' : ''}\n${capOutput(r.out)}`;
      }
      return `error: unknown tool ${name}`;
    };

    let bounces = 0;
    let tests = null;
    const finalize = async (input) => {
      const checked = checkFinish(input);
      if (checked.error) return checked;
      if (checked.sub.outcome === 'refused') return { sub: checked.sub };
      if (testArgv && staged().keep.length) {
        // The suite runs on the files as they are now, by the model or, failing that, here.
        const now = stamp();
        let t = [...runs].reverse().find((r) => r.isTest && r.stamp === now);
        if (!t) {
          const s = secondsLeft(LIMITS.runMaxS);
          ctx.log?.(s ? '  no test run after the last edit: running the test script' : '  no test run after the last edit, and no time left to run one');
          // No time to run the suite is a failed suite: a fix is never reported without its tests.
          t = record(testArgv, s ? exec(testArgv, s) : { exit: 124, out: 'not run: the time budget was spent', timedOut: true });
        }
        tests = t;
        if (t.exit !== 0 && bounces < LIMITS.testBounces) {
          bounces++;
          const failed = failingTests(t.out);
          const named = failed.length ? `\nFailed: ${failed.join(', ')}` : '';
          return { error: `The test script fails at your change (\`${t.command}\` exited ${t.exit}${t.timedOut ? ', timed out' : ''}):${named}\n${capOutput(t.out, 6_000)}\n\nFix it and run the tests again, then call finish_fix.` };
        }
      }
      return { sub: checked.sub };
    };

    const protectedFiles = [...protectedPaths(attrs, files.map((f) => f.filename))];
    const brief = buildBrief({ pr, files, headSha, review, items, plan, installNote, diff: buildDiff(files, LIMITS.diffChars), protectedFiles });
    let loop;
    let calls = 0;
    try {
      loop = await runLoop({
        call: (messages, toolChoice) => (calls++, callModelWith(ctx, { system: ctx.system, messages, tools: TOOLS, toolChoice, maxTokens: LIMITS.maxTokens, timeoutMs: LIMITS.modelTimeoutMs, deadline })),
        tool: async (name, input) => tool(name, input), finalize, now: ctx.now, started, log: ctx.log, canForce: !rejectsForcedToolChoice(ctx.model),
      }, brief);
    } catch (e) {
      // Past hardMs no model call starts: nothing is reported as fixed without the model finishing.
      if (e instanceof OutOfTime) return refuse(`The time budget was spent before the fix finished (${e.message}).`, { turns: calls });
      throw e;
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
    const described = description !== null;
    if (!st.keep.length) {
      return { record: fixRecord({ ...base, outcome: 'no_change', turns, tests: testsRecord, description: described, notes: renderNotes({ outcome: 'no_change', summary: sub.summary, skipped: st.skipped, tests: testsRecord, described }) }), description };
    }
    if (st.keep.length > LIMITS.files) return refuse(`the fix changes ${st.keep.length} files; the limit is ${LIMITS.files}`, { turns, tests: testsRecord });
    // Literal pathspecs: a file a command named `*` must not stage everything.
    git(root, genv, ['--literal-pathspecs', 'add', '-A', '--', ...st.keep]);
    const diff = git(root, genv, ['diff', '--cached', '--binary', headSha]) ?? '';
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
    const notes = (outcome) => renderNotes({ outcome, summary: sub.summary, files: st.keep, skipped: st.skipped, tests: testsRecord, described: described && outcome === 'fixed' });

    if (testsRecord && testsRecord.exit_code !== 0) {
      writeFileSync(join(out, 'diff.patch'), `${diff}\n`);
      return { record: fixRecord({ ...base, ...common, outcome: 'tests_failed', notes: notes('tests_failed') }) };
    }
    if (ctx.dryRun) {
      writeFileSync(join(out, 'diff.patch'), `${diff}\n`);
      return { record: fixRecord({ ...base, ...common, outcome: 'fixed', description: described, notes: notes('fixed') }), description };
    }

    // One commit as askalf, hooks off, then the message is checked and the bundle written.
    // An empty hooks directory where the run account cannot reach: its HOME is writable to it, and
    // --no-verify does not skip post-commit.
    const hooks = join(gitHome, 'no-hooks');
    mkdirSync(hooks, { recursive: true });
    git(root, genv, ['-c', `user.name=${AUTHOR.name}`, '-c', `user.email=${AUTHOR.email}`, '-c', `core.hooksPath=${hooks}`,
      'commit', '--quiet', '--no-verify', '-m', sub.subject, '-m', `Answers the review at ${ctx.reviewUrl}.`]);
    const message = git(root, genv, ['log', '-1', '--format=%B']) ?? '';
    if (hasAttributionTrailer(message)) throw new Error('the commit message carries an attribution trailer');
    const newHead = git(root, genv, ['rev-parse', 'HEAD']);
    // The commit holds the kept paths and nothing protected, checked on the commit itself.
    const landed = (git(root, genv, ['diff', '--name-only', '-z', '--no-renames', headSha, 'HEAD']) ?? '').split('\0').filter(Boolean);
    const stray = landed.filter((p) => !st.keep.includes(p) || /(?:^|\/)\.gitattributes$/.test(p) || /^\.github(?:\/|$)/.test(p));
    const marked = protectedPaths(attrs, landed);
    if (stray.length || marked.size) throw new Error(`the commit carries a path the fix lane leaves out: ${[...new Set([...stray, ...marked])].join(', ').slice(0, 300)}`);
    const commits = (git(root, genv, ['log', '--format=%H%x00%s', `${headSha}..HEAD`]) ?? '').split('\n').filter(Boolean)
      .map((l) => { const [sha, subject] = l.split('\0'); return { sha, subject }; }).reverse();
    const bundle = join(out, 'fix.bundle');
    git(root, genv, ['bundle', 'create', bundle, `${headSha}..HEAD`]);
    git(root, genv, ['bundle', 'verify', bundle]);
    return { record: fixRecord({ ...base, ...common, outcome: 'fixed', newHead, commits, description: described, notes: notes('fixed') }), description };
  } finally {
    // Cleanup never replaces the result: a failure here is a warning.
    try { settle(); } catch (e) { ctx.log?.(`::warning::${e.message}`); }
    for (const dir of [home, gitHome]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch (e) { ctx.log?.(`::warning::could not remove ${dir}: ${e.code ?? e.message}`); }
    }
  }
}

// ---------- CLI ----------

async function main() {
  const env = process.env;
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
  const ctx = {
    repo: need('REPO'), pr: Number(need('PR')), headSha: need('HEAD_SHA'), reviewUrl: need('REVIEW_URL'), checkout: need('CHECKOUT'), out,
    readToken: need('GH_READ_TOKEN'), darioUrl, darioKey, model: secrets.FIX_MODEL || DEFAULT_MODEL,
    system,
    fetch: onlyOrigins(withDarioSocket(globalThis.fetch, darioUrl, darioSocket), ['https://api.github.com', darioUrl]),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(),
    dryRun: env.DRY_RUN === '1' || env.DRY_RUN === 'true',
    // The run account and the proxy are host settings, from the same env file as the key.
    runAs: secrets.FIX_RUN_AS || '', proxy: secrets.FIX_PROXY || '',
    guardFiles: [env.FIX_ENV_FILE, env.FIX_PROMPT_FILE],
    // A key socket is a credential the run account must not be able to use.
    guardSockets: [darioSocket],
  };
  // The job log of a public repository is public: no line in it carries the key or the token.
  const hidden = runSecrets(ctx);
  ctx.log = (line) => console.log(maskSecrets(line, hidden));
  // A job killed at its timeout or cancelled still leaves forge a fix.json that says so.
  saveFix(out, fixRecord({ ...ctx, outcome: 'refused', notes: renderNotes({ outcome: 'refused', reason: 'The fix run ended before it finished: the job timed out or was cancelled.' }) }));
  let record;
  let description = null;
  try { ({ record, description = null } = await runFix(ctx)); } catch (e) {
    console.error(`::error::the fix run could not finish: ${maskSecrets(e.message, hidden)}`);
    record = fixRecord({ ...ctx, outcome: 'refused', notes: renderNotes({ outcome: 'refused', reason: `The fix run could not finish: ${maskSecrets(e.message, hidden)}` }) });
  }
  saveFix(out, record, description);
  const line = `Redline fix: ${record.outcome}${record.new_head ? ` at ${record.new_head}` : ''}${record.files.length ? ` (${record.files.length} file${record.files.length === 1 ? '' : 's'})` : ''}`;
  console.log(line);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n\n${record.notes}\n`);
  process.exit(record.outcome === 'fixed' ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => { console.error(`::error::the fix run failed: ${e.message}`); process.exit(2); });
}
