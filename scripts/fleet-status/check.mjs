#!/usr/bin/env node
// Checks a repository's fleet-status callers, as the fleet-status-check action runs it on a pull
// request: the workflows are read as text, nothing in them is executed.
//
// What it holds a repository to:
//   - fleet-status.yml refreshes on every workflow that runs on pull_request or
//     pull_request_target, runs one status job, groups and cancels only workflow_run runs, and its
//     job if: keeps a fork's pull_request and pull_request_review events out (they carry a read-only
//     token and the PR merge ref's workflow) while letting a fork's finished CI, review relay and
//     verification comments in.
//   - The status job runs actions/fleet-status of askalf/ci at a full commit sha and nothing else:
//     no checkout, no run step. That is what lets a fork's events run it with a write token.
//   - The self-test runs on pull_request (and a dispatch) alone, and runs fleet-status-check.
//   - The backfill, where there is one, is a dispatch that runs actions/fleet-status over every open PR.
//   - Every runs-on that names a self-hosted label names this repository's own one. The own-code
//     expression sends a fork's PR, a Dependabot PR and every run in a fork repository to GitHub's
//     runners; the repository-only expression, for jobs that never run PR code, is kept to the
//     workflows listed in FS_REPO_ONLY; a literal self-hosted label needs a job if: that keeps it
//     to this repository's own code; CodeQL stays on GitHub's runners.
//   - The review relay is listed, fires on pull_request_review alone, and has no token or action.
//
// The home repository and the runner label are read from the status job's runs-on, so the same
// check runs in a fork repository, where github.repository is the fork's.
//
// CLI: node check.mjs [workflows dir, default .github/workflows]
//   FS_REPO_ONLY  space-separated workflow files allowed the repository-only expression
//                 (default: fleet-status.yml fleet-status-backfill.yml)
//   FS_MIN_OWN    the fewest own-code expressions the repository uses (default 1)

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const STATUS_ACTION = 'askalf/ci/actions/fleet-status';
export const CHECK_ACTION = 'askalf/ci/actions/fleet-status-check';
export const SELF_TEST_NAME = 'Fleet status self-test';
export const RELAY_NAME = 'Fleet review relay';
export const DEFAULT_REPO_ONLY = ['fleet-status.yml', 'fleet-status-backfill.yml'];
export const GROUP = "github.event_name == 'workflow_run' && format('fleet-status-{0}-{1}-{2}', github.event.workflow_run.event, github.event.workflow_run.head_repository.full_name, github.event.workflow_run.head_branch) || format('fleet-status-run-{0}', github.run_id)";

/**
 * A small evaluator for the Actions expression subset the workflows use: string and number
 * literals, null, true, false, property paths, !, ==, !=, &&, ||, contains(), fromJSON() and
 * startsWith(). Strings compare case-insensitively, as Actions does.
 */
export function evalIf(src, ctx) {
  const toks = [];
  const re = /\s*(?:('(?:[^']|'')*')|(\d+)|(==|!=|&&|\|\||[!(),[\].])|([A-Za-z_][\w-]*))/y;
  for (let i = 0; !/^\s*$/.test(src.slice(i));) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`cannot read the expression at: ${src.slice(i, i + 30)}`);
    i = re.lastIndex;
    toks.push(m[1] ? { t: 'lit', v: m[1].slice(1, -1).replace(/''/g, "'") }
      : m[2] ? { t: 'lit', v: Number(m[2]) }
        : m[3] ? { t: m[3] } : { t: 'id', v: m[4] });
  }
  let p = 0;
  const peek = () => toks[p]?.t;
  const eat = (t) => { if (peek() !== t) throw new Error(`expected ${t} at token ${p}`); return toks[p++]; };
  const truthy = (v) => !(v === null || v === undefined || v === false || v === 0 || v === '');
  const eq = (a, b) => (typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : (a ?? null) === (b ?? null));
  const fns = {
    contains: (h, n) => (Array.isArray(h) ? h.some((x) => eq(x, n)) : String(h ?? '').toLowerCase().includes(String(n ?? '').toLowerCase())),
    fromJSON: (x) => JSON.parse(x),
    startsWith: (h, n) => String(h ?? '').toLowerCase().startsWith(String(n ?? '').toLowerCase()),
  };
  const primary = () => {
    const k = toks[p++];
    if (k?.t === 'lit') return k.v;
    if (k?.t === '(') { const v = or(); eat(')'); return v; }
    if (k?.t === '!') return !truthy(primary());
    if (k?.t !== 'id') throw new Error(`unexpected token ${p - 1}`);
    if (k.v === 'null') return null;
    if (k.v === 'true' || k.v === 'false') return k.v === 'true';
    if (peek() === '(') {
      p++;
      const args = [];
      if (peek() !== ')') for (args.push(or()); peek() === ','; p++, args.push(or()));
      eat(')');
      if (!fns[k.v]) throw new Error(`unknown function ${k.v}`);
      return fns[k.v](...args);
    }
    let v = ctx[k.v] ?? null;
    for (;;) {
      if (peek() === '.') { p++; const key = eat('id').v; v = v?.[key] ?? null; } else if (peek() === '[') { p++; const at = or(); eat(']'); v = v?.[at] ?? null; } else return v;
    }
  };
  const cmp = () => { let v = primary(); while (peek() === '==' || peek() === '!=') { const op = toks[p++].t; const r = primary(); v = op === '==' ? eq(v, r) : !eq(v, r); } return v; };
  const and = () => { let v = cmp(); while (peek() === '&&') { p++; const r = cmp(); v = truthy(v) ? r : v; } return v; };
  const or = () => { let v = and(); while (peek() === '||') { p++; const r = and(); v = truthy(v) ? v : r; } return v; };
  const v = or();
  if (p !== toks.length) throw new Error(`trailing tokens from ${p}`);
  return truthy(v);
}

/** The names in a workflow's `workflow_run: workflows: [...]`, or null when it has none. */
export function workflowRunList(y) {
  const m = /^  workflow_run:\s*\n\s+workflows:\s*\[([^\]]*)\]/m.exec(y);
  return m ? m[1].split(',').map((w) => w.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : null;
}

/** A workflow's `on:` block, comments dropped. */
export function onBlock(y) {
  const m = /^on:(.*)$/m.exec(y);
  if (!m) return '';
  const lines = [m[1]];
  for (const l of y.slice(m.index + m[0].length).split('\n').slice(1)) {
    if (/^[^\s#]/.test(l)) break;
    lines.push(l);
  }
  return lines.join('\n').replace(/#.*$/gm, '');
}

export const workflowName = (f, y) => (/^name:\s*(.+)$/m.exec(y)?.[1] ?? f).trim().replace(/^['"]|['"]$/g, '');

/** The workflows ([name, yaml]) that run on pull requests and that `list` does not name. */
export function misfits(list, workflows) {
  return workflows.filter(([name, y]) => /\bpull_request(_target)?\b/.test(onBlock(y)) && list !== null && !list.includes(name))
    .map(([name]) => name);
}

/** The job ids of a workflow. */
export const jobs = (y) => [...y.slice(Math.max(0, y.search(/^jobs:/m))).matchAll(/^  ([\w-]+):/gm)].map((m) => m[1]);

/** The `uses:` values of a workflow, in order. */
export const usesOf = (y) => [...y.matchAll(/^\s+(?:- )?uses:\s*(\S+)/gm)].map((m) => m[1]);

/** The block under the step that uses `action`, through its last more-indented line. */
function stepWith(y, action) {
  const at = new RegExp(`^(\\s+)(?:- )?uses: ${action.replace(/[.]/g, '\\.')}@[0-9a-f]{40}\\b.*\\n((?:\\1  .*\\n|\\s*\\n)*)`, 'm').exec(y);
  return at ? at[2] : null;
}

/** The status job's home repository and runner label, from its runs-on. */
export function homeOf(own) {
  const m = /^    runs-on: \$\{\{ github\.repository == '([\w.-]+\/[\w.-]+)' && fromJSON\('\["self-hosted","([\w.-]+)"\]'\) \|\| 'ubuntu-latest' \}\}$/m.exec(own);
  return m ? { home: m[1], label: m[2] } : null;
}

const readLf = (dir, f) => readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n');

/**
 * Every check on the workflows in `dir`, as [{ name, ok }].
 * @param {string} dir
 * @param {{ repoOnly?: string[], minOwn?: number }} [opts]
 */
export function checkCaller(dir, opts = {}) {
  const repoOnlyAllowed = opts.repoOnly ?? DEFAULT_REPO_ONLY;
  const minOwn = opts.minOwn ?? 1;
  const out = [];
  const check = (name, ok) => { out.push({ name, ok: Boolean(ok) }); };

  const files = readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort();
  if (!files.includes('fleet-status.yml')) {
    check('fleet-status.yml is here', false);
    return out;
  }
  const own = readLf(dir, 'fleet-status.yml');
  const beside = files.filter((f) => f !== 'fleet-status.yml').map((f) => { const y = readLf(dir, f); return { f, name: workflowName(f, y), y }; });
  const byName = (name) => beside.find((w) => w.name === name);

  // The refresh list and the triggers beside it.
  const list = workflowRunList(own);
  check('fleet-status.yml lists workflows to refresh on', (list ?? []).length > 0);
  const missing = misfits(list, beside.map((w) => [w.name, w.y]));
  check(`the workflows that run on pull requests are all listed${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`, missing.length === 0);
  check('the status job accepts workflow_run events from pull_request and pull_request_target runs',
    /\["pull_request","pull_request_target"\]/.test(own));
  check('fleet-status.yml runs only the status job, on no dispatch', jobs(own).join() === 'status' && !/\bworkflow_dispatch\b/.test(onBlock(own)));

  // A burst of finishing workflows is one status run per PR branch; nothing on the PR is cancelled.
  const group = /\n  group: \$\{\{ (.+) \}\}\n/.exec(own)?.[1] ?? '';
  const cancel = /\n  cancel-in-progress: \$\{\{ (.+) \}\}\n/.exec(own)?.[1] ?? '';
  check('workflow_run runs share a group per PR branch and triggering event; every other run has its own', group === GROUP);
  let cancels = false;
  try {
    cancels = cancel.length > 0 && evalIf(cancel, { github: { event_name: 'workflow_run' } })
      && ['pull_request', 'pull_request_review', 'issue_comment'].every((event_name) => !evalIf(cancel, { github: { event_name } }));
  } catch { cancels = false; }
  check('only a workflow_run run is cancelled by a newer one', cancels);

  // Which events run the job, for a fork and for this repository.
  const where = homeOf(own);
  check('the status job runs on this repository\'s runners here and GitHub\'s in a fork repository', where !== null);
  const HOME = where?.home ?? 'askalf/unknown';
  const LABEL = where?.label ?? 'unknown-exec';
  check(`the runner label is the repository's own (${LABEL})`, LABEL === `${HOME.split('/')[1]}-exec`);
  const FORKED = `contributor/${HOME.split('/')[1]}`;
  const cond = (/^    if: >-\n((?: {6}.*\n)+)/m.exec(own)?.[1] ?? '').split('\n').map((l) => l.trim()).join(' ').trim();
  check('the job has an if: to read', cond.length > 0);
  let readable = true;
  const runs = (github) => {
    try { return evalIf(cond, { github: { repository: HOME, ...github } }); } catch { readable = false; return false; }
  };
  const onPr = (event_name, headRepo) => runs({ event_name, event: { pull_request: { head: { repo: { full_name: headRepo } } } } });
  const onRun = (event, headRepo, prs) => runs({ event_name: 'workflow_run', event: { workflow_run: { event, head_repository: { full_name: headRepo }, pull_requests: prs } } });
  const onComment = (body, extra = {}) => runs({ event_name: 'issue_comment', event: { issue: { pull_request: { url: 'x' } }, comment: { body }, ...extra } });
  check('a fork\'s pull_request event does not run the job', !onPr('pull_request', FORKED));
  check('a fork\'s pull_request_review event does not run the job', !onPr('pull_request_review', FORKED));
  check('a same-repo pull_request and review run it', onPr('pull_request', HOME) && onPr('pull_request_review', HOME));
  check('a verification comment on a PR runs it, fork or not; one on an issue does not',
    onComment('## Verification at abc1234\n\nPassed.')
    && !runs({ event_name: 'issue_comment', event: { issue: {}, comment: { body: '## Verification at abc1234' } } }));
  check('any other comment does not run it (a preview bot, a person)',
    !onComment('Deploying with Cloudflare Workers ... preview URL') && !onComment('lgtm') && !onComment(''));
  check('a comment edited away from a verification, or a deleted one, still runs it',
    onComment('never mind', { changes: { body: { from: '## Verification at abc1234' } } })
    && onComment('## Verification at abc1234', { action: 'deleted' }));
  check('a fork\'s CI finishing runs it, though the event lists no PR', onRun('pull_request', FORKED, []));
  check('a fork\'s pull_request_target run finishing runs it', onRun('pull_request_target', FORKED, []));
  check('the review relay finishing on a fork runs it', onRun('pull_request_review', FORKED, []));
  check('the review relay finishing on a same-repo PR does not (its review event already ran)',
    !onRun('pull_request_review', HOME, [{ number: 7 }]));
  check('same-repo CI finishing runs it with a PR, not without',
    onRun('pull_request', HOME, [{ number: 7 }]) && !onRun('pull_request', HOME, []));
  check('a push or schedule run finishing does not', !onRun('push', HOME, []) && !onRun('schedule', FORKED, []));
  check('the if: is in the expression subset this check reads', readable);

  // The invariant that lets a fork run here: the job runs the pinned action and nothing else.
  const step = stepWith(own, STATUS_ACTION) ?? '';
  check(`the status job runs ${STATUS_ACTION} at a full commit sha, and no other action`,
    usesOf(own).length === 1 && new RegExp(`^${STATUS_ACTION}@[0-9a-f]{40}$`).test(usesOf(own)[0] ?? ''));
  check('the status job has no run step', !/^\s+(?:- )?run:/m.test(own));
  check('the fork path hands the action the head repo and branch',
    /head-repo: \$\{\{ github\.event\.workflow_run\.head_repository\.full_name \}\}/.test(step)
    && /head-branch: \$\{\{ github\.event\.workflow_run\.head_branch \}\}/.test(step));
  check('no step reads the PR head ref or sha', !/(pull_request\.head\.(ref|sha)|workflow_run\.head_sha)/.test(own));

  // The self-test.
  const self = byName(SELF_TEST_NAME);
  check('the self-test workflow is here', Boolean(self));
  check('the self-test workflow is listed', (list ?? []).includes(SELF_TEST_NAME));
  if (self) {
    const on = onBlock(self.y);
    check('the self-test runs on pull_request, and a dispatch, alone', /^\s+pull_request:/m.test(on)
      && !/\b(pull_request_target|pull_request_review|issue_comment|workflow_run|push|schedule)\b/.test(on));
    check('the self-test job is named self-test', jobs(self.y).join() === 'self-test');
    check(`the self-test runs ${CHECK_ACTION} at a full commit sha`, usesOf(self.y).some((u) => new RegExp(`^${CHECK_ACTION}@[0-9a-f]{40}$`).test(u)));
    check('the self-test token reads contents alone', /^    permissions:\n      contents: read\n(?! {6})/m.test(self.y) && /^permissions: \{\}$/m.test(self.y));
  }

  // The backfill, where there is one.
  const backfill = beside.find((w) => w.f === 'fleet-status-backfill.yml');
  if (backfill) {
    const bstep = stepWith(backfill.y, STATUS_ACTION) ?? '';
    check('the backfill runs on a dispatch alone', /^\s+workflow_dispatch:/m.test(onBlock(backfill.y)) && onBlock(backfill.y).replace(/\s+/g, ' ').trim() === 'workflow_dispatch:');
    check(`the backfill runs ${STATUS_ACTION} over every open PR, and nothing else`,
      usesOf(backfill.y).length === 1 && /all-open: ['"]?true['"]?/.test(bstep) && !/^\s+(?:- )?run:/m.test(backfill.y));
  }

  // runs-on: our own code on our runners, code nobody here wrote never, a fork repository never.
  const RUNS_ON = /^\s+runs-on: \$\{\{ (.+) \}\}$/;
  const ownExprs = [];
  const repoOnly = [];
  const literal = [];
  const foreign = [];
  for (const f of files) {
    const y = readLf(dir, f);
    for (const line of y.split('\n')) {
      const m = RUNS_ON.exec(line);
      const labels = [...line.matchAll(/"([\w.-]+-exec)"|\b([\w.-]+-exec)\]/g)].map((x) => x[1] ?? x[2]);
      if (labels.some((l) => l !== LABEL)) foreign.push(f);
      if (m && m[1].includes(LABEL)) (m[1].includes('github.event.pull_request') ? ownExprs : repoOnly).push({ f, e: m[1] });
      else if (new RegExp(`^\\s+runs-on: \\[self-hosted, ${LABEL.replace(/[.]/g, '\\.')}\\]`).test(line)) literal.push({ f, y });
    }
  }
  check(`every self-hosted label named is ${LABEL}${foreign.length ? ` (not in: ${[...new Set(foreign)].join(', ')})` : ''}`, foreign.length === 0);
  check(`the own-code runs-on expression is in use (at least ${minOwn})`, ownExprs.length >= minOwn);
  if (files.includes('codeql.yml')) {
    // CodeQL sizes itself to the machine, and every repository's exec runners share one host.
    const codeql = readLf(dir, 'codeql.yml');
    check('CodeQL runs on GitHub\'s runners', /^\s+runs-on: ubuntu-latest$/m.test(codeql) && !codeql.includes(LABEL));
  }
  const FORK_REPO = `someone/${HOME.split('/')[1]}`;
  const runner = (e, github, repository = HOME, matrix = { os: 'ubuntu-latest' }) => {
    for (const r of ['ubuntu-latest', 'windows-latest', 'macos-latest']) {
      try { if (evalIf(`(${e}) == '${r}'`, { github: { repository, ...github }, matrix })) return r; } catch { return 'unreadable'; }
    }
    return 'ours';
  };
  const prFrom = (event_name, headRepo, login = 'askalf') =>
    ({ event_name, event: { pull_request: { head: { repo: { full_name: headRepo } }, user: { login } } } });
  const EVENTS = ['push', 'schedule', 'workflow_dispatch'].map((event_name) => ({ event_name, event: {} }));
  for (const { f, e } of ownExprs) {
    check(`${f}: a fork's pull_request runs on GitHub's runners`, runner(e, prFrom('pull_request', FORKED)) === 'ubuntu-latest');
    check(`${f}: a fork's pull_request_review runs on GitHub's runners`, runner(e, prFrom('pull_request_review', FORKED)) === 'ubuntu-latest');
    check(`${f}: a Dependabot PR runs on GitHub's runners`, runner(e, prFrom('pull_request', HOME, 'dependabot[bot]')) === 'ubuntu-latest');
    check(`${f}: a same-repo PR runs on ours`, runner(e, prFrom('pull_request', HOME)) === 'ours');
    check(`${f}: a push, schedule or dispatch runs on ours`, EVENTS.every((ev) => runner(e, ev) === 'ours'));
    check(`${f}: in a fork repository every event runs on GitHub's runners`,
      [...EVENTS, prFrom('pull_request', FORK_REPO)].every((ev) => runner(e, ev, FORK_REPO) === 'ubuntu-latest'));
    check(`${f}: the expression names exactly our label`, e.includes(`fromJSON('["self-hosted","${LABEL}"]')`));
    if (e.includes('matrix.os')) {
      check(`${f}: Windows and macOS entries keep their own runners, here and in a fork repository`,
        runner(e, prFrom('pull_request', HOME), HOME, { os: 'windows-latest' }) === 'windows-latest'
        && runner(e, EVENTS[0], HOME, { os: 'macos-latest' }) === 'macos-latest'
        && runner(e, EVENTS[0], FORK_REPO, { os: 'windows-latest' }) === 'windows-latest');
    }
  }
  for (const { f, e } of repoOnly) {
    check(`${f}: every event here runs on ours`, [...EVENTS, prFrom('pull_request', FORKED)].every((ev) => runner(e, ev) === 'ours'));
    check(`${f}: in a fork repository it runs on GitHub's runners`, EVENTS.every((ev) => runner(e, ev, FORK_REPO) === 'ubuntu-latest'));
    check(`${f}: only a job that never runs PR code uses it`, repoOnlyAllowed.includes(f));
  }
  for (const { f, y } of literal) {
    check(`${f}: a literal ${LABEL} job runs only in this repository, or only on its own PRs`,
      y.includes(`github.repository == '${HOME}'`) || /head\.repo\.full_name == github\.repository/.test(y));
  }

  // The review relay.
  const relay = beside.find((w) => w.f === 'fleet-review-relay.yml')?.y ?? '';
  check('the review relay is listed in workflow_run', /^name: Fleet review relay$/m.test(relay) && (list ?? []).includes(RELAY_NAME));
  check('the review relay fires on pull_request_review alone', /^on:\n {2}pull_request_review:\n {4}types: \[[^\]]+\]\n\n/m.test(relay));
  check('the review relay has no token and runs no action or checkout', /^permissions: \{\}$/m.test(relay) && !/\buses:/.test(relay));
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ?? '.github/workflows';
  if (!existsSync(dir)) { console.error(`no ${dir}`); process.exit(2); }
  const repoOnly = process.env.FS_REPO_ONLY ? process.env.FS_REPO_ONLY.split(/\s+/).filter(Boolean) : undefined;
  const minOwn = process.env.FS_MIN_OWN ? Number(process.env.FS_MIN_OWN) : undefined;
  if (minOwn !== undefined && !Number.isInteger(minOwn)) { console.error(`FS_MIN_OWN is not a whole number: ${process.env.FS_MIN_OWN}`); process.exit(2); }
  const results = checkCaller(dir, { repoOnly, minOwn });
  for (const r of results) console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n  ${results.length - failed} pass, ${failed} fail`);
  if (failed) process.exit(1);
}
