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
//   - Every runs-on, read per job in each form YAML allows (expression, flow list, block list,
//     bare label, labels: mapping), names only GitHub's labels, self-hosted, or this repository's
//     own (<repo>-exec, <repo>-build). The own-code expression sends a fork's PR, a Dependabot PR
//     and every run in a fork repository to GitHub's runners; the repository-only expression, for
//     jobs that never run PR code, is kept to the workflows listed in FS_REPO_ONLY; a literal
//     self-hosted runs-on needs that job's own if: to keep out a fork's PR and a Dependabot PR
//     (where the workflow runs on pull requests) and a fork repository's pushes and schedules;
//     CodeQL stays on GitHub's runners.
//   - It fails closed. Jobs are read at whatever indentation the file uses, and a runs-on outside
//     a job it read fails. A runner expression is evaluated under every event and every matrix
//     value the job defines; one that reads anything else, or gives anything but labels, fails.
//     A PR field a fork's author chooses (title, branch, labels, draft) and the vars, inputs and
//     needs contexts are UNKNOWN: a guard keeps a fork out only if it is false whatever they hold.
//   - The status action gets the PR number on every event that has one, and never runs dry.
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

/** A value this check cannot know: one a fork's author sets, or a context it does not supply. */
export const UNKNOWN = Symbol('unknown');
export const UNKNOWN_TRUTHY = Symbol('unknown, truthy');
export const UNKNOWN_FALSY = Symbol('unknown, falsy');
/**
 * A string this check knows only by what it is not: a fork PR's author is any login, and a fork's
 * repository is any repository but this one. It equals itself and is unequal to the strings it
 * excludes; any other comparison with it, or function or property read on it, is UNKNOWN. A
 * repository's full name has a slash, so it is never a number and is unequal to every value that
 * is not a string; a login may be all digits, so only strings settle a comparison with one.
 */
export class Other {
  constructor(not = [], { repo = false } = {}) { this.not = not.map((s) => s.toLowerCase()); this.repo = repo; }
}
const STATUS_FNS = new Set(['success', 'failure', 'cancelled']);
const UNKNOWN_CONTEXTS = new Set(['vars', 'inputs', 'needs', 'env', 'steps', 'secrets', 'job', 'runner']);

/**
 * A small evaluator for the Actions expression subset the workflows use: string and number
 * literals, null, true, false, property paths, !, ==, !=, &&, ||, contains(), fromJSON(),
 * startsWith(), endsWith() and the status functions. Strings compare case-insensitively, as
 * Actions does. Returns the value, as Actions does (&& and || return an operand).
 *
 * strict: a context the caller did not supply, or a matrix key the job does not define, throws
 * instead of reading as null.
 * trusted: the github.event paths whose values the event's sender cannot choose (a fork can set
 * its PR's title, body, branch, labels and draft state, but not its head repository or its
 * author's login). Any other github.event path, and the contexts in UNKNOWN_CONTEXTS, read as
 * UNKNOWN, which spreads three-valued: `false && UNKNOWN` is false, `true || UNKNOWN` is true, and
 * anything else UNKNOWN touches is UNKNOWN. A condition is only false when it is false whatever
 * those values are. Also UNKNOWN when trusted: a context, or a github property, the caller did not
 * supply (github.actor is a fork PR's author, github.head_ref its branch), and the status functions
 * other than always(), since whether an earlier job failed or the run was cancelled is not
 * something a fork is kept from arranging.
 */
export function evalExpr(src, ctx, { strict = false, trusted = null } = {}) {
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
  // UNKNOWN_TRUTHY and UNKNOWN_FALSY are values this check does not know but whose truthiness it
  // does (`UNKNOWN || true` is truthy, but could be the unknown value); to anything that reads the
  // value, a comparison, a function or a property, they are UNKNOWN.
  const U = (v) => v === UNKNOWN || v === UNKNOWN_TRUTHY || v === UNKNOWN_FALSY;
  const S = (v) => v instanceof Other;
  const truthy = (v) => !(v === null || v === undefined || v === false || v === 0 || v === '');
  const isTrue = (v) => v === UNKNOWN_TRUTHY || (!U(v) && truthy(v));
  const isFalse = (v) => v === UNKNOWN_FALSY || (!U(v) && !truthy(v));
  // Actions' ==: two strings compare case-insensitively; two values of one other type compare as
  // that type (an object or array only to itself); values of different types are both coerced to
  // numbers (null and '' are 0, true is 1, a string that is not a number and any object are NaN),
  // so null == '' and false == 0 are true.
  const num = (v) => (v === null || v === undefined ? 0 : typeof v === 'boolean' ? Number(v) : typeof v === 'number' ? v
    : typeof v === 'string' ? (v.trim() === '' ? 0 : /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$|^\s*0x[0-9a-f]+\s*$/i.test(v) ? Number(v) : NaN) : NaN);
  const kind = (v) => (v === null || v === undefined ? 'null' : Array.isArray(v) ? 'object' : typeof v);
  const eq = (a, b) => {
    if (U(a) || U(b)) return UNKNOWN;
    if (S(a) || S(b)) {
      if (a === b) return true;
      const [s, o] = S(a) ? [a, b] : [b, a];
      if (typeof o !== 'string') return s.repo && !S(o) ? false : UNKNOWN;
      return s.not.includes(o.toLowerCase()) ? false : UNKNOWN;
    }
    if (kind(a) === kind(b)) return kind(a) === 'string' ? a.toLowerCase() === b.toLowerCase() : kind(a) === 'null' ? true : a === b;
    return num(a) === num(b);
  };
  const fns = {
    contains: (h, n) => (Array.isArray(h) ? h.some((x) => eq(x, n) === true) : String(h ?? '').toLowerCase().includes(String(n ?? '').toLowerCase())),
    fromJSON: (x) => JSON.parse(x),
    startsWith: (h, n) => String(h ?? '').toLowerCase().startsWith(String(n ?? '').toLowerCase()),
    endsWith: (h, n) => String(h ?? '').toLowerCase().endsWith(String(n ?? '').toLowerCase()),
    // A job's status functions, as they read before any step has run; only always() is read when trusted.
    always: () => true,
    success: () => true,
    failure: () => false,
    cancelled: () => false,
  };
  // Whether a github.event path is one the sender cannot choose: a trusted path, or on the way to one.
  const known = (path) => trusted.some((t) => t === path || t.startsWith(`${path}.`) || path.startsWith(`${t}.`));
  const primary = () => {
    const k = toks[p++];
    if (k?.t === 'lit') return k.v;
    if (k?.t === '(') { const v = or(); eat(')'); return v; }
    if (k?.t === '!') { const v = primary(); return isTrue(v) ? false : isFalse(v) ? true : UNKNOWN; }
    if (k?.t !== 'id') throw new Error(`unexpected token ${p - 1}`);
    if (k.v === 'null') return null;
    if (k.v === 'true' || k.v === 'false') return k.v === 'true';
    if (peek() === '(') {
      p++;
      const args = [];
      if (peek() !== ')') for (args.push(or()); peek() === ','; p++, args.push(or()));
      eat(')');
      if (!fns[k.v]) throw new Error(`unknown function ${k.v}`);
      if (trusted && STATUS_FNS.has(k.v)) return UNKNOWN;
      return args.some((a) => U(a) || S(a)) ? UNKNOWN : fns[k.v](...args);
    }
    if (strict && !(k.v in ctx) && !(trusted && UNKNOWN_CONTEXTS.has(k.v))) throw new Error(`unknown context ${k.v}`);
    let v = trusted && (UNKNOWN_CONTEXTS.has(k.v) || !(k.v in ctx)) ? UNKNOWN : ctx[k.v] ?? null;
    const path = [k.v];
    for (let depth = 0; ; depth++) {
      let key;
      if (peek() === '.') { p++; key = eat('id').v; } else if (peek() === '[') { p++; key = or(); eat(']'); } else return v;
      if (U(v) || S(v)) { v = UNKNOWN; continue; }
      if (U(key)) { v = UNKNOWN; continue; }
      if (strict && k.v === 'matrix' && depth === 0 && !(key in (v ?? {}))) throw new Error(`unknown matrix.${key}`);
      path.push(String(key));
      if (trusted && k.v === 'github' && depth === 0 && !(String(key) in (v ?? {}))) { v = UNKNOWN; continue; }
      v = trusted && path[0] === 'github' && path[1] === 'event' && path.length > 2 && !known(path.slice(2).join('.')) ? UNKNOWN : v?.[key] ?? null;
    }
  };
  const cmp = () => { let v = primary(); while (peek() === '==' || peek() === '!=') { const op = toks[p++].t; const r = primary(); const e = eq(v, r); v = U(e) ? UNKNOWN : op === '==' ? e : !e; } return v; };
  // Actions' && gives its first falsy operand or its last; || its first truthy operand or its last.
  // Beside an UNKNOWN, `UNKNOWN && <falsy>` is falsy and `UNKNOWN || <truthy>` truthy, but either
  // could be the unknown value itself, so they are UNKNOWN_FALSY and UNKNOWN_TRUTHY, never a
  // boolean a comparison could go on to read; with any other operand the result stays UNKNOWN.
  const and = () => { let v = cmp(); while (peek() === '&&') { p++; const r = cmp(); v = isFalse(v) ? v : isTrue(v) ? r : isFalse(r) ? UNKNOWN_FALSY : UNKNOWN; } return v; };
  const or = () => { let v = and(); while (peek() === '||') { p++; const r = and(); v = isTrue(v) ? v : isFalse(v) ? r : isTrue(r) ? UNKNOWN_TRUTHY : UNKNOWN; } return v; };
  const v = or();
  if (p !== toks.length) throw new Error(`trailing tokens from ${p}`);
  return v;
}

const truthy = (v) => !(v === null || v === undefined || v === false || v === 0 || v === '');
export const evalIf = (src, ctx) => truthy(evalExpr(src, ctx));
/** The github.event paths a fork's PR cannot choose. */
export const TRUSTED_PR_PATHS = ['pull_request.head.repo.full_name', 'pull_request.user.login'];
/** A condition as true, false or UNKNOWN, with every other event path the sender's to choose. */
export const condOf = (src, ctx) => {
  const v = evalExpr(src, ctx, { trusted: TRUSTED_PR_PATHS });
  return v === UNKNOWN ? UNKNOWN : v === UNKNOWN_TRUTHY ? true : v === UNKNOWN_FALSY ? false : truthy(v);
};


/** A plain YAML value without its trailing comment: a # after a space, outside quotes. */
export function uncomment(s) {
  let q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = ''; } else if (c === "'" || c === '"') q = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trim();
  }
  return s.trim();
}

/**
 * The lines of a workflow outside the YAML subset this check reads, 1-based. Its readers go line
 * by line, so a workflow they could misread fails instead of passing on a partial reading. Every
 * line is blank, a comment, inside a block scalar, `- ` items (one space after each dash, as the
 * readers expect), or an unquoted `key:`; a value is
 * empty, a block scalar indicator, `{}`, a flow sequence of scalars, or one scalar, all on one
 * line. A quoted scalar has no escapes (no backslash in double quotes, no doubled single quote),
 * since the readers here do not decode them. A scalar that continues on a further-indented line,
 * a flow mapping or anything nested in a flow sequence, a quoted or complex key, a tab in the
 * indentation, an anchor, alias or tag, and a document marker are outside it.
 */
export function yamlGaps(y) {
  const gaps = [];
  const lines = y.split('\n');
  let block = null; // a block scalar's content is indented past this
  let scalarAt = null; // after a value on its line, a line indented past this would continue it
  const QUOTED = /^(?:'[^']*'|"[^"\\]*")$/;
  const plain = (s) => s !== '' && !/^[&*!%@`|>?,[\]{}#'"]/.test(s) && !/^-(\s|$)/.test(s) && !/:(\s|$)/.test(s);
  // A flow sequence of scalars, each quoted without escapes or plain; a trailing comma is allowed.
  const flowSeq = (s) => {
    if (!/^\[.*\]$/.test(s)) return false;
    const items = [];
    let cur = '';
    let q = '';
    for (const c of s.slice(1, -1)) {
      if (q) { cur += c; if (c === q) q = ''; continue; }
      if (c === "'" || c === '"') q = c;
      if (c === ',') { items.push(cur.trim()); cur = ''; } else cur += c;
    }
    if (q) return false;
    items.push(cur.trim());
    if (items.length > 1 && items[items.length - 1] === '') items.pop();
    if (items.length === 1 && items[0] === '') return true;
    return items.every((x) => (/^['"]/.test(x) ? QUOTED.test(x) : plain(x)));
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*$/.test(l)) continue;
    const ind = /^ */.exec(l)[0].length;
    if (block !== null) { if (ind > block) continue; block = null; }
    if (/^ *\t/.test(l)) { gaps.push(i + 1); continue; }
    if (/^\s*#/.test(l)) continue;
    if (scalarAt !== null && ind > scalarAt) { gaps.push(i + 1); continue; }
    scalarAt = null;
    let rest = l.slice(ind);
    let col = ind;
    let dashAt = null;
    for (let d; (d = /^-( |$)/.exec(rest));) { dashAt = col; col += d[0].length; rest = rest.slice(d[0].length); }
    if (rest === '' || /^#/.test(rest)) continue;
    const key = /^([A-Za-z0-9_][\w.-]*):(?:\s+(.*))?$/.exec(rest);
    if (!key && dashAt === null) { gaps.push(i + 1); continue; }
    const at = key ? col : dashAt;
    const x = uncomment(key ? key[2] ?? '' : rest);
    if (x === '') continue;
    if (/^[|>][-+1-9]*$/.test(x)) { block = at; continue; }
    // A flow sequence may run over further-indented lines, up to the line that ends it.
    if (x.startsWith('[')) {
      let flow = x;
      let j = i + 1;
      for (; j < lines.length && !flow.endsWith(']'); j++) {
        if (/^\s*(#.*)?$/.test(lines[j])) continue;
        if (/^ *\t/.test(lines[j]) || /^ */.exec(lines[j])[0].length <= at) break;
        flow += ` ${uncomment(lines[j])}`;
      }
      if (!flowSeq(flow)) { gaps.push(i + 1); continue; }
      i = j - 1;
      scalarAt = at;
      continue;
    }
    const ok = /^['"]/.test(x) ? QUOTED.test(x) : x.startsWith('{') ? /^\{\s*\}$/.test(x) : plain(x);
    if (!ok) { gaps.push(i + 1); continue; }
    scalarAt = at;
  }
  return gaps;
}

/** The expression inside `${{ ... }}`, or the text as it is (a job if: may leave the braces off). */
const unwrap = (s) => (/^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(s.trim())?.[1] ?? s.trim());

/** Marks a runs-on this check cannot read; it is never hosted and never ours, so it fails. */
export const UNREADABLE = '<unreadable>';
const indentOf = (l) => /^ */.exec(l)[0].length;
const content = (l) => l.trim() !== '' && !/^\s*#/.test(l);

/**
 * The jobs of a workflow, each with its own runs-on and if:, at whatever indentation the file uses.
 * runs-on is read in each form a job writes it: an expression, a flow list (quoted items or not), a
 * block list, a bare label, or a mapping with `labels:`; any other form (an alias, a block scalar,
 * a group with no labels) is UNREADABLE. `labels` is every label it names, quotes dropped; `expr`
 * is the expression when it is one; `combos` is every matrix combination, read from the job's
 * strategy. A job that calls a reusable workflow has no runs-on.
 * @returns {Array<{id:string, cond:string, expr:string|null, labels:string[], combos:Array<Record<string,string|null>>, hasRunsOn:boolean}>}
 */
export function jobsOf(y) {
  const at = /^jobs:[ \t]*(#.*)?$/m.exec(y);
  if (!at) return [];
  const body = [];
  for (const l of y.slice(at.index + at[0].length).split('\n').slice(1)) {
    if (/^[^\s#]/.test(l)) break;
    body.push(l);
  }
  const first = body.find(content);
  if (!first) return [];
  const jobIndent = indentOf(first);
  const blocks = [];
  for (const l of body) {
    const m = content(l) && indentOf(l) === jobIndent ? /^\s*([\w-]+):\s*(#.*)?$/.exec(l) : null;
    if (m) blocks.push({ id: m[1], lines: [] });
    else if (content(l) && indentOf(l) <= jobIndent) blocks.push({ id: UNREADABLE, lines: [] });
    else if (blocks.length) blocks[blocks.length - 1].lines.push(l);
  }
  const strip = (s) => uncomment(s).replace(/^['"]|['"]$/g, '');
  const listItems = (s) => (/^\[.*\]$/.test(s) ? s.slice(1, -1).split(',').map(strip).filter(Boolean) : [UNREADABLE]);
  return blocks.map(({ id, lines }) => {
    const firstProp = lines.find(content);
    const propIndent = firstProp ? indentOf(firstProp) : jobIndent + 2;
    // The value of a key at `indent` within `ls`: the rest of its line, and the content lines under it.
    const valueIn = (ls, key, indent) => {
      const i = ls.findIndex((l) => indentOf(l) === indent && new RegExp(`^\\s*${key}:(\\s|$)`).test(l));
      if (i < 0) return null;
      const rest = ls[i].slice(ls[i].indexOf(':') + 1).trim();
      const under = [];
      for (const l of ls.slice(i + 1)) {
        if (!content(l)) continue;
        if (indentOf(l) <= indent) break;
        under.push(l);
      }
      return { rest, under };
    };
    const value = (key) => valueIn(lines, key, propIndent);
    // A block scalar (>- or |) keeps every character, # included; a plain line loses its comment.
    const ifv = value('if');
    const cond = !ifv ? '' : unwrap(/^[>|][-+]?$/.test(ifv.rest) ? ifv.under.map((l) => l.trim()).join(' ') : uncomment(ifv.rest));
    const ro = value('runs-on');
    let expr = null;
    let labels = [];
    if (ro) {
      const rest = uncomment(ro.rest);
      if (rest.startsWith('${{')) expr = /\}\}$/.test(rest) ? unwrap(rest) : UNREADABLE;
      else if (rest.startsWith('[')) labels = listItems(rest);
      else if (/^[>|*&!{]/.test(rest)) labels = [UNREADABLE];
      else if (rest) labels = [strip(rest)];
      else {
        const subIndent = ro.under.length ? indentOf(ro.under[0]) : 0;
        const list = ro.under.filter((l) => indentOf(l) === subIndent);
        if (list.length && list.every((l) => /^\s*-\s+/.test(l))) labels = list.map((l) => strip(l.replace(/^\s*-\s+/, '')));
        else {
          const lab = valueIn(ro.under, 'labels', subIndent);
          if (!lab) labels = [UNREADABLE];
          else if (lab.rest) labels = lab.rest.startsWith('[') ? listItems(lab.rest) : [strip(lab.rest)];
          else labels = lab.under.map((l) => (/^\s*-\s+/.test(l) ? strip(l.replace(/^\s*-\s+/, '')) : UNREADABLE));
        }
        if (!labels.length) labels = [UNREADABLE];
      }
    }
    // The matrix values a runs-on expression may read: each key's flow or block list under
    // strategy.matrix. A value that is itself an expression is not a value this check can use.
    // include entries are applied as Actions applies them, in order: each is added to every base
    // combination whose original values it does not change, so compatible entries accumulate on one
    // combination, and an entry that fits none is a combination of its own. exclude only removes
    // base combinations, so it is ignored, and every entry is also checked alone, which covers one
    // whose base combinations were all excluded: checking more combinations can only fail more.
    const matrix = {};
    const include = [];
    let readable = true;
    const strategy = value('strategy');
    const mx = strategy?.under.length ? valueIn(strategy.under, 'matrix', indentOf(strategy.under[0])) : null;
    if (mx && (uncomment(mx.rest) !== '' || !mx.under.length)) readable = false;
    if (mx?.under.length) {
      const keyIndent = indentOf(mx.under[0]);
      // A value as YAML types it, since Actions compares and tests the typed value: quoted is a
      // string; true, false, null and decimal numbers are what they say. Words and number forms
      // that YAML versions read differently (yes, on, 0x1f, .inf), mappings, aliases, tags and
      // escapes are not values this check can use.
      const scalar = (s) => {
        const x = uncomment(s).trim();
        if (/\$\{\{|^[[{*&!|>%@`]/.test(x)) return UNREADABLE;
        const q = /^'([^']*)'$|^"([^"\\]*)"$/.exec(x);
        if (q) return q[1] ?? q[2];
        if (/^['"]/.test(x) || /:(\s|$)/.test(x)) return UNREADABLE;
        if (/^(true|True|TRUE)$/.test(x)) return true;
        if (/^(false|False|FALSE)$/.test(x)) return false;
        if (/^(null|Null|NULL|~|)$/.test(x)) return null;
        if (/^[-+]?(\.\d+|\d+(\.\d*)?)([eE][-+]?\d+)?$/.test(x)) return Number(x);
        if (/^(y|n|yes|no|on|off)$/i.test(x) || /^[-+]?(0[xob]|\.(inf|nan)$)/i.test(x) || /^\.(inf|nan)$/i.test(x)) return UNREADABLE;
        return x;
      };
      const flow = (s) => {
        const x = uncomment(s);
        if (!/^\[.*\]$/.test(x)) return [UNREADABLE];
        const items = x.slice(1, -1).split(',').map((i) => i.trim());
        if (items.length && items[items.length - 1] === '') items.pop();
        return items.length && !items.includes('') ? items.map(scalar) : [UNREADABLE];
      };
      const keysSeen = new Set();
      for (const l of mx.under.filter((x) => indentOf(x) === keyIndent)) {
        const m = /^\s*([\w-]+):\s*(.*)$/.exec(l);
        if (!m || keysSeen.has(m[1])) { readable = false; continue; }
        keysSeen.add(m[1]);
        const v = valueIn(mx.under, m[1], keyIndent);
        if (m[1] === 'exclude') continue;
        if (m[1] === 'include') {
          if (uncomment(v.rest) !== '' || !v.under.length) { readable = false; continue; }
          const itemIndent = indentOf(v.under[0]);
          // An entry's keys sit two columns in, after "- "; anything deeper is a nested value.
          for (const x of v.under) {
            const item = indentOf(x) === itemIndent ? /^\s*-\s([\w-]+):(?:\s+(.*))?$/.exec(x) : null;
            const more = indentOf(x) === itemIndent + 2 ? /^\s*([\w-]+):(?:\s+(.*))?$/.exec(x) : null;
            const entry = include[include.length - 1];
            if (item && /^\s*- [^\s]/.test(x)) include.push({ [item[1]]: scalar(item[2] ?? '') });
            else if (more && entry && !(more[1] in entry)) entry[more[1]] = scalar(more[2] ?? '');
            else readable = false;
          }
          continue;
        }
        const vals = v.rest ? (v.rest.startsWith('[') ? flow(v.rest) : [UNREADABLE])
          : v.under.map((x) => (/^\s*-\s/.test(x) && indentOf(x) === indentOf(v.under[0]) ? scalar(x.replace(/^\s*-\s+/, '')) : UNREADABLE));
        if (!vals.length) readable = false;
        matrix[m[1]] = vals;
      }
    }
    const all = [matrix, ...include].flatMap(Object.values).flat();
    if (all.includes(UNREADABLE)) readable = false;
    // Every combination; a key defined somewhere in the matrix but not in a combination reads as
    // null there, as in Actions. An unreadable matrix is one empty combination, so any matrix key
    // a strict expression reads is unknown.
    let combos = [{}];
    if (readable) {
      const keys = [...new Set([...Object.keys(matrix), ...include.flatMap(Object.keys)])];
      const hasBase = Object.keys(matrix).length > 0;
      const base = hasBase ? Object.entries(matrix).reduce((acc, [k, vs]) => acc.flatMap((c) => vs.map((v) => ({ ...c, [k]: v }))), [{}]) : include.length ? [] : [{}];
      // Whether an entry keeps a combination's original values. Two values that only a loose
      // comparison calls equal are a match this check cannot settle.
      const fits = (orig, inc) => Object.entries(inc).every(([k, v]) => {
        if (!(k in orig) || orig[k] === v) return true;
        if (String(orig[k]).toLowerCase() === String(v).toLowerCase() || (orig[k] !== null && v !== null && orig[k] !== '' && v !== '' && Number(orig[k]) === Number(v))) readable = false;
        return false;
      });
      const grown = base.map((orig) => ({ orig, cur: { ...orig } }));
      for (const inc of include) for (const g of grown) if (fits(g.orig, inc)) Object.assign(g.cur, inc);
      const raw = [...base, ...grown.map((g) => g.cur), ...include];
      const seen = new Set();
      combos = raw.map((c) => Object.fromEntries(keys.map((k) => [k, c[k] ?? null])))
        .filter((c) => { const s = JSON.stringify(c); return !seen.has(s) && seen.add(s); });
      if (!readable) combos = [{}];
    }
    return { id, cond, expr, labels, combos, hasRunsOn: ro !== null };
  });
}

/** How many runs-on keys a workflow has, anywhere: each must belong to a job jobsOf read. */
export function runsOnKeys(y) {
  return y.split('\n').filter((l) => !/^\s*#/.test(l) && /(^|[\s{,-])["']?runs-on["']?\s*:/.test(uncomment(l))).length;
}

/**
 * The triggers fleet-status.yml must have, exactly: each lane is computed on one of these events,
 * and workflow_run must be on completed, since a required check has its result only when its run
 * has finished. The workflows list is checked on its own.
 */
export const STATUS_TRIGGERS = [
  'on:',
  '  pull_request:',
  '    types: [opened, synchronize, reopened, ready_for_review, labeled, unlabeled]',
  '  pull_request_review:',
  '    types: [submitted, edited, dismissed]',
  '  issue_comment:',
  '    types: [created, edited, deleted]',
  '  workflow_run:',
  '    workflows: <list>',
  '    types: [completed]',
];

/** The self-test's triggers, exactly: every PR that opens, updates or reopens with a workflow change. */
export const SELF_TEST_TRIGGERS = [
  'on:',
  '  pull_request:',
  '    types: [opened, synchronize, reopened, ready_for_review]',
  '    paths:',
  '      - .github/workflows/**',
];

/** The grants the status and backfill jobs hold, exactly: what the action reads, and statuses. */
export const STATUS_PERMISSIONS = ['contents: read', 'pull-requests: read', 'issues: read', 'checks: read', 'statuses: write'];

/** The grants under a workflow's first job-level `permissions:`, comments dropped. */
export function jobPermissions(y) {
  const m = /^ {4}permissions:\n((?: {6}.*\n?)*)/m.exec(y);
  return m ? m[1].split('\n').map((l) => uncomment(l)).filter(Boolean) : [];
}

/** A workflow's `on:` block as lines, comments and blank lines dropped and the workflows list elided. */
export function triggerLines(y) {
  const lines = y.split('\n');
  const start = lines.findIndex((l) => /^on:/.test(l));
  if (start < 0) return [];
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const l = lines[i];
    if (i > start && /^\S/.test(l)) break;
    if (/^\s*(#.*)?$/.test(l)) continue;
    if (/^ {4}workflows:/.test(l)) {
      out.push('    workflows: <list>');
      while (i + 1 < lines.length && (/^ {5,}\S/.test(lines[i + 1]) || /^\s*(#.*)?$/.test(lines[i + 1]))) i++;
      continue;
    }
    out.push(/^ */.exec(l)[0] + uncomment(l));
  }
  return out;
}

/** The keys of a job at two-space job indentation, in order, from its line to the next job or the end. */
export function jobKeysOf(y, id) {
  const m = new RegExp(`^ {2}${id.replace(/[.]/g, '\\.')}:\\n((?:(?! {2}\\S).*\\n?)*)`, 'm').exec(y);
  return m ? [...m[1].matchAll(/^ {4}([\w-]+):/gm)].map((k) => k[1]) : [];
}

/**
 * Whether a workflow's last job ends in a `steps:` block that is exactly one `- uses:` of `action`
 * at a full sha, whose only other key is `with:` holding exactly `inputs`, one line each.
 */
export function onlyStep(y, action, inputs) {
  const at = y.lastIndexOf('\n    steps:\n');
  if (at < 0) return false;
  const m = new RegExp(`^ {6}- uses: ${action.replace(/[.]/g, '\\.')}@[0-9a-f]{40}(?: #[^\\n]*)?\\n {8}with:\\n((?: {10}[\\w-]+: [^\\n]*\\n)+)\\s*$`)
    .exec(y.slice(at + '\n    steps:\n'.length));
  if (!m) return false;
  const keys = [...m[1].matchAll(/^ {10}([\w-]+):/gm)].map((k) => k[1]);
  return keys.length === inputs.length && inputs.every((k) => keys.includes(k));
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
export const usesOf = (y) => [...y.matchAll(/^\s+(?:- )?uses:\s*(\S+)/gim)].map((m) => m[1]);

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
  // A workflow outside the YAML subset could be read here differently from how Actions reads it.
  for (const f of files) {
    const gaps = yamlGaps(readLf(dir, f));
    check(`${f}: is in the YAML subset this check reads${gaps.length ? ` (not line ${gaps.slice(0, 5).join(', ')})` : ''}`, gaps.length === 0);
  }
  const own = readLf(dir, 'fleet-status.yml');
  const beside = files.filter((f) => f !== 'fleet-status.yml').map((f) => { const y = readLf(dir, f); return { f, name: workflowName(f, y), y }; });
  const byName = (name) => beside.find((w) => w.name === name);

  // The refresh list and the triggers beside it.
  const list = workflowRunList(own);
  check('fleet-status.yml lists workflows to refresh on', (list ?? []).length > 0);
  check('fleet-status.yml runs on exactly the events its lanes read, and on a listed run completing',
    triggerLines(own).join('\n') === STATUS_TRIGGERS.join('\n'));
  const missing = misfits(list, beside.map((w) => [w.name, w.y]));
  check(`the workflows that run on pull requests are all listed${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`, missing.length === 0);
  check('the status job accepts workflow_run events from pull_request and pull_request_target runs',
    /\["pull_request","pull_request_target"\]/.test(own));
  check('fleet-status.yml runs only the status job, on no dispatch', jobs(own).join() === 'status' && !/\bworkflow_dispatch\b/.test(onBlock(own)));

  // A burst of finishing workflows is one status run per PR branch. No run is cancelled while it
  // works: a workflow_run run that a newer one supersedes is replaced while it still waits for the
  // group, before GitHub creates its job (so no runner is started and cancelled for it: 915 of 6405
  // self-hosted jobs in three days were, 2026-10-22 to 10-25), and a running status job finishes,
  // the one waiting corrects after it. Nothing on the PR is ever cancelled. Until every caller has
  // moved, the older line that cancels a workflow_run run is still accepted: the pin-bump wave
  // carries this checker to a caller before the caller's own change does.
  const group = /\n  group: \$\{\{ (.+) \}\}\n/.exec(own)?.[1] ?? '';
  const cancel = /\n  cancel-in-progress: (.+)\n/.exec(own)?.[1]?.trim() ?? '';
  const cancelExpr = /^\$\{\{ (.+) \}\}$/.exec(cancel)?.[1] ?? null;
  check('workflow_run runs share a group per PR branch and triggering event; every other run has its own', group === GROUP);
  let cancelsOnPr = true;
  try {
    cancelsOnPr = cancel === '' || cancel === 'false' ? false
      : cancelExpr === null ? true
        : ['pull_request', 'pull_request_review', 'issue_comment'].some((event_name) => evalIf(cancelExpr, { github: { event_name } }));
  } catch { cancelsOnPr = true; }
  check('no run on the PR is cancelled by a newer one (cancel-in-progress false, or an expression false for every event but workflow_run)', !cancelsOnPr);

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
  // The steps end the file and are exactly the one pinned step: a step-level if: could skip it,
  // and any other input could change what it posts (all-open ignores the PR it was given).
  // continue-on-error, strategy or a second if: at the job level could hide a failed post or skip it.
  check('the status job has only if, runs-on, timeout-minutes, permissions and steps',
    jobKeysOf(own, 'status').join() === 'if,runs-on,timeout-minutes,permissions,steps');
  // A token that cannot write statuses posts nothing; one that cannot read the PR, its comments or
  // its checks computes the lanes from nothing.
  check('the status token reads what the action reads and writes statuses, and nothing more',
    jobPermissions(own).join() === STATUS_PERMISSIONS.join() && /^permissions: \{\}$/m.test(own));
  check('the status job\'s one step is the pinned action with exactly pr, head-repo and head-branch, and no other key',
    onlyStep(own, STATUS_ACTION, ['pr', 'head-repo', 'head-branch']));
  check(`the status job runs ${STATUS_ACTION} at a full commit sha, and no other action`,
    usesOf(own).length === 1 && new RegExp(`^${STATUS_ACTION}@[0-9a-f]{40}$`).test(usesOf(own)[0] ?? ''));
  check('the status job has no run step', !/^\s+(?:- )?run:/im.test(own));
  check('the fork path hands the action the head repo and branch',
    /^ {10}head-repo: \$\{\{ github\.event\.workflow_run\.head_repository\.full_name \}\}$/m.test(step)
    && /^ {10}head-branch: \$\{\{ github\.event\.workflow_run\.head_branch \}\}$/m.test(step));
  // Every other path needs the PR number: without it (and without a fork head) the script stops
  // with a usage error and posts nothing. The input is pinned to the one expression that reads it
  // from each event, since a constant or a lookalike would post one PR's lanes on another.
  check('the action gets the PR number from the pull_request, the comment\'s issue or the workflow_run',
    /^ {10}pr: \$\{\{ github\.event\.pull_request\.number \|\| github\.event\.issue\.number \|\| github\.event\.workflow_run\.pull_requests\[0\]\.number \}\}$/m.test(step));
  check('the status job posts: no dry-run', !/^\s+dry-run:/m.test(step));
  check('no step reads the PR head ref or sha', !/(pull_request\.head\.(ref|sha)|workflow_run\.head_sha)/.test(own));

  // The self-test.
  const self = byName(SELF_TEST_NAME);
  check('the self-test workflow is here', Boolean(self));
  check('the self-test workflow is listed', (list ?? []).includes(SELF_TEST_NAME));
  if (self) {
    const on = onBlock(self.y);
    check('the self-test runs on pull_request, and a dispatch, alone', /^\s+pull_request:/m.test(on)
      && !/\b(pull_request_target|pull_request_review|issue_comment|workflow_run|push|schedule)\b/.test(on));
    // Every PR that opens, updates or reopens with a workflow change runs it; no path is left out.
    check('the self-test runs on every PR that changes a workflow', triggerLines(self.y).join('\n') === SELF_TEST_TRIGGERS.join('\n'));
    check('the self-test job is named self-test', jobs(self.y).join() === 'self-test');
    check(`the self-test runs ${CHECK_ACTION} at a full commit sha`, usesOf(self.y).some((u) => new RegExp(`^${CHECK_ACTION}@[0-9a-f]{40}$`).test(u)));
    check('the self-test token reads contents alone', /^    permissions:\n      contents: read\n(?! {6})/m.test(self.y) && /^permissions: \{\}$/m.test(self.y));
    // Nothing may skip the check or swallow its failure: the job has no if: or continue-on-error
    // (its keys are exactly these), and its steps, which end the file, are exactly the checkout
    // and the pinned check, with no key but the inputs the check takes.
    check('the self-test job has only runs-on, timeout-minutes, permissions and steps', jobKeysOf(self.y, 'self-test').join() === 'runs-on,timeout-minutes,permissions,steps');
    const selfSteps = self.y.slice(self.y.lastIndexOf('\n    steps:\n') + '\n    steps:\n'.length);
    const pin = (a) => `${a.replace(/[.]/g, '\\.')}@[0-9a-f]{40}(?: #[^\\n]*)?\\n`;
    check('the self-test\'s steps are the checkout and the pinned check alone, with no if: or other key',
      self.y.includes('\n    steps:\n') && new RegExp(`^ {6}- uses: ${pin('askalf/ci/actions/checkout-with-retry')} {8}with:\\n {10}persist-credentials: false\\n\\n? {6}- uses: ${pin(CHECK_ACTION)}(?: {8}with:\\n(?: {10}(?:min-own-exprs: '?[0-9]+'?|repo-only: [^\\n]+)\\n){1,2})?\\s*$`).test(selfSteps));
  }

  // The backfill, where there is one.
  const backfill = beside.find((w) => w.f === 'fleet-status-backfill.yml');
  if (backfill) {
    const bstep = stepWith(backfill.y, STATUS_ACTION) ?? '';
    check('the backfill\'s token reads what the action reads and writes statuses, and nothing more',
      jobPermissions(backfill.y).join() === STATUS_PERMISSIONS.join());
    check('the backfill runs on a dispatch alone', /^\s+workflow_dispatch:/m.test(onBlock(backfill.y)) && onBlock(backfill.y).replace(/\s+/g, ' ').trim() === 'workflow_dispatch:');
    check(`the backfill runs ${STATUS_ACTION} over every open PR, and nothing else`,
      usesOf(backfill.y).length === 1 && /^ {10}all-open: (?:'true'|"true"|true)$/m.test(bstep) && !/^\s+(?:- )?run:/im.test(backfill.y));
    check('the backfill is one job with only runs-on, timeout-minutes, permissions and steps',
      jobs(backfill.y).length === 1 && jobKeysOf(backfill.y, jobs(backfill.y)[0]).join() === 'runs-on,timeout-minutes,permissions,steps');
    check('the backfill\'s one step is the pinned action with all-open alone, and no other key',
      onlyStep(backfill.y, STATUS_ACTION, ['all-open']));
  }

  // runs-on: our own code on our runners, code nobody here wrote never, a fork repository never.
  // Each job's runs-on is read with that job's own if:, in every form a job can write it.
  const NAME = HOME.split('/')[1];
  const hostedLabel = (l) => /^(ubuntu|windows|macos)-[\w.-]+$/.test(l);
  const ourLabel = (l) => l.startsWith(`${NAME}-`);
  const ownExprs = [];
  const repoOnly = [];
  const literal = [];
  const foreign = [];
  // A fork's PR may come from any repository but this one and any author, maintainers included; a
  // fork repository is any repository but this one; a same-repo PR's author is anyone but Dependabot,
  // which has its own scenario.
  const FORK_REPO = new Other([HOME], { repo: true });
  const ANYONE = new Other();
  const NOT_DEPENDABOT = new Other(['dependabot[bot]']);
  // What a runs-on expression gives, as labels: a string is one, an array of strings is each;
  // anything else, or an expression that reads a context or matrix key this check does not
  // supply, is UNREADABLE.
  const labelsOf = (e, github, repository, matrix) => {
    let v;
    try { v = evalExpr(e, { github: { repository, ...github }, matrix }, { strict: true, trusted: TRUSTED_PR_PATHS }); } catch { return [UNREADABLE]; }
    if (typeof v === 'string' && v !== '') return [v];
    if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) return v;
    return [UNREADABLE];
  };
  // One hosted label is GitHub's runner by that name; anything else is ours (or unreadable).
  const runner = (e, github, repository = HOME, matrix = {}) => {
    const ls = labelsOf(e, github, repository, matrix);
    if (ls.includes(UNREADABLE)) return 'unreadable';
    return ls.length === 1 && hostedLabel(ls[0]) ? ls[0] : 'ours';
  };
  const prFrom = (event_name, headRepo, login = NOT_DEPENDABOT) =>
    ({ event_name, event: { pull_request: { head: { repo: { full_name: headRepo } }, user: { login } } } });
  const forkPr = (event_name) => prFrom(event_name, FORK_REPO, ANYONE);
  const EVENTS = ['push', 'schedule', 'workflow_dispatch'].map((event_name) => ({ event_name, event: {} }));
  // Every event an expression is read under, here and in a fork repository.
  const SCENARIOS = [
    ...EVENTS.map((g) => [g, HOME]), ...EVENTS.map((g) => [g, FORK_REPO]),
    ...['pull_request', 'pull_request_review', 'pull_request_target'].flatMap((ev) => [[prFrom(ev, HOME), HOME], [forkPr(ev), HOME]]),
    [prFrom('pull_request', HOME, 'dependabot[bot]'), HOME], [forkPr('pull_request'), FORK_REPO],
  ];
  for (const f of files) {
    const y = readLf(dir, f);
    // A called workflow runs on whatever event its caller ran on, pull requests included.
    const onPrs = /\bpull_request(_target|_review)?\b|\bworkflow_call\b/.test(onBlock(y));
    const js = jobsOf(y);
    // A runs-on this check did not read is a runner it cannot vouch for.
    check(`${f}: every runs-on is in a job this check reads`,
      !js.some((j) => j.id === UNREADABLE) && runsOnKeys(y) === js.filter((j) => j.hasRunsOn).length);
    for (const job of js) {
      if (!job.hasRunsOn) continue;
      const at = `${f} ${job.id}`;
      if (job.expr === null || job.expr === UNREADABLE) {
        const labels = job.expr === null ? job.labels : [UNREADABLE];
        for (const l of labels) if (!hostedLabel(l) && l !== 'self-hosted' && !ourLabel(l)) foreign.push(`${at}: ${l}`);
        if (!labels.every(hostedLabel) && !labels.includes(UNREADABLE)) literal.push({ at, job, onPrs });
        continue;
      }
      // Each matrix combination is its own job to Actions, so each is held to the rules alone.
      const cs = job.combos;
      const per = cs.map((c) => [...new Set(SCENARIOS.flatMap(([g, repo]) => labelsOf(job.expr, g, repo, c)))]);
      for (const l of new Set(per.flat())) if (!hostedLabel(l) && l !== 'self-hosted' && !ourLabel(l)) foreign.push(`${at}: ${l}`);
      if (per.flat().includes(UNREADABLE)) continue;
      const ours = cs.filter((_, i) => !per[i].every(hostedLabel));
      if (!ours.length) continue;
      const entry = { f, at, e: job.expr, cs: ours, all: cs };
      if (ours.every((c) => hostedLabel(runner(job.expr, forkPr('pull_request'), HOME, c)))) ownExprs.push(entry);
      else repoOnly.push(entry);
    }
  }
  check(`every runs-on names only GitHub's runners, self-hosted, or this repository's own${foreign.length ? ` (not: ${foreign.join('; ')})` : ''}`, foreign.length === 0);
  check(`the own-code runs-on expression is in use (at least ${minOwn})`, ownExprs.length >= minOwn);
  if (files.includes('codeql.yml')) {
    // CodeQL sizes itself to the machine, and every repository's exec runners share one host.
    const codeql = jobsOf(readLf(dir, 'codeql.yml')).filter((j) => j.hasRunsOn);
    check('CodeQL runs on GitHub\'s runners', codeql.length > 0 && codeql.every((j) => j.expr === null && j.labels.length > 0 && j.labels.every(hostedLabel)));
  }
  // `cs` is each combination that can land on our runners; every check holds for each of them.
  const hosted = (r) => hostedLabel(r);
  for (const { at: f, e, cs, all } of ownExprs) {
    const each = (fn) => cs.every(fn);
    check(`${f}: a fork's pull_request runs on GitHub's runners`, each((c) => hosted(runner(e, forkPr('pull_request'), HOME, c))));
    check(`${f}: a fork's pull_request_review runs on GitHub's runners`, each((c) => hosted(runner(e, forkPr('pull_request_review'), HOME, c))));
    check(`${f}: a fork's pull_request_target runs on GitHub's runners`, each((c) => hosted(runner(e, forkPr('pull_request_target'), HOME, c))));
    check(`${f}: a Dependabot PR runs on GitHub's runners`, each((c) => hosted(runner(e, prFrom('pull_request', HOME, 'dependabot[bot]'), HOME, c))));
    check(`${f}: a same-repo PR runs on ours`, each((c) => runner(e, prFrom('pull_request', HOME), HOME, c) === 'ours'));
    check(`${f}: a push, schedule or dispatch runs on ours`, each((c) => EVENTS.every((ev) => runner(e, ev, HOME, c) === 'ours')));
    check(`${f}: in a fork repository every event runs on GitHub's runners`,
      each((c) => [...EVENTS, forkPr('pull_request')].every((ev) => hosted(runner(e, ev, FORK_REPO, c)))));
    check(`${f}: the expression names exactly our label`, e.includes(`fromJSON('["self-hosted","${LABEL}"]')`));
    const other = all.filter((c) => /^(windows|macos)-/.test(c.os ?? ''));
    if (e.includes('matrix.os') && other.length) {
      check(`${f}: Windows and macOS entries keep their own runners, here and in a fork repository`,
        other.every((c) => runner(e, prFrom('pull_request', HOME), HOME, c) === c.os
          && runner(e, EVENTS[0], HOME, c) === c.os && runner(e, EVENTS[0], FORK_REPO, c) === c.os));
    }
  }
  for (const { f, at, e, cs } of repoOnly) {
    check(`${at}: every event here runs on ours`, cs.every((c) => [...EVENTS, forkPr('pull_request')].every((ev) => runner(e, ev, HOME, c) === 'ours')));
    check(`${at}: in a fork repository it runs on GitHub's runners`, cs.every((c) => EVENTS.every((ev) => hosted(runner(e, ev, FORK_REPO, c)))));
    check(`${at}: only a job that never runs PR code uses it`, repoOnlyAllowed.includes(f));
  }
  // A literal self-hosted runs-on has no fallback, so the job's own if: is what keeps code nobody
  // here wrote off our runners: on a workflow that runs on pull requests, a fork's PR and a
  // Dependabot PR must not run it; anywhere, a fork repository's pushes and schedules must not.
  for (const { at, job, onPrs } of literal) {
    let readable = true;
    const runsFor = (github, repository = HOME) => {
      // Runs unless its if: is false whatever the sender chose: UNKNOWN runs.
      try { return condOf(job.cond, { github: { repository, ...github } }) !== false; } catch { readable = false; return true; }
    };
    const kept = job.cond !== ''
      && (!onPrs || (!runsFor(forkPr('pull_request')) && !runsFor(forkPr('pull_request_review'))
        && !runsFor(forkPr('pull_request_target')) && !runsFor(prFrom('pull_request', HOME, 'dependabot[bot]'))))
      && ['push', 'schedule'].every((event_name) => !runsFor({ event_name, event: {} }, FORK_REPO));
    check(`${at}: a literal self-hosted job's if: keeps forks${onPrs ? ', fork PRs and Dependabot PRs' : ''} off our runners`, kept && readable);
  }

  // The review relay.
  const relay = beside.find((w) => w.f === 'fleet-review-relay.yml')?.y ?? '';
  check('the review relay is listed in workflow_run', /^name: Fleet review relay$/m.test(relay) && (list ?? []).includes(RELAY_NAME));
  // A relay that misses submitted, edited or dismissed leaves the review lane stale on that event.
  check('the review relay fires on every review submitted, edited or dismissed, and on nothing else',
    /^on:\n {2}pull_request_review:\n {4}types: \[submitted, edited, dismissed\]\n\npermissions: \{\}$/m.test(relay)
    && (relay.match(/^on:/gm) ?? []).length === 1);
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
