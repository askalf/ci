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
//           head's files as committed, for the read tools).
//   review  runs on the host, on an unpacked tar: reviewChange() from review.mjs with the host's
//           env file (REDLINE_ENV_FILE) and prompt (REDLINE_PROMPT_FILE), the same model routing,
//           the same grounding. It posts nothing and writes no verdict.json. Exit 0 on APPROVE,
//           1 on REQUEST_CHANGES, 2 when no review finished.
//
//   node <ci>/scripts/redline/local.mjs pack [--base <ref>] [--pr <n>] [--title <t>] [--body-file <f>] \
//     | ssh <host> /opt/askalf/redline-local.sh
//
// Only committed work is reviewed: the head commit and the commits since its merge base with the base
// branch (origin's default branch unless --base names one).

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  parseEnvFile, readPrompt, darioAccess, modelContext, routeModel, reviewChange, renderBody, protectedIn, PROTECTED_ATTR,
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
 * Everything review needs about the change, from the repository at `cwd`. opts: base, pr, title,
 * body, repo, and fetchPr(repo, n) -> { pr, reviews } (gh by default) for --pr.
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
    files, commits, attributes, reviews,
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
  const { review: r, verdict, notes } = await reviewChange(review, { pr, files: c.files, commits: c.commits, reviews: c.reviews ?? [], protectedSet });
  return { verdict, body: renderBody(r, verdict, c.head.sha, notes), model: review.model };
}

/** --name value pairs; a flag without a value is an error. Pure. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
    out[a.slice(2)] = v;
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
    const pr = args.pr === undefined ? 0 : Number(args.pr);
    if (!Number.isInteger(pr) || pr < 0) { console.error('--pr must be a PR number'); process.exit(2); }
    const change = buildChange(process.cwd(), {
      base: args.base, pr, repo: args.repo, title: args.title,
      body: args['body-file'] === undefined ? undefined : readFileSync(args['body-file'], 'utf8'),
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
      secrets = parseEnvFile(readFileSync(env.REDLINE_ENV_FILE, 'utf8'));
      system = readPrompt(env, 'REDLINE_PROMPT_FILE');
    } catch (e) { console.error(`redline local: ${e.message}`); process.exit(2); }
    const dario = darioAccess(secrets);
    if (dario.error) { console.error(`redline local: ${dario.error}`); process.exit(2); }
    const ctx = { ...modelContext(secrets, dario), system, context: '', log: (line) => console.log(line) };
    let result;
    try { result = await reviewLocal(ctx, dir); } catch (e) {
      console.error(`redline local: the review did not finish: ${e.message}`);
      process.exit(2);
    }
    console.log(`Redline local review on ${result.model} (nothing posted): ${result.verdict}\n\n${result.body}`);
    process.exit(result.verdict === 'REQUEST_CHANGES' ? 1 : 0);
  }
  console.error('usage: local.mjs pack [--base <ref>] [--pr <n>] [--title <t>] [--body-file <f>] | local.mjs review <dir>');
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => { console.error(`redline local: ${e.message}`); process.exit(2); });
}
