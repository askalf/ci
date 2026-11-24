// Redline before the push: the same review as review.mjs, of a local branch that has no PR head yet.
//
// A finding that reaches the author only after CI costs a push, a CI run and a dispatch per round.
// This runs the review first, so the rounds happen before the push.
//
// Two halves, because the model, its keys and the reviewer's rubric live on the host and never on a
// workstation:
//
//   pack    runs in the repository to review. It writes a tar to stdout: change.json (the PR as
//           review.mjs reads it from GitHub: files with per-file patches, commits, the base's
//           .gitattributes, and with --pr the PR's title, body and earlier reviews) and tree/ (the
//           head's files as committed, for the read tools). --earlier <file>, given once per
//           file and oldest first, adds an earlier Redline verdict the author kept: a CI
//           review's verdict.json, or the saved output of an earlier `review` here. A review
//           here records nothing, and on a private repository none is posted, so without
//           them each review of a branch starts with no memory of the last.
//   review  runs on the host, on an unpacked tar: reviewChange() from review.mjs with the host's
//           env file (REDLINE_ENV_FILE) and prompt (REDLINE_PROMPT_FILE), the same model pins
//           (hostSettings), the same model routing, the same grounding. It posts nothing and
//           writes no verdict.json. Exit 0 on APPROVE, 1 on REQUEST_CHANGES, 2 when no review
//           finished.
//
//   node <ci>/scripts/redline/local.mjs pack [--base <ref>] [--pr <n>] [--title <t>] [--body-file <f>] [--earlier <file>]... \
//     | ssh <host> /opt/askalf/redline-local.sh
//
// Only committed work is reviewed: the head commit and the commits since its merge base with the base
// branch (origin's default branch unless --base names one).

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  parseEnvFile, readPrompt, darioAccess, modelContext, routeModel, reviewChange, renderBody, protectedIn, PROTECTED_ATTR, withModelsFile, REVIEWER_LOGIN,
} from './review.mjs';

const SHA = /^[0-9a-f]{40}$/;

/** git in `cwd`, stdout as text; throws with git's own message when it fails. */
export function git(cwd, args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) {
    if (allowFail) return null;
    throw new Error(`git ${args[0]} failed: ${(r.stderr || r.error?.message || '').trim().slice(0, 300)}`);
  }
  return r.stdout;
}

/** owner/name from a GitHub remote URL (https or ssh), or null. Pure. */
export function repoFromUrl(url) {
  const m = String(url ?? '').trim().match(/github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The changed files between base and head as GitHub lists a PR's files: filename, status,
 * previous_filename on a rename, additions, deletions, changes, and patch (the hunks from the first
 * @@, as GitHub sends them; absent for a binary file or a rename without changes).
 */
export function changedFiles(at, base, head) {
  const STATUS = { A: 'added', M: 'modified', D: 'removed', R: 'renamed', C: 'copied', T: 'changed' };
  // From the root: a pathspec resolves against the working directory, so in src/ the name
  // src/keep.js would be src/src/keep.js.
  const cwd = git(at, ['rev-parse', '--show-toplevel']).trim();
  // The committed text from the repository root, as GitHub diffs it: no external diff, no textconv
  // driver, no diff.relative and no diff.ignoreSubmodules from the local config.
  const DIFF = ['--no-ext-diff', '--no-textconv', '--no-relative', '--ignore-submodules=none', '-M'];
  // A patch in git's default form, whatever the local diff.* settings: three lines of context and
  // hunks apart (diff.context, diff.interHunkContext), myers with the indent heuristic
  // (diff.algorithm, diff.indentHeuristic), a blank context line kept as one space
  // (diff.suppressBlankEmpty), a submodule as its commit line (diff.submodule).
  const PATCH = ['-c', 'diff.suppressBlankEmpty=false', '-c', 'core.quotePath=false', '--literal-pathspecs', 'diff', '--no-color',
    '-U3', '--inter-hunk-context=0', '--diff-algorithm=myers', '--indent-heuristic', '--submodule=short', '--src-prefix=a/', '--dst-prefix=b/'];
  const names = git(cwd, ['diff', '-z', '--name-status', ...DIFF, base, head]).split('\0');
  const files = [];
  for (let i = 0; i < names.length - 1;) {
    const code = names[i++];
    const kind = code[0];
    if (kind === 'R' || kind === 'C') files.push({ status: STATUS[kind], previous_filename: names[i++], filename: names[i++] });
    else files.push({ status: STATUS[kind] ?? 'modified', filename: names[i++] });
  }
  const numstat = git(cwd, ['diff', '-z', '--numstat', ...DIFF, base, head]).split('\0');
  const counts = new Map();
  for (let i = 0; i < numstat.length - 1;) {
    // `add\tdel\tpath`, split at the first two tabs only: a name can hold a tab. A rename is
    // `add\tdel\t` followed by the old and the new path as their own fields.
    const rec = numstat[i++];
    const t1 = rec.indexOf('\t');
    const t2 = rec.indexOf('\t', t1 + 1);
    const [add, del, path] = [rec.slice(0, t1), rec.slice(t1 + 1, t2), rec.slice(t2 + 1)];
    const name = path === '' ? (i++, numstat[i++]) : path;
    counts.set(name, { additions: Number(add) || 0, deletions: Number(del) || 0 });
  }
  for (const f of files) {
    const c = counts.get(f.filename) ?? { additions: 0, deletions: 0 };
    Object.assign(f, c, { changes: c.additions + c.deletions });
    const paths = f.previous_filename ? [f.previous_filename, f.filename] : [f.filename];
    // Literal pathspecs: a name like src/[id].js is otherwise a glob that also matches src/i.js.
    // The a/ and b/ prefixes and unquoted non-ASCII names are the headers fileRecords() matches,
    // whatever diff.noprefix or core.quotePath say.
    const out = git(cwd, [...PATCH, ...DIFF, base, head, '--', ...paths]);
    const patches = fileRecords(out, f).map(patchOf).filter((p) => p !== undefined);
    if (patches.length) f.patch = patches.join('\n');
  }
  return files;
}

/**
 * The file records of `out` (git diff output for f's paths) that are f's own: those whose header
 * is exactly `diff --git a/<from> b/<to>`. A path's diff can hold other records: a rename's old
 * path can hold a new file, and a path is also a directory prefix (src/item removed for
 * src/item/child.js). A type change is two records under one header. Pure.
 */
export function fileRecords(out, f) {
  const header = `diff --git ${gitQuoted(`a/${f.previous_filename ?? f.filename}`)} ${gitQuoted(`b/${f.filename}`)}\n`;
  return out.split(/^(?=diff --git )/m).filter((r) => r.startsWith(header));
}

/** A path as a git diff header writes it with core.quotePath off: C-quoted when it holds a quote, a backslash or a control character. Pure. */
export function gitQuoted(path) {
  if (!/[\x00-\x1f"\\\x7f]/.test(path)) return path;
  const esc = { '\x07': 'a', '\b': 'b', '\t': 't', '\n': 'n', '\v': 'v', '\f': 'f', '\r': 'r', '"': '"', '\\': '\\' };
  return `"${[...path].map((c) => (esc[c] ? `\\${esc[c]}` : /[\x00-\x1f\x7f]/.test(c) ? `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}` : c)).join('')}"`;
}

/** A file record's hunks from the first @@, as GitHub sends a patch; undefined when it has none. Pure. */
export function patchOf(record) {
  const at = record.search(/^@@/m);
  return at < 0 ? undefined : record.slice(at).replace(/\n$/, '');
}

/** The commits base..head, oldest first, as GitHub lists a PR's commits: { sha, commit: { message } }. */
export function branchCommits(cwd, base, head) {
  return git(cwd, ['log', '--reverse', '--format=%H%x00%B%x1e', `${base}..${head}`])
    .split('\x1e').map((c) => c.replace(/^\n/, '')).filter((c) => c.includes('\0'))
    .map((c) => { const [sha, message] = c.split('\0'); return { sha, commit: { message: message.replace(/\n+$/, '') } }; });
}

/** The base ref to compare against: --base, else origin's default branch, else origin/main. */
export function baseRef(cwd, given) {
  if (given) return given;
  const head = git(cwd, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true });
  return head?.trim() || 'origin/main';
}

/** gh api, parsed; null when gh is missing or the call fails. */
function ghApi(path) {
  const r = spawnSync('gh', ['api', '--paginate', '--slurp', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  try { const pages = JSON.parse(r.stdout); return pages.length === 1 && !Array.isArray(pages[0]) ? pages[0] : pages.flat(); } catch { return null; }
}

/**
 * The line a local review prints above its verdict text, and the marker every verdict ends with:
 * the head is read from that footer, its own last line, never from a marker a finding quotes. A
 * saved file holds one review: one such line, then verdict text, then the footer.
 */
const LOCAL_REVIEW_START = /^Redline local review on /gm;
const LOCAL_REVIEW = /^Redline local review on .* \(nothing posted\): (APPROVE|REQUEST_CHANGES)\n\n([\s\S]*)$/m;
const HEAD_FOOTER = /(?:^|\n)<!-- redline:head=([0-9a-f]{40}) -->[ \t]*$/;

/**
 * An earlier Redline verdict the author kept, as { state, commit_id, body }. Two forms: the
 * verdict.json a CI review uploads (its redline-verdict artifact: event, body, head_sha), and the
 * output of an earlier `local.mjs review` saved as printed, whose head is the marker its verdict
 * ends with. Anything else is an error that names the file: a row with no head or no verdict
 * would be an earlier request the review cannot place, and a blank body one it cannot read. The
 * row carries no login: the host gives it the reviewer login it reads reviews by (reviewLocal). Pure.
 */
export function earlierReview(text, name = 'the file') {
  let v = null;
  try { v = JSON.parse(text); } catch { v = null; }
  if (v !== null && typeof v === 'object') {
    const state = v.event === 'APPROVE' ? 'APPROVED' : v.event === 'REQUEST_CHANGES' ? 'CHANGES_REQUESTED' : null;
    if (!state || typeof v.body !== 'string' || !v.body.trim() || typeof v.head_sha !== 'string' || !SHA.test(v.head_sha)) {
      throw new Error(`${name} is JSON but not a verdict.json: it needs event (APPROVE or REQUEST_CHANGES), a body that is not blank and a full head_sha`);
    }
    return { state, commit_id: v.head_sha, body: v.body };
  }
  const saved = String(text).replace(/\r\n/g, '\n');
  // Two runs in one file (tee -a) would give one run's verdict and another's head: refused, as is
  // any file whose single review is not verdict text ending in its footer.
  const runs = saved.match(LOCAL_REVIEW_START)?.length ?? 0;
  if (runs > 1) throw new Error(`${name} holds ${runs} local reviews; keep one review per file and give each its own --earlier`);
  const m = runs === 1 ? LOCAL_REVIEW.exec(saved) : null;
  const body = m ? m[2].trimEnd() : '';
  const footer = HEAD_FOOTER.exec(body);
  if (!m || !footer) throw new Error(`${name} is neither a verdict.json nor the saved output of a local review (its "Redline local review on ..." line and the head marker the verdict ends with)`);
  if (!body.slice(0, footer.index).trim()) throw new Error(`${name} has a local review line and a head marker but no verdict text between them`);
  return { state: m[1] === 'APPROVE' ? 'APPROVED' : 'CHANGES_REQUESTED', commit_id: footer[1], body: body.trim() };
}

/**
 * Everything review needs about the change, from the repository at `cwd`. opts: base, pr, title,
 * body, repo, fetchPr(repo, n) -> { pr, reviews } (gh by default) for --pr, and earlier: the
 * verdicts the author kept (earlierReview), packed apart from the PR's reviews and in the order
 * given; the host merges them after those, under its own reviewer login.
 */
export function buildChange(cwd, opts = {}) {
  const head = git(cwd, ['rev-parse', 'HEAD']).trim();
  const headRef = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const ref = baseRef(cwd, opts.base);
  const base = git(cwd, ['merge-base', ref, head]).trim();
  if (base === head) throw new Error(`HEAD is ${ref}: there is nothing to review (commit the change on a branch first)`);
  const repo = opts.repo || repoFromUrl(git(cwd, ['remote', 'get-url', 'origin'], { allowFail: true })) || 'local/repository';
  const files = changedFiles(cwd, base, head);
  if (!files.length) throw new Error(`no file differs between ${ref} and HEAD`);
  const commits = branchCommits(cwd, base, head);
  // The protected paths come from the base branch's tip, as CI reads them at pr.base.sha; the
  // merge base only bounds the diff, and the tip may have changed .gitattributes since.
  const tip = git(cwd, ['rev-parse', `${ref}^{commit}`]).trim();
  const attributes = git(cwd, ['show', `${tip}:.gitattributes`], { allowFail: true }) ?? '';
  let pr = null;
  let reviews = [];
  if (opts.pr) {
    const got = (opts.fetchPr ?? ((r, n) => ({ pr: ghApi(`repos/${r}/pulls/${n}`), reviews: ghApi(`repos/${r}/pulls/${n}/reviews?per_page=100`) })))(repo, opts.pr);
    if (!got?.pr?.number) throw new Error(`could not read ${repo}#${opts.pr} (is gh signed in?)`);
    // A failed read is not an empty history: the review would go ahead without Redline's open requests.
    if (!Array.isArray(got.reviews)) throw new Error(`could not read the reviews of ${repo}#${opts.pr}`);
    pr = got.pr;
    reviews = got.reviews.map((r) => ({ user: { login: r.user?.login ?? '' }, state: r.state, commit_id: r.commit_id, body: r.body ?? '' }));
  }
  const last = commits.at(-1)?.commit.message ?? '';
  return {
    repo,
    number: pr?.number ?? 0,
    title: opts.title ?? pr?.title ?? last.split('\n')[0],
    body: opts.body ?? pr?.body ?? '',
    author: pr?.user?.login ?? (git(cwd, ['config', 'user.name'], { allowFail: true })?.trim() || 'local'),
    head: { ref: headRef, sha: head },
    base: { ref: ref.replace(/^origin\//, ''), sha: base },
    files, commits, attributes, reviews, earlier: opts.earlier ?? [],
  };
}

/**
 * The tracked files of commit `sha` with their committed bytes: every blob `git ls-tree -r` lists,
 * read with `git cat-file`. git archive and a checkout would apply export-ignore, export-subst,
 * eol and filter settings, so the files read would not be the commit's. A symlink comes back as a
 * file holding its target, as the CI checkout of a fork head writes one; a submodule is left out.
 * Returns [{ path, executable, data }].
 */
export function committedTree(cwd, sha) {
  const entries = [];
  for (const line of git(cwd, ['ls-tree', '-r', '-z', '--full-tree', sha]).split('\0')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, obj] = line.slice(0, tab).split(' ');
    if (type === 'blob') entries.push({ path: line.slice(tab + 1), executable: mode === '100755', obj });
  }
  if (!entries.length) return [];
  // One cat-file for every blob; each answer is the line "<sha> blob <size>", the bytes, a newline.
  const r = spawnSync('git', ['cat-file', '--batch'], { cwd, input: `${entries.map((e) => e.obj).join('\n')}\n`, maxBuffer: 2 * 1024 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git cat-file failed: ${String(r.stderr ?? '').trim().slice(0, 300)}`);
  let at = 0;
  for (const e of entries) {
    const nl = r.stdout.indexOf(0x0a, at);
    const [obj, type, size] = r.stdout.toString('latin1', at, nl).split(' ');
    if (obj !== e.obj || type !== 'blob') throw new Error(`git cat-file answered ${obj} ${type} for ${e.path}`);
    e.data = r.stdout.subarray(nl + 1, nl + 1 + Number(size));
    at = nl + 1 + Number(size) + 1;
    delete e.obj;
  }
  return entries;
}

/**
 * A tar of [{ path, data, executable }] and directories [{ path, dir: true }]: ustar headers, with a
 * pax record for a path that is longer than 100 bytes or not printable ASCII. Owners are 0 and
 * times 0; the host unpacks without either. Pure.
 */
export function tarOf(entries) {
  const parts = [];
  const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512);
  const header = (name, size, type, mode) => {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8');
    h.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'ascii');
    h.write('0000000\0', 108, 'ascii');
    h.write('0000000\0', 116, 'ascii');
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    h.write('00000000000\0', 136, 'ascii');
    h.write('        ', 148, 'ascii');
    h.write(type, 156, 'ascii');
    h.write('ustar\0', 257, 'ascii');
    h.write('00', 263, 'ascii');
    let sum = 0;
    for (const byte of h) sum += byte;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    return h;
  };
  entries.forEach((e, i) => {
    let name = e.path;
    if (Buffer.byteLength(e.path) > 100 || /[^\x20-\x7e]/.test(e.path)) {
      // A pax record is "<length> path=<path>" and a newline, the length counting its own digits.
      const body = ` path=${e.path}\n`;
      let len = Buffer.byteLength(body);
      while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
      const rec = Buffer.from(`${len}${body}`);
      parts.push(header(`PaxHeaders/${i}`, rec.length, 'x', 0o644), rec, pad(rec.length));
      name = `pax-path-${i}`;
    }
    if (e.dir) parts.push(header(name, 0, '5', 0o755));
    else parts.push(header(name, e.data.length, '0', e.executable ? 0o755 : 0o644), e.data, pad(e.data.length));
  });
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/**
 * The pack: change.json at the top, the head's tracked files as committed under tree/. tree/ is its
 * own entry, so a head that removed every file still unpacks with one to read.
 */
export function packChange(cwd, change) {
  const tree = committedTree(cwd, change.head.sha).map((e) => ({ ...e, path: `tree/${e.path}` }));
  return tarOf([{ path: 'change.json', data: Buffer.from(JSON.stringify(change)), executable: false }, { path: 'tree/', dir: true }, ...tree]);
}

/** A change.json read back, checked for the fields review uses. Returns { change } or { error }. Pure. */
export function checkChange(change) {
  if (!change || typeof change !== 'object') return { error: 'change.json is not an object' };
  if (typeof change.repo !== 'string' || !change.repo) return { error: 'change.json has no repo' };
  if (!SHA.test(change.head?.sha ?? '') || !SHA.test(change.base?.sha ?? '')) return { error: 'change.json needs full head and base shas' };
  if (!Array.isArray(change.files) || !change.files.length || change.files.some((f) => typeof f?.filename !== 'string')) return { error: 'change.json has no files' };
  if (!Array.isArray(change.commits)) return { error: 'change.json has no commits' };
  const earlier = change.earlier ?? [];
  if (!Array.isArray(earlier) || earlier.some((e) => !['APPROVED', 'CHANGES_REQUESTED'].includes(e?.state) || typeof e.commit_id !== 'string' || !SHA.test(e.commit_id) || typeof e.body !== 'string' || !e.body.trim())) {
    return { error: 'change.json has an earlier verdict without a state, a full head sha and a body' };
  }
  return { change };
}

/**
 * Review an unpacked change. ctx is a review ctx without the PR fields (modelContext(), system,
 * log); dir holds change.json and tree/. Returns { verdict, body }.
 */
export async function reviewLocal(ctx, dir) {
  const checked = checkChange(JSON.parse(readFileSync(join(dir, 'change.json'), 'utf8')));
  if (checked.error) throw new Error(checked.error);
  const c = checked.change;
  const repoRef = { full_name: c.repo };
  const pr = {
    number: c.number || 0, title: String(c.title ?? ''), body: String(c.body ?? ''), user: { login: String(c.author ?? '') },
    head: { ref: String(c.head.ref ?? ''), sha: c.head.sha, repo: repoRef }, base: { ref: String(c.base.ref ?? ''), sha: c.base.sha, repo: repoRef },
  };
  const review = { ...ctx, repo: c.repo, checkout: join(dir, 'tree') };
  if (!existsSync(review.checkout)) throw new Error('the pack has no tree/');
  let protectedSet = new Set();
  try {
    protectedSet = protectedIn(String(c.attributes ?? ''), c.files.filter((f) => f.status !== 'removed').map((f) => f.filename));
  } catch (e) {
    ctx.log?.(`no path counts as ${PROTECTED_ATTR}: ${e.message}`);
  }
  routeModel(review, c.files);
  // The verdicts the author kept are Redline's by the login this host reads Redline's reviews by,
  // whatever the login was where they were packed; they follow the PR's own reviews.
  const kept = (c.earlier ?? []).map((e) => ({ user: { login: REVIEWER_LOGIN }, state: e.state, commit_id: e.commit_id, body: e.body }));
  const { review: r, verdict, notes } = await reviewChange(review, { pr, files: c.files, commits: c.commits, reviews: [...(c.reviews ?? []), ...kept], protectedSet });
  return { verdict, body: renderBody(r, verdict, c.head.sha, notes), model: review.model };
}

/** --name value pairs; a flag without a value is an error. Pure. */
/**
 * The host's settings for a review here, read as review.mjs reads them in CI: the env file's, with
 * the model pins of the file its REDLINE_MODELS_FILE names laid over them (withModelsFile). A host
 * may keep model keys in the env file for callers pinned to an older Redline; the models file is
 * what the review in CI reads on, so the review here reads on it too. `readFile` reads the models
 * file (the file system's by default). Returns { secrets, notes } or { error }.
 */
export function hostSettings(envText, readFile) {
  const pinned = withModelsFile(parseEnvFile(envText), readFile);
  return pinned.error ? { error: pinned.error } : { secrets: pinned.secrets, notes: pinned.notes };
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
    // --earlier is given once per file; every other flag once.
    if (a === '--earlier') (out.earlier ??= []).push(v);
    else out[a.slice(2)] = v;
    i++;
  }
  return out;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const mode = args._[0];
  if (mode === 'pack') {
    if (process.stdout.isTTY) { console.error('pack writes a tar: pipe it to the host (| ssh <host> /opt/askalf/redline-local.sh)'); process.exit(2); }
    if (git(process.cwd(), ['rev-parse', '--show-toplevel'], { allowFail: true }) === null) {
      console.error(`redline local: ${process.cwd()} is not in a git repository; run pack inside the repository whose branch you want reviewed (cd there first)`);
      process.exit(2);
    }
    const pr = args.pr === undefined ? 0 : Number(args.pr);
    if (!Number.isInteger(pr) || pr < 0) { console.error('--pr must be a PR number'); process.exit(2); }
    let earlier;
    try { earlier = (args.earlier ?? []).map((f) => earlierReview(readFileSync(f, 'utf8'), f)); } catch (e) {
      console.error(`redline local: ${e.message}`);
      process.exit(2);
    }
    const change = buildChange(process.cwd(), {
      base: args.base, pr, repo: args.repo, title: args.title,
      body: args['body-file'] === undefined ? undefined : readFileSync(args['body-file'], 'utf8'),
      earlier,
    });
    console.error(`redline local: ${change.files.length} file(s), ${change.commits.length} commit(s), ${change.base.ref}@${change.base.sha.slice(0, 7)}..${change.head.sha.slice(0, 7)}${change.number ? `, as ${change.repo}#${change.number}` : ''}`);
    process.stdout.write(packChange(process.cwd(), change));
    return;
  }
  if (mode === 'review') {
    const dir = args._[1];
    if (!dir) { console.error('usage: local.mjs review <dir with change.json and tree/>'); process.exit(2); }
    const env = process.env;
    let secrets;
    let system;
    try {
      if (!env.REDLINE_ENV_FILE) throw new Error('REDLINE_ENV_FILE is not set');
      const host = hostSettings(readFileSync(env.REDLINE_ENV_FILE, 'utf8'));
      if (host.error) throw new Error(host.error);
      secrets = host.secrets;
      for (const note of host.notes) console.log(note);
      system = readPrompt(env, 'REDLINE_PROMPT_FILE');
    } catch (e) { console.error(`redline local: ${e.message}`); process.exit(2); }
    const dario = darioAccess(secrets);
    if (dario.error) { console.error(`redline local: ${dario.error}`); process.exit(2); }
    const ctx = { ...modelContext(secrets, dario), system, context: '', log: (line) => console.log(line) };
    console.log(`models: routine ${ctx.model || '-'}, deep ${ctx.deepModel || '-'}${secrets.REDLINE_MODELS_FILE ? ` (pins from ${secrets.REDLINE_MODELS_FILE})` : ''}`);
    let result;
    try { result = await reviewLocal(ctx, dir); } catch (e) {
      console.error(`redline local: the review did not finish: ${e.message}`);
      process.exit(2);
    }
    console.log(`Redline local review on ${result.model} (nothing posted): ${result.verdict}\n\n${result.body}`);
    // Exit once stdout has drained: process.exit would drop what a pipe has not taken yet, the
    // head marker the verdict ends with included, and the saved review could not be read back.
    process.exitCode = result.verdict === 'REQUEST_CHANGES' ? 1 : 0;
    return;
  }
  console.error('usage: local.mjs pack [--base <ref>] [--pr <n>] [--title <t>] [--body-file <f>] [--earlier <file>]... | local.mjs review <dir>');
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => { console.error(`redline local: ${e.message}`); process.exit(2); });
}
