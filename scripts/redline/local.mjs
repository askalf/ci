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
//           head's files, for the read tools).
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

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
export function changedFiles(cwd, base, head) {
  const STATUS = { A: 'added', M: 'modified', D: 'removed', R: 'renamed', C: 'copied', T: 'changed' };
  const names = git(cwd, ['diff', '-z', '--name-status', '-M', '--no-ext-diff', base, head]).split('\0');
  const files = [];
  for (let i = 0; i < names.length - 1;) {
    const code = names[i++];
    const kind = code[0];
    if (kind === 'R' || kind === 'C') files.push({ status: STATUS[kind], previous_filename: names[i++], filename: names[i++] });
    else files.push({ status: STATUS[kind] ?? 'modified', filename: names[i++] });
  }
  const numstat = git(cwd, ['diff', '-z', '--numstat', '-M', '--no-ext-diff', base, head]).split('\0');
  const counts = new Map();
  for (let i = 0; i < numstat.length - 1;) {
    const [add, del, path] = numstat[i++].split('\t');
    // A rename is `add\tdel\t` followed by the old and the new path as their own fields.
    const name = path === '' ? (i++, numstat[i++]) : path;
    counts.set(name, { additions: Number(add) || 0, deletions: Number(del) || 0 });
  }
  for (const f of files) {
    const c = counts.get(f.filename) ?? { additions: 0, deletions: 0 };
    Object.assign(f, c, { changes: c.additions + c.deletions });
    const paths = f.previous_filename ? [f.previous_filename, f.filename] : [f.filename];
    // The names are filenames, not pathspecs: `src/a[1].js` must not also select `src/a1.js`.
    const out = git(cwd, ['--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', '-M', base, head, '--', ...paths]);
    const at = out.search(/^@@/m);
    if (at >= 0) f.patch = out.slice(at).replace(/\n$/, '');
  }
  return files;
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
  const attributes = git(cwd, ['show', `${base}:.gitattributes`], { allowFail: true }) ?? '';
  let pr = null;
  let reviews = [];
  if (opts.pr) {
    const got = (opts.fetchPr ?? ((r, n) => ({ pr: ghApi(`repos/${r}/pulls/${n}`), reviews: ghApi(`repos/${r}/pulls/${n}/reviews?per_page=100`) })))(repo, opts.pr);
    if (!got?.pr?.number) throw new Error(`could not read ${repo}#${opts.pr} (is gh signed in?)`);
    pr = got.pr;
    reviews = (got.reviews ?? []).map((r) => ({ user: { login: r.user?.login ?? '' }, state: r.state, commit_id: r.commit_id, body: r.body ?? '' }));
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

/** The tar pack writes: change.json at the top, the head's tracked files under tree/. */
export function packChange(cwd, change, out = 'inherit') {
  const dir = mkdtempSync(join(tmpdir(), 'redline-local-'));
  try {
    writeFileSync(join(dir, 'change.json'), JSON.stringify(change));
    // tree/ holds the committed blobs, as CI checks them out, not a distribution archive: git archive
    // runs in an empty repository that borrows this one's objects, and its info/attributes (which
    // outrank the tree's .gitattributes) turn export-ignore and export-subst off.
    const bare = join(dir, 'archive.git');
    git(dir, ['init', '-q', '--bare', bare]);
    mkdirSync(join(bare, 'objects', 'info'), { recursive: true });
    mkdirSync(join(bare, 'info'), { recursive: true });
    writeFileSync(join(bare, 'objects', 'info', 'alternates'), `${resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'objects']).trim())}\n`);
    writeFileSync(join(bare, 'info', 'attributes'), '* -export-ignore -export-subst\n');
    // --add-file takes the --prefix before it, so change.json sits at the top and the tree under tree/.
    const r = spawnSync('git', [`--git-dir=${bare}`, 'archive', '--format=tar', '--prefix=', `--add-file=${join(dir, 'change.json')}`, '--prefix=tree/', change.head.sha],
      { cwd, stdio: ['ignore', out, 'pipe'], maxBuffer: 2 * 1024 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`git archive failed: ${String(r.stderr ?? '').trim().slice(0, 300)}`);
    return r.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    packChange(process.cwd(), change);
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
