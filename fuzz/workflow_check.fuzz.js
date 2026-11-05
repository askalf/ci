// Fuzz the fleet-status check: it reads the workflow files of the repository a pull request
// targets as text (nothing in them is executed) and decides whether a fork's events can reach a
// runner. The files are untrusted input, a fork pull request's own included, and the check is the
// control that must fail closed on anything it cannot read.
// Contracts: the line readers (yamlGaps, jobsOf, runsOnKeys, triggerLines, onBlock, jobKeysOf,
// onlyStep, workflowRunList and the rest) return their documented shapes for any text; the
// expression evaluator either returns a value or throws a plain Error (or the SyntaxError of
// fromJSON), never a TypeError or RangeError from its own parser; and checkCaller, run over a
// directory of any four files, returns one { name, ok } per check and never throws.
// The input is five NUL-separated fields: fleet-status.yml, fleet-status-self-test.yml, a second
// workflow beside them, fleet-status-backfill.yml, and an expression.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Other,
  UNKNOWN,
  UNKNOWN_FALSY,
  UNKNOWN_TRUTHY,
  checkCaller,
  condOf,
  evalExpr,
  jobKeysOf,
  jobPermissions,
  jobs,
  jobsOf,
  onBlock,
  onlyStep,
  runsOnKeys,
  triggerLines,
  uncomment,
  usesOf,
  workflowName,
  workflowRunList,
  yamlGaps,
} from '../scripts/fleet-status/check.mjs';
import { attempt, fail } from './violation.js';

const dir = mkdtempSync(join(tmpdir(), 'ci-fuzz-caller-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const isStrings = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string');

// The errors an expression may throw on purpose: its own plain Error, and fromJSON's SyntaxError.
const EXPRESSION_ERRORS = [SyntaxError];

function evaluate(src) {
  const ctx = {
    github: {
      event_name: 'pull_request',
      repository: 'o/r',
      event: { pull_request: { head: { repo: { full_name: 'o/r' } }, user: { login: 'x' }, number: 1 }, action: 'opened' },
    },
    matrix: { os: 'linux', n: 1 },
  };
  const modes = [{}, { strict: true }, { trusted: ['pull_request.head.repo.full_name', 'pull_request.user.login'] }, { strict: true, trusted: [] }];
  for (const mode of modes) {
    const r = attempt(() => evalExpr(src, ctx, mode), EXPRESSION_ERRORS);
    if (r.refused) continue;
    const v = r.value;
    const ok = v === null || v === undefined || ['string', 'number', 'boolean', 'object'].includes(typeof v)
      || v === UNKNOWN || v === UNKNOWN_TRUTHY || v === UNKNOWN_FALSY || v instanceof Other;
    if (!ok) fail(`evalExpr returned a ${typeof v}`);
  }
  const c = attempt(() => condOf(src, ctx), EXPRESSION_ERRORS);
  if (!c.refused && c.value !== UNKNOWN && typeof c.value !== 'boolean') fail(`condOf returned ${String(c.value)}`);
}

function readers(y) {
  if (!Array.isArray(yamlGaps(y)) || yamlGaps(y).some((n) => !Number.isInteger(n) || n < 1)) fail('yamlGaps returned a bad line list');
  if (typeof uncomment(y) !== 'string') fail('uncomment returned a non-string');
  if (typeof workflowName('f.yml', y) !== 'string') fail('workflowName returned a non-string');
  if (typeof onBlock(y) !== 'string') fail('onBlock returned a non-string');
  if (!isStrings(triggerLines(y))) fail('triggerLines returned a non-string list');
  if (!isStrings(jobs(y)) || !isStrings(usesOf(y)) || !isStrings(jobPermissions(y))) fail('a line reader returned a non-string list');
  const wr = workflowRunList(y);
  if (wr !== null && !isStrings(wr)) fail('workflowRunList returned a malformed list');
  if (typeof runsOnKeys(y) !== 'number') fail('runsOnKeys returned a non-number');

  const found = jobsOf(y);
  if (!Array.isArray(found)) fail('jobsOf did not return a list');
  for (const j of found) {
    if (typeof j.id !== 'string' || typeof j.cond !== 'string' || typeof j.hasRunsOn !== 'boolean') fail('jobsOf returned a malformed job');
    if (!isStrings(j.labels) || !Array.isArray(j.combos) || (j.expr !== null && typeof j.expr !== 'string')) fail('jobsOf returned a malformed job');
    if (!isStrings(jobKeysOf(y, j.id))) fail('jobKeysOf returned a non-string list');
  }
  if (typeof onlyStep(y, 'askalf/ci/actions/fleet-status', ['pr']) !== 'boolean') fail('onlyStep returned a non-boolean');
}

export function fuzz(data) {
  const [status = '', selfTest = '', beside = '', backfill = '', expr = ''] = data.toString('utf8').split('\0');

  evaluate(expr);
  evaluate(status.slice(0, 400));
  for (const y of [status, selfTest, beside, backfill]) readers(y);

  writeFileSync(join(dir, 'fleet-status.yml'), status);
  writeFileSync(join(dir, 'fleet-status-self-test.yml'), selfTest);
  writeFileSync(join(dir, 'ci.yml'), beside);
  writeFileSync(join(dir, 'fleet-status-backfill.yml'), backfill);
  const results = checkCaller(dir);
  if (!Array.isArray(results) || results.some((r) => typeof r.name !== 'string' || typeof r.ok !== 'boolean')) fail('checkCaller returned a malformed result');
}
