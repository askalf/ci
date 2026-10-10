#!/usr/bin/env node
// The report step of a drift watcher, as one script. The watcher decides what drifted and says so
// through three inputs; this decides nothing and reports what it is told, in three shapes: an issue
// keyed by a label, opened once and refreshed with a comment; a bot/<prefix><stamp> branch that
// carries the files the watcher changed into one pull request, kept to one open PR at a time; and
// the close of those issues on a clean run.
//
// Tokens. The pull request is created and its branch pushed with PR_TOKEN, a fine-grained PAT when
// the caller has one: a PR opened, or a branch pushed, with the job's GITHUB_TOKEN starts no
// pull_request workflow, so CI and the review would never run on it. Issues are listed, commented
// and closed with ISSUE_TOKEN, the job's own token: a PAT without Issues rights cannot comment
// (dario#1579), and the job token can whenever the job has issues: write.
//
// The push carries its token through GIT_CONFIG_* environment entries, never argv, and resets the
// checkout's persisted header first (an empty http.extraheader clears the list), so a job whose
// checkout kept the job token still pushes as the PAT.
//
// The caller's checkout is left as the watcher had it: pr-files are staged in its index, nothing
// else is touched, no branch is checked out and HEAD does not move. The commit is built in a
// temporary index and pushed by its sha.
//
// Run: node scripts/drift-report/report.mjs, configured by DR_* variables (actions/drift-report
// sets them from its inputs). report.test.mjs drives it with a fake `run` and no network.

import { readFileSync, writeFileSync, appendFileSync, existsSync, statSync, realpathSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, isAbsolute, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const SHA_PREFIX = /^bot\/[a-z0-9][a-z0-9-]*-$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// GitHub allows 50 characters in a label; ours are kebab-case, and a label is also a query term
// here, so it must not carry quotes or spaces that would need quoting.
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/;

const bool = (v, dflt = false) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '') return dflt;
  return s === 'true' || s === '1' || s === 'yes';
};
const list = (v) => String(v ?? '').split(/[\s,]+/).filter(Boolean);

/**
 * A path as git names it: forward slashes, no `./`, no repeated or trailing slash. pr-files are
 * keys into `git ls-files` and `git ls-tree` output, which print canonical paths, so `./tools/run.sh`
 * must become `tools/run.sh` before it is looked up there.
 */
export function gitPath(f) {
  const parts = [];
  for (const p of f.replace(/\\/g, '/').split('/')) {
    if (p === '' || p === '.') continue;
    parts.push(p);
  }
  return parts.join('/');
}

/** The configuration, read from the environment and validated. Throws with the first problem. */
export function readConfig(env) {
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const cfg = {
    repo: env.DR_REPO || env.GITHUB_REPOSITORY || '',
    runUrl: env.DR_RUN_URL || '',
    workflow: env.GITHUB_WORKFLOW || 'drift-report',
    workspace,
    label: (env.DR_LABEL || '').trim(),
    labelColor: (env.DR_LABEL_COLOR || 'BFD4F2').replace(/^#/, ''),
    labelDescription: env.DR_LABEL_DESCRIPTION || 'Drift this watcher reports',
    issue: bool(env.DR_ISSUE),
    issueTitle: (env.DR_ISSUE_TITLE || '').trim(),
    issueBodyFile: env.DR_ISSUE_BODY_FILE || '',
    issueBody: env.DR_ISSUE_BODY || '',
    issueMatch: env.DR_ISSUE_MATCH || 'label',
    pr: bool(env.DR_PR),
    prBranchPrefix: env.DR_PR_BRANCH_PREFIX || '',
    prFiles: list(env.DR_PR_FILES),
    prTitle: (env.DR_PR_TITLE || '').trim(),
    prBodyFile: env.DR_PR_BODY_FILE || '',
    prCommitMessage: (env.DR_PR_COMMIT_MESSAGE || '').trim(),
    prBase: (env.DR_PR_BASE || '').trim(),
    prDiff: bool(env.DR_PR_DIFF, true),
    issuePointer: bool(env.DR_ISSUE_POINTER, true),
    close: bool(env.DR_CLOSE),
    closeComment: env.DR_CLOSE_COMMENT || '',
    closeMatch: env.DR_CLOSE_MATCH || 'label',
    closeTitle: (env.DR_CLOSE_TITLE || env.DR_ISSUE_TITLE || '').trim(),
    prToken: env.DR_PR_TOKEN || '',
    issueToken: env.DR_ISSUE_TOKEN || '',
    authorName: env.DR_AUTHOR_NAME || 'drift-report[bot]',
    authorEmail: env.DR_AUTHOR_EMAIL || 'actions@github.com',
    outputFile: env.GITHUB_OUTPUT || '',
  };
  if (!REPO.test(cfg.repo)) throw new Error(`DR_REPO is not owner/name: "${cfg.repo}"`);
  if (!cfg.issue && !cfg.pr && !cfg.close) return cfg;
  if (!LABEL.test(cfg.label)) throw new Error(`label is required and must be a plain GitHub label: "${cfg.label}"`);
  if (!/^[0-9a-fA-F]{6}$/.test(cfg.labelColor)) throw new Error(`label-color must be six hex digits: "${cfg.labelColor}"`);
  if (cfg.issue && cfg.close) throw new Error('issue and close are both set: a run cannot report drift under a label and clear that label');
  for (const [k, v] of [['issue-match', cfg.issueMatch], ['close-match', cfg.closeMatch]]) {
    if (v !== 'label' && v !== 'title') throw new Error(`${k} must be label or title: "${v}"`);
  }
  if (cfg.issue) {
    if (!cfg.issueTitle) throw new Error('issue-title is required when issue is true');
    if (!cfg.issueBodyFile && !cfg.issueBody.trim()) throw new Error('issue-body-file or issue-body is required when issue is true');
    if (cfg.issueBodyFile) readText(cfg.issueBodyFile, 'issue-body-file');
    else checkLength(cfg.issueBody, 'issue-body');
    if (!cfg.issueToken) throw new Error('issue-token is required when issue is true');
  }
  if (cfg.pr) {
    if (!SHA_PREFIX.test(cfg.prBranchPrefix)) throw new Error(`pr-branch-prefix must look like bot/<name>- (lower-case, ending in a dash): "${cfg.prBranchPrefix}"`);
    // Each path is checked as written, before it is normalised: normalising first would turn
    // /tools/run.sh into tools/run.sh and accept it. What is kept is git's spelling of the path.
    if (cfg.prFiles.length === 0) throw new Error('pr-files is required when pr is true, and must name files');
    cfg.prFiles = [...new Set(cfg.prFiles.map((f) => checkFile(f, workspace)))];
    if (!cfg.prTitle) throw new Error('pr-title is required when pr is true');
    if (cfg.prBodyFile) readText(cfg.prBodyFile, 'pr-body-file');
    if (!cfg.prCommitMessage) cfg.prCommitMessage = cfg.prTitle;
    if (!cfg.prToken) throw new Error('token is required when pr is true');
    if (cfg.issuePointer && !cfg.issueToken) throw new Error('issue-token is required to point the open issue at the PR; set issue-pointer: false to skip that');
  }
  if (cfg.close) {
    if (cfg.closeMatch === 'title' && !cfg.closeTitle) throw new Error('close-title (or issue-title) is required when close-match is title');
    if (!cfg.issueToken) throw new Error('issue-token is required when close is true');
  }
  return cfg;
}

/** A body file: readable, not empty, and small enough to post with room for what is added to it. */
function readText(file, what) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { throw new Error(`${what}: cannot read ${file}: ${e.message}`); }
  if (!text.trim()) throw new Error(`${what}: ${file} is empty`);
  checkLength(text, what);
  return text;
}

function checkLength(text, what) {
  if (text.length > BODY_LIMIT - BODY_RESERVE) throw new Error(`${what} is ${text.length} characters; GitHub takes ${BODY_LIMIT} in a body, and ${BODY_RESERVE} of that are kept for what this step adds`);
}

/**
 * A pr-file must be a relative path, as written, to a regular file inside the checkout; the PR
 * carries nothing else. Returns the path as git names it.
 */
function checkFile(f, workspace) {
  if (isAbsolute(f) || /^[\\/]/.test(f) || /^[A-Za-z]:/.test(f) || f.split(/[\\/]/).includes('..')) throw new Error(`pr-files: ${f} must be a relative path inside the checkout`);
  const path = gitPath(f);
  if (path === '') throw new Error('pr-files is required when pr is true, and must name files');
  const full = resolve(workspace, path);
  if (!existsSync(full) || !statSync(full).isFile()) throw new Error(`pr-files: ${f} is not a file in the checkout`);
  const real = realpathSync(full);
  const root = realpathSync(workspace);
  const rel = relative(root, real);
  if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) throw new Error(`pr-files: ${f} resolves outside the checkout`);
  return path;
}

/** UTC stamp for a branch name, to the second: two runs a day apart never collide. */
export function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** The oldest open PR on a branch with the prefix, from this repository; a fork's branch of that name is not ours. */
export function pickPr(prs, prefix) {
  return prs
    .filter((p) => typeof p.headRefName === 'string' && p.headRefName.startsWith(prefix) && p.isCrossRepository === false)
    .sort((a, b) => a.number - b.number)[0] ?? null;
}

/** Open issues that carry the label, and the exact title when the match is by title. */
export function pickIssues(issues, match, title) {
  const list = issues.filter((i) => match === 'label' || i.title === title);
  return list.sort((a, b) => a.number - b.number);
}

/** `gh api --paginate` with a per-page --jq: one JSON object per line, every page. */
export function parseLines(text) {
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** `git ls-files -s -z` or `git ls-tree -z` output as path -> { mode, sha }: what git records for a file. */
export function parseEntries(text) {
  const out = {};
  for (const rec of text.split('\0')) {
    const m = /^(\d{6}) (?:blob )?([0-9a-f]{40,64})(?: \d+)?\t(.+)$/.exec(rec);
    if (m) out[m[3]] = { mode: m[1], sha: m[2] };
  }
  return out;
}

/** The git environment that pushes as `token`: the persisted header is cleared, then ours is added. */
export function pushEnv(base, token) {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    ...base,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${basic}`,
  };
}

/** GitHub refuses an issue or pull request body longer than this. */
export const BODY_LIMIT = 65536;
/** Room kept for the diff's notice and the footer when the caller's text is checked. */
export const BODY_RESERVE = 2048;

/**
 * The pull request body: the caller's text, the staged diff, and where it came from, within
 * BODY_LIMIT. A diff that does not fit is cut, with a line saying how much is shown; the Files
 * changed tab has the whole of it.
 */
export function prBody(text, diff, cfg) {
  const head = text.trim() ? text.trim() + '\n\n' : '';
  const where = cfg.runUrl ? `[a run](${cfg.runUrl}) of ${cfg.workflow}` : cfg.workflow;
  const foot = `\n\nOpened by ${where}. An open \`${cfg.label}\` issue closes on the first clean run after this lands.\n`;
  if (!cfg.prDiff) return head + foot.trimStart();
  const full = diff.trimEnd();
  const fence = (d, note) => `### What changes\n\n\`\`\`diff\n${d}\n\`\`\`${note ? `\n\n${note}` : ''}`;
  let body = head + fence(full) + foot;
  if (body.length > BODY_LIMIT) {
    const note = (shown) => `The diff is cut at ${shown} of ${full.length} characters; the Files changed tab has the whole of it.`;
    const room = BODY_LIMIT - (head + fence('', note(full.length)) + foot).length;
    const shown = full.slice(0, Math.max(0, room)).replace(/\n[^\n]*$/, '');
    body = head + fence(shown, note(shown.length)) + foot;
  }
  return body;
}

function defaultRun(cmd, args, { env, cwd, input } = {}) {
  const r = spawnSync(cmd, args, { env, cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { status: 127, stdout: '', stderr: r.error.message };
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Runs the report. `deps.run(cmd, args, opts)` executes a command and returns
 * { status, stdout, stderr }; `deps.now()` is the clock; `deps.log` prints. Returns the outputs.
 */
export async function report(cfg, deps = {}) {
  const run = deps.run ?? defaultRun;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((s) => console.log(s));
  const env = deps.env ?? process.env;
  const out = { 'issue-action': 'none', 'issue-number': '', 'issue-url': '', 'pr-action': 'none', 'pr-number': '', 'pr-url': '', 'pr-branch': '', closed: '0' };

  const exec = (cmd, args, opts = {}) => {
    const r = run(cmd, args, { cwd: cfg.workspace, ...opts });
    if (r.status !== 0 && !opts.allowFail) {
      throw new Error(`${cmd} ${args.filter((a) => !/^(--body|--body-file)$/.test(a)).slice(0, 6).join(' ')} failed (${r.status}): ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
    }
    return r;
  };
  // gh issue, pr and label commands take the repository through -R; gh api and gh repo view take it
  // in their argument, so those go through ghRaw.
  const gh = (token, args, opts = {}) => exec('gh', [...args, '-R', cfg.repo], { ...opts, env: { ...env, GH_TOKEN: token } });
  const ghRaw = (token, args, opts = {}) => exec('gh', args, { ...opts, env: { ...env, GH_TOKEN: token } });
  // pr-files are names, not patterns: without GIT_LITERAL_PATHSPECS a name like data[1].json would
  // match data1.json instead, and carry a file the caller never named.
  const git = (args, opts = {}) => exec('git', args, { ...opts, env: { ...(opts.env ?? env), GIT_LITERAL_PATHSPECS: '1' } });
  const json = (r) => { try { return JSON.parse(r.stdout || '[]'); } catch { throw new Error(`gh returned no JSON: ${r.stdout.slice(0, 200)}`); } };
  const tmpDir = () => mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), 'drift-report-'));
  const tmpFile = (name, text) => {
    const f = join(tmpDir(), name);
    writeFileSync(f, text);
    return f;
  };
  // The label is created when it is missing and left alone when it exists: --force would write the
  // inputs' color and description over what the repository keeps on it.
  const ensureLabel = (token) => {
    const r = gh(token, ['label', 'create', cfg.label, '--color', cfg.labelColor, '--description', cfg.labelDescription], { allowFail: true });
    if (r.status !== 0 && !/already exists/i.test(r.stderr + r.stdout)) throw new Error(`gh label create ${cfg.label} failed (${r.status}): ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}`);
  };
  // Every open issue under the label, every page: a limit would leave an issue past it open on a
  // clean run, or let a duplicate open. The issues endpoint lists pull requests too; those are not ours.
  const openIssues = (token, match, title) => pickIssues(parseLines(ghRaw(token, ['api', '--paginate',
    `repos/${cfg.repo}/issues?state=open&labels=${encodeURIComponent(cfg.label)}&per_page=100`,
    '--jq', '.[] | select(.pull_request == null) | {number, title, url: .html_url}']).stdout), match, title);

  if (cfg.issue) {
    const bodyFile = cfg.issueBodyFile || tmpFile('issue-body.md', cfg.issueBody);
    const existing = openIssues(cfg.issueToken, cfg.issueMatch, cfg.issueTitle);
    if (existing.length > 0) {
      const i = existing[0];
      gh(cfg.issueToken, ['issue', 'comment', String(i.number), '--body-file', bodyFile]);
      Object.assign(out, { 'issue-action': 'refreshed', 'issue-number': String(i.number), 'issue-url': i.url });
      log(`refreshed issue #${i.number} ${i.url}`);
    } else {
      ensureLabel(cfg.issueToken);
      const url = gh(cfg.issueToken, ['issue', 'create', '--title', cfg.issueTitle, '--body-file', bodyFile, '--label', cfg.label]).stdout.trim().split('\n').pop();
      Object.assign(out, { 'issue-action': 'created', 'issue-number': numberOf(url), 'issue-url': url });
      log(`opened issue ${url}`);
    }
  }

  if (cfg.pr) {
    // pr-files as the watcher left them, staged in the caller's index: that gives the diff for the PR
    // body and, through ls-files, the blob and mode of each file. Nothing else in the checkout is
    // touched, and no branch is checked out.
    git(['add', '--', ...cfg.prFiles]);
    const staged = parseEntries(git(['ls-files', '-s', '-z', '--', ...cfg.prFiles]).stdout);
    // Every open PR, every page: a limit would let an older drift PR fall off the end and a second
    // one open beside it. A head whose repository is gone is not ours either.
    const prs = parseLines(ghRaw(cfg.prToken, ['api', '--paginate', `repos/${cfg.repo}/pulls?state=open&per_page=100`,
      '--jq', '.[] | {number, headRefName: .head.ref, url: .html_url, isCrossRepository: ((.head.repo.full_name // "") != .base.repo.full_name)}']).stdout);
    const existing = pickPr(prs, cfg.prBranchPrefix);
    // The commit is built in a temporary index that starts as `parent` and takes pr-files alone,
    // each as the blob and mode the caller's index recorded for it (the blob is already in the
    // object store from the add above). Nothing else the watcher left staged reaches the branch,
    // a filesystem without an executable bit cannot lose the mode, and a file an ignore rule
    // matches is carried like any other, where a second `git add` against an older branch that
    // did not track it would refuse it. Returns the commit's sha, or null when the files already
    // match the parent.
    const buildCommit = (parent) => {
      const ienv = { ...env, GIT_INDEX_FILE: join(tmpDir(), 'index') };
      git(['read-tree', parent], { env: ienv });
      for (const f of cfg.prFiles) {
        const e = staged[f];
        if (!e) throw new Error(`pr-files: ${f} is not in the index after git add`);
        git(['update-index', '--add', '--cacheinfo', `${e.mode},${e.sha},${f}`], { env: ienv });
      }
      const tree = git(['write-tree'], { env: ienv }).stdout.trim();
      if (tree === git(['rev-parse', `${parent}^{tree}`]).stdout.trim()) return null;
      return git(['-c', `user.name=${cfg.authorName}`, '-c', `user.email=${cfg.authorEmail}`, 'commit-tree', tree, '-p', parent, '-m', cfg.prCommitMessage]).stdout.trim();
    };
    // The commit goes up by its sha; the caller's HEAD stays where it was.
    const push = (sha, branch) => git(['push', '-q', 'origin', `${sha}:refs/heads/${branch}`], { env: pushEnv(env, cfg.prToken) });
    const defaultBranch = () => {
      const name = json(ghRaw(cfg.prToken, ['repo', 'view', cfg.repo, '--json', 'defaultBranchRef'])).defaultBranchRef?.name;
      if (!name) throw new Error('could not read the default branch for pr-base');
      return name;
    };

    if (existing) {
      const branch = existing.headRefName;
      git(['fetch', '-q', '--depth', '1', 'origin', branch]);
      // Same blob and same mode for every file: the branch already carries what the watcher has.
      const onBranch = parseEntries(git(['ls-tree', '-z', 'FETCH_HEAD', '--', ...cfg.prFiles], { allowFail: true }).stdout);
      const same = cfg.prFiles.every((f) => onBranch[f] && staged[f] && onBranch[f].sha === staged[f].sha && onBranch[f].mode === staged[f].mode);
      Object.assign(out, { 'pr-number': String(existing.number), 'pr-url': existing.url, 'pr-branch': branch });
      const sha = same ? null : buildCommit('FETCH_HEAD');
      if (!sha) {
        out['pr-action'] = 'unchanged';
        log(`open PR ${existing.url} already carries these files`);
      } else {
        push(sha, branch);
        const where = cfg.runUrl ? `[a run](${cfg.runUrl})` : 'a run';
        try {
          gh(cfg.prToken, ['pr', 'comment', String(existing.number), '--body', `Refreshed: ${where} of ${cfg.workflow} found the files moved again; this PR now carries them.`]);
        } catch (e) {
          throw new Error(`${branch} is pushed with the new files, but ${existing.url} was not told: ${e.message}`);
        }
        out['pr-action'] = 'refreshed';
        log(`refreshed PR ${existing.url}`);
      }
    } else {
      // The base and the body are settled before the branch exists, so a failure reading them
      // leaves nothing pushed.
      const base = cfg.prBase || defaultBranch();
      const branch = `${cfg.prBranchPrefix}${stamp(now())}`;
      const diff = git(['diff', '--cached', '--', ...cfg.prFiles]).stdout;
      // The body is complete, and within GitHub's limit, before anything is pushed.
      const body = prBody(cfg.prBodyFile ? readFileSync(cfg.prBodyFile, 'utf8') : '', diff, cfg);
      const sha = buildCommit('HEAD');
      if (!sha) {
        out['pr-action'] = 'none';
        log('pr requested, but the files match the base; nothing to carry');
      } else {
        // The label the PR is opened with exists before the push, so a label that cannot be made
        // stops the run with nothing pushed. After the push, every failure names the branch.
        ensureLabel(cfg.prToken);
        const bodyFile = tmpFile('pr-body.md', body);
        push(sha, branch);
        let url;
        try {
          url = gh(cfg.prToken, ['pr', 'create', '--head', branch, '--base', base, '--title', cfg.prTitle, '--body-file', bodyFile, '--label', cfg.label]).stdout.trim().split('\n').pop();
        } catch (e) {
          throw new Error(`${branch} is pushed, but the pull request was not opened: ${e.message}`);
        }
        Object.assign(out, { 'pr-action': 'created', 'pr-number': numberOf(url), 'pr-url': url, 'pr-branch': branch });
        log(`opened PR ${url}`);
        if (cfg.issuePointer) {
          try {
            for (const i of openIssues(cfg.issueToken, 'label')) {
              gh(cfg.issueToken, ['issue', 'comment', String(i.number), '--body', `The drift this issue records has a fix open: ${url}. This issue closes on the first clean run after it lands.`]);
              log(`pointed issue #${i.number} at the PR`);
            }
          } catch (e) {
            throw new Error(`${url} is open from ${branch}, but the open issue was not pointed at it: ${e.message}`);
          }
        }
      }
    }
  }

  if (cfg.close) {
    const open = openIssues(cfg.issueToken, cfg.closeMatch, cfg.closeTitle);
    const where = cfg.runUrl ? `[a run](${cfg.runUrl})` : 'a run';
    const comment = cfg.closeComment || `Closed by ${cfg.workflow}: ${where} found no drift.`;
    for (const i of open) {
      gh(cfg.issueToken, ['issue', 'close', String(i.number), '--comment', comment]);
      log(`closed issue #${i.number}`);
    }
    out.closed = String(open.length);
  }

  if (cfg.outputFile) {
    appendFileSync(cfg.outputFile, Object.entries(out).map(([k, v]) => `${k}=${String(v).replace(/\r?\n/g, ' ')}\n`).join(''));
  }
  return out;
}

const numberOf = (url) => (/\/(\d+)\/?$/.exec(url || '') ?? [])[1] ?? '';

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const cfg = readConfig(process.env);
    await report(cfg);
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}
