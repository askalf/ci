#!/usr/bin/env node
// Rewrites a Redline caller so it calls its askalf/ci reusable workflow at one commit and has
// the script fetched at that same commit. Three callers share the shape: redline.yml calls
// redline-review.yml (the review), redline-fix.yml calls redline-fix-run.yml (the fix) and
// public-text.yml calls public-text.yml (the dash check). The
// reusable workflow cannot learn its own commit (github.job_workflow_sha is not available to
// expressions), so the caller passes it as the redline-ref input, and the two must always name
// the same sha.
//
// CLI: node scripts/redline/pin.mjs <sha> [note] < redline.yml > redline.yml.new
//      node scripts/redline/pin.mjs --caller <sha> <runner-label> [note] > redline-fix.yml
//      node scripts/redline/pin.mjs --action <sha> [note] < watcher.yml > watcher.yml.new
//      node scripts/redline/pin.mjs --action-pins < watcher.yml
//      node scripts/redline/pin.mjs --grants <called.yml> < caller.yml
//      node scripts/redline/pin.mjs --mask < workflow.yml
//
// The third form moves the action pins (actions/drift-report in a drift watcher,
// actions/checkout-with-retry in any workflow, actions/fleet-status and actions/fleet-status-check
// in the fleet-status workflows), which a workflow carries as steps and not as a
// job, so they have no redline-ref to keep in step. Each pin keeps its own action path.
// The fourth prints the sha of each of those pins, one per line, so a caller deciding whether a
// file needs the third form recognises exactly the lines the third form rewrites.
// The fifth prints each permission the called workflow asks for that the caller does not grant,
// one `scope: level` per line. GitHub refuses to start a called workflow that asks for more than
// its caller grants (startup_failure, before any job runs), so a pin must never move ahead of
// the grant it needs.
// The sixth prints the file with the revision of every pin this script rewrites replaced by PIN
// and its trailing note dropped, so two versions of a file that differ only in those revisions
// read the same. The bump's pick step uses it to tell this repository's own pin bump from a
// change to what a caller runs.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const REVIEW_WORKFLOW = 'askalf/ci/.github/workflows/redline-review.yml';
export const FIX_WORKFLOW = 'askalf/ci/.github/workflows/redline-fix-run.yml';
export const PUBLIC_TEXT_WORKFLOW = 'askalf/ci/.github/workflows/public-text.yml';
export const DRIFT_REPORT_ACTION = 'askalf/ci/actions/drift-report';
export const CHECKOUT_RETRY_ACTION = 'askalf/ci/actions/checkout-with-retry';
export const FLEET_STATUS_ACTION = 'askalf/ci/actions/fleet-status';
export const FLEET_STATUS_CHECK_ACTION = 'askalf/ci/actions/fleet-status-check';
/** Every action of this repository a workflow pins as a step; `--action` moves them all. */
export const ACTIONS = [DRIFT_REPORT_ACTION, CHECKOUT_RETRY_ACTION, FLEET_STATUS_ACTION, FLEET_STATUS_CHECK_ACTION];
/** Every reusable workflow a caller pins, and the caller file that pins it. */
export const CALLERS = [
  { workflow: REVIEW_WORKFLOW, path: '.github/workflows/redline.yml' },
  { workflow: FIX_WORKFLOW, path: '.github/workflows/redline-fix.yml' },
  { workflow: PUBLIC_TEXT_WORKFLOW, path: '.github/workflows/public-text.yml' },
];
const SHA = /^[0-9a-f]{40}$/;

const indentOf = (l) => /^ */.exec(l)[0].length;
const blank = (l) => l.trim() === '' || l.trimStart().startsWith('#');

/**
 * The caller's yaml with the uses pin and the redline-ref input both at `sha`. Adds the input,
 * and a `with:` block for it, when the caller has neither. Throws when there is no pinned call.
 * @param {string} yaml
 * @param {string} sha
 * @param {string} [note] the pin's trailing comment, e.g. "main 2026-09-26, askalf/ci#72"
 */
export function bumpCaller(yaml, sha, note = '') {
  if (!SHA.test(sha)) throw new Error(`not a full commit sha: ${sha}`);
  const lines = yaml.split('\n');
  let workflow = null;
  const usesAt = lines.findIndex((l) => {
    workflow = CALLERS.map((c) => c.workflow).find((w) => l.trimStart().startsWith(`uses: ${w}@`)) ?? null;
    return workflow !== null;
  });
  if (usesAt < 0) throw new Error(`no ${CALLERS.map((c) => c.workflow).join(' or ')} call`);
  const pad = indentOf(lines[usesAt]);
  lines[usesAt] = `${' '.repeat(pad)}uses: ${workflow}@${sha}${note ? ` # ${note}` : ''}`;

  // The job's keys sit at the uses line's indent, between the job name above and the next line
  // indented less.
  let start = usesAt;
  while (start > 0 && (blank(lines[start - 1]) || indentOf(lines[start - 1]) >= pad)) start--;
  let end = usesAt + 1;
  while (end < lines.length && (blank(lines[end]) || indentOf(lines[end]) >= pad)) end++;
  const withAt = lines.findIndex((l, i) => i >= start && i < end && indentOf(l) === pad && /^with:\s*(#.*)?$/.test(l.trim()));

  if (withAt < 0) {
    lines.splice(usesAt + 1, 0, `${' '.repeat(pad)}with:`, `${' '.repeat(pad + 2)}redline-ref: ${sha}`);
    return lines.join('\n');
  }
  let inputEnd = withAt + 1;
  while (inputEnd < end && (blank(lines[inputEnd]) || indentOf(lines[inputEnd]) > pad)) inputEnd++;
  const inputs = lines.slice(withAt + 1, inputEnd);
  const childPad = inputs.find((l) => !blank(l)) ? indentOf(inputs.find((l) => !blank(l))) : pad + 2;
  const refAt = inputs.findIndex((l) => !blank(l) && indentOf(l) === childPad && /^redline-ref:/.test(l.trim()));
  const refLine = `${' '.repeat(childPad)}redline-ref: ${sha}`;
  if (refAt >= 0) lines[withAt + 1 + refAt] = refLine;
  else lines.splice(withAt + 1, 0, refLine);
  return lines.join('\n');
}

/**
 * A repository's redline-fix.yml: the workflow_dispatch caller forge runs when Redline requests
 * changes. `runnerLabel` is the repo's exec runner label (`<repo>-exec`). The caller job cannot carry runs-on itself (a job that uses a reusable
 * workflow takes no runner), so the label travels as an input.
 */
export function fixCallerYaml(sha, runnerLabel, note = '') {
  if (!SHA.test(sha)) throw new Error(`not a full commit sha: ${sha}`);
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(runnerLabel)) throw new Error(`not a runner label: ${runnerLabel}`);
  return `# Redline fix: when Redline requests changes on a pull request here, forge dispatches this run
# with the PR, the head Redline reviewed and the review. The fix itself is computed by
# askalf/ci (redline-fix-run.yml) on this repository's non-root exec runner and uploaded as
# the redline-fix artifact. Nothing here pushes or comments, and no token that could is on the
# runner: forge verifies the artifact and pushes the fix to the PR branch with its own token.
name: Redline fix
run-name: Redline fix \${{ github.repository }}#\${{ inputs.pr }} @ \${{ inputs.head }}

on:
  workflow_dispatch:
    inputs:
      pr:
        description: Pull request number.
        required: true
        type: string
      head:
        description: The full commit sha Redline reviewed. The run fails if the PR has moved past it.
        required: true
        type: string
      review:
        description: URL of the REQUEST_CHANGES review being answered.
        required: true
        type: string
      dry_run:
        description: Compute the fix and upload its diff; no commit, no bundle.
        required: false
        default: false
        type: boolean

permissions:
  contents: read
  pull-requests: read

# Queued, not cancelled: forge dispatches one run per review, and a cancelled run leaves no
# artifact for it to read.
concurrency:
  group: fix-\${{ github.repository }}-\${{ inputs.pr }}
  cancel-in-progress: false

jobs:
  fix:
    # Pinned so a change to the fix workflow reaches this repo only through a reviewed bump here.
    uses: ${FIX_WORKFLOW}@${sha}${note ? ` # ${note}` : ''}
    with:
      redline-ref: ${sha}
      # ${runnerLabel} is this repository's ephemeral exec runner: its own non-root account, one job
      # per registration, no credential but the fix lane's own model key.
      runner-label: ${runnerLabel}
      pr: \${{ inputs.pr }}
      head: \${{ inputs.head }}
      review: \${{ inputs.review }}
      dry_run: \${{ inputs.dry_run }}
`;
}

// An action path has only letters, dashes, dots and slashes; the dots are what a pattern must escape.
const ACTION_PATHS = ACTIONS.map((a) => a.replace(/\./g, '\\.')).join('|');
// After the sha: spaces, an optional comment, and the carriage return a CRLF file leaves on every
// line once it is split on '\n'. Each is matched on its own, so a pin with trailing spaces and no
// comment, or an uncommented pin in a CRLF file, is a pin. The path is captured so a bump keeps it.
const ACTION_PIN = new RegExp(`^(\\s*(?:- )?uses:\\s*)(${ACTION_PATHS})@([0-9a-f]{40})[ \\t]*(#[^\\r]*)?(\\r?)$`);

/** The sha of each action pin (any of ACTIONS) a workflow carries, in file order. */
export function actionPins(yaml) {
  return yaml.split('\n').map((l) => ACTION_PIN.exec(l)?.[3]).filter(Boolean);
}

/** How many action pins a workflow carries. Zero means the file is not a caller. */
export function countActionPins(yaml) {
  return actionPins(yaml).length;
}

/**
 * The workflow's yaml with every action pin at `sha`, each on its own action path. A workflow
 * without one comes back unchanged, so a caller may pass any workflow file through without
 * checking it first.
 * @param {string} yaml
 * @param {string} sha
 * @param {string} [note] the pin's trailing comment, e.g. "main 2026-10-09, askalf/ci#37"
 */
export function bumpActionPins(yaml, sha, note = '') {
  if (!SHA.test(sha)) throw new Error(`not a full commit sha: ${sha}`);
  return yaml.split('\n').map((l) => {
    const m = ACTION_PIN.exec(l);
    // The line keeps its path and its ending; the old comment gives way to the note, or to nothing.
    return m ? `${m[1]}${m[2]}@${sha}${note ? ` # ${note}` : ''}${m[5]}` : l;
  }).join('\n');
}

// A call to one of this repository's reusable workflows, anchored like ACTION_PIN: the value of a
// uses: key is exactly one of the CALLERS paths, so another owner's path that ends the same way
// (notaskalf/ci/...) is not one.
const CALLER_WORKFLOWS = CALLERS.map((c) => c.workflow.replace(/\./g, '\\.')).join('|');
const CALLER_PIN = new RegExp(`^(\\s*(?:- )?uses:\\s*)(${CALLER_WORKFLOWS})@([0-9a-f]{40})[ \\t]*(#[^\\r]*)?(\\r?)$`);
// The redline-ref input bumpCaller keeps in step with the call's pin.
const REF_PIN = /^(\s*redline-ref:\s*)([0-9a-f]{40})[ \t]*(#[^\r]*)?(\r?)$/;

/**
 * The workflow's yaml with the revision of each pin this file rewrites (an action pin, a call to
 * a reusable workflow, a redline-ref input) replaced by PIN and its trailing comment dropped.
 * Everything else on the line, the indentation, the key and the path included, is kept, so two
 * versions of a file read the same exactly when they differ only in those revisions and notes.
 * A pin to any other repository is left as it is.
 * @param {string} yaml
 */
export function maskPins(yaml) {
  return yaml.split('\n').map((l) => {
    const m = ACTION_PIN.exec(l) ?? CALLER_PIN.exec(l);
    if (m) return `${m[1]}${m[2]}@PIN${m[5]}`;
    const r = REF_PIN.exec(l);
    return r ? `${r[1]}PIN${r[4]}` : l;
  }).join('\n');
}

const LEVEL = { none: 0, read: 1, write: 2 };
const SCOPES = ['actions', 'attestations', 'checks', 'contents', 'deployments', 'discussions', 'id-token', 'issues',
  'models', 'packages', 'pages', 'pull-requests', 'repository-projects', 'security-events', 'statuses'];
// A YAML scalar as YAML reads it: 'it''s' is it's, and "permissions" is permissions. A
// double-quoted scalar is decoded as JSON, whose escapes YAML's include; an escape only YAML has
// (\x41, \e and the like) throws rather than leaving a spelling YAML would read differently.
const unquote = (x) => {
  if (/^'.*'$/.test(x)) return x.slice(1, -1).replace(/''/g, "'");
  if (!/^".*"$/.test(x)) return x;
  try { return JSON.parse(x); } catch { throw new Error(`a quoted scalar this cannot decode: ${x}`); }
};
// A mapping key. plainShape lets only plain keys through, so a key is its spelling.
const keyOf = (l) => l.trim().split(':')[0].trim();
// A line without its trailing comment: a # that starts a word, outside quotes.
function uncommented(l) {
  let q = '';
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = ''; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(l[i - 1]))) return l.slice(0, i).trimEnd();
  }
  return l;
}
const valueOf = (l) => uncommented(l).split(':').slice(1).join(':').trim();

const PLAIN_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.\/-]*$/;
const QUOTED = /^(?:'(?:[^']|'')*'|"(?:[^"\\]|\\.)*")$/;

/**
 * Throws unless the workflow is in the one shape permissionsOf reads. These files are written by
 * hand in a single plain style, and a check that half-reads YAML must never take a form it does not
 * read for "no permissions". So every line outside a block scalar's text is a `key: value`, a bare
 * `key:`, or a list item (`- value`, `- key: value`); keys are plain words; the root mapping sits
 * at column 0; quoted and flow values close on their own line; and nothing is tagged, anchored,
 * aliased, merged, or split into documents. Anything else is refused, whatever YAML would make of it.
 * Returns, per line, whether it is structure (a key or list item, not block scalar text, a comment
 * or blank), so a reader never takes text for a key.
 * @param {string[]} lines
 * @returns {boolean[]}
 */
function plainShape(lines) {
  let scalarCol = -1;
  let rooted = false;
  const structural = lines.map(() => false);
  lines.forEach((raw, i) => {
    const refuse = (what) => { throw new Error(`line ${i + 1} is outside the plain workflow shape (${what}): ${raw.trim()}`); };
    if (raw.trim() === '') return;
    const pad = indentOf(raw);
    if (scalarCol >= 0 && pad > scalarCol) return;
    scalarCol = -1;
    if (/^ *\t/.test(raw)) refuse('a tab in the indent');
    if (raw.trimStart().startsWith('#')) return;
    structural[i] = true;
    if (!rooted) { if (pad !== 0) refuse('the root mapping is not at column 0'); rooted = true; }
    const line = uncommented(raw).trim();
    if (/^(---|\.\.\.|%|\?)/.test(line)) refuse('a document marker, directive or complex key');
    let rest = line, col = pad;
    if (rest === '-' || rest.startsWith('- ')) { rest = rest.slice(1).trimStart(); col = pad + (line.length - rest.length); if (rest.startsWith('- ')) refuse('a nested list item'); }
    const listItem = col !== pad;
    if (rest === '') return;
    const sep = rest.search(/:(\s|$)/);
    let value;
    if (sep < 0) {
      if (!listItem) refuse('a line that is not a key, a list item or block scalar text');
      value = rest;
    } else {
      if (!PLAIN_KEY.test(rest.slice(0, sep))) refuse('a key that is not a plain word');
      value = rest.slice(sep + 1).trim();
    }
    if (value === '') return;
    if (/^[&*!]/.test(value)) refuse('an anchor, alias or tag');
    if (/^[|>][-+0-9]*$/.test(value)) { scalarCol = col; return; }
    if (/^['"]/.test(value) && !QUOTED.test(value)) refuse('a quoted value that does not close on its line');
    if (value.startsWith('{') && !value.endsWith('}')) refuse('a flow map that does not close on its line');
    if (value.startsWith('[') && !value.endsWith(']')) refuse('a flow list that does not close on its line');
  });
  return structural;
}

/** One `scope: level` entry, quoted or not. Anything else throws, so it never counts as nothing. */
function permissionEntry(entry, line) {
  const at = entry.indexOf(':');
  const scope = unquote(entry.slice(0, at).trim());
  const level = unquote(entry.slice(at + 1).trim());
  if (at < 0 || !/^[a-z-]+$/.test(scope) || !(level in LEVEL)) throw new Error(`unreadable permissions entry at line ${line}: ${entry}`);
  return [scope, level];
}

/**
 * The `permissions:` key at line `at` as {scope: level}: its inline value or the block under it.
 * `read-all` and `write-all` give every scope that level; a flow map (`{}`, `{actions: read}`)
 * and a block give their entries. Any other inline value, and any entry that is not a scope and a
 * level (quoted or not), throws: a form this cannot read must not pass for an empty grant or ask.
 */
function readPermissions(lines, at) {
  const inline = unquote(valueOf(lines[at]));
  if (inline === 'read-all' || inline === 'write-all') {
    return Object.fromEntries(SCOPES.map((k) => [k, inline === 'read-all' ? 'read' : 'write']));
  }
  const out = {};
  if (inline.startsWith('{') && inline.endsWith('}')) {
    for (const entry of inline.slice(1, -1).split(',').map((e) => e.trim()).filter(Boolean)) {
      const [scope, level] = permissionEntry(entry, at + 1);
      out[scope] = level;
    }
    return out;
  }
  if (inline !== '') throw new Error(`unreadable permissions at line ${at + 1}: ${inline}`);
  const pad = indentOf(lines[at]);
  for (let i = at + 1; i < lines.length && (blank(lines[i]) || indentOf(lines[i]) > pad); i++) {
    if (blank(lines[i])) continue;
    const [scope, level] = permissionEntry(lines[i].replace(/\s+#.*$/, '').trim(), i + 1);
    out[scope] = level;
  }
  return out;
}

/**
 * A workflow's permissions: `top` is its top-level block (null when it has none), `jobs` each
 * job's own block by job name, and `uses` each job's `uses:` value by job name. Line based, like
 * the rest of this file, over the structure plainShape finds (block scalar text is never read): a
 * top-level key sits at indent 0, a job name one level under `jobs:`, and a job's keys one level
 * under its name. A form that could carry permissions this does not see throws instead of reading
 * as none: `jobs:` or a job written inline (a flow map or an alias), and a `<<` merge key at any of
 * those levels.
 * @param {string} yaml
 */
export function permissionsOf(yaml) {
  const lines = yaml.split('\n').map((l) => l.replace(/\r$/, ''));
  const structural = plainShape(lines);
  let top = null;
  const jobs = {};
  const uses = {};
  let inJobs = false, job = null, jobPad = -1, keyPad = -1;
  const refuse = (i, what) => { throw new Error(`${what} at line ${i + 1} cannot be read for permissions: ${lines[i].trim()}`); };
  lines.forEach((l, i) => {
    if (!structural[i]) return;
    const pad = indentOf(l);
    if (pad === 0) {
      if (keyOf(l) === '<<') refuse(i, 'a merge key');
      inJobs = keyOf(l) === 'jobs';
      if (inJobs && valueOf(l) !== '') refuse(i, 'jobs written inline');
      if (keyOf(l) === 'permissions') top = readPermissions(lines, i);
      return;
    }
    if (!inJobs) return;
    if (jobPad < 0) jobPad = pad;
    if (pad === jobPad) {
      if (keyOf(l) === '<<') refuse(i, 'a merge key');
      if (valueOf(l) !== '') refuse(i, 'a job written inline');
      job = keyOf(l); keyPad = -1; return;
    }
    if (keyPad < 0) keyPad = pad;
    if (pad === keyPad && keyOf(l) === '<<') refuse(i, 'a merge key');
    if (pad === keyPad && keyOf(l) === 'permissions') jobs[job] = readPermissions(lines, i);
    if (pad === keyPad && keyOf(l) === 'uses') uses[job] = unquote(valueOf(l));
  });
  return { top, jobs, uses };
}

/**
 * Each permission the called workflow asks for, at its top level or in any of its jobs, that the
 * caller does not grant at that level or higher, as `scope: level`. The caller's grant is the
 * calling job's own block when it has one, else its top-level block. A caller with neither runs on
 * the repository's default token permissions, which a file cannot show: it answers nothing.
 * @param {string} callerYaml
 * @param {string} calledYaml
 */
export function missingGrants(callerYaml, calledYaml) {
  const caller = permissionsOf(callerYaml);
  // The calling job is the one job whose own uses key calls a reusable workflow of ours, read from
  // the structure, so text that looks like a call never stands in for it. None, or more than one,
  // throws: a job-level override is never skipped for the top level, or read off the wrong job.
  const calling = Object.entries(caller.uses).filter(([, v]) => CALLERS.some((c) => v.startsWith(`${c.workflow}@`)));
  if (calling.length !== 1) throw new Error(`${calling.length === 0 ? 'no' : `${calling.length}`} job-level ${CALLERS.map((c) => c.workflow).join(' or ')} call(s) this can read; expected exactly one`);
  const callingJob = calling[0][0];
  const grant = caller.jobs[callingJob] ?? caller.top;
  if (grant === null) return [];
  const called = permissionsOf(calledYaml);
  const asks = {};
  for (const block of [called.top ?? {}, ...Object.values(called.jobs)]) {
    for (const [k, v] of Object.entries(block)) if ((LEVEL[v] ?? 0) > (LEVEL[asks[k]] ?? 0)) asks[k] = v;
  }
  return Object.entries(asks).filter(([k, v]) => (LEVEL[grant[k]] ?? 0) < LEVEL[v]).map(([k, v]) => `${k}: ${v}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === '--caller') {
      const [, sha, label, note = ''] = args;
      process.stdout.write(fixCallerYaml(sha ?? '', label ?? '', note));
    } else if (args[0] === '--action') {
      const [, sha, note = ''] = args;
      process.stdout.write(bumpActionPins(readFileSync(0, 'utf8'), sha ?? '', note));
    } else if (args[0] === '--grants') {
      if (!args[1]) throw new Error('--grants takes the called workflow file');
      const missing = missingGrants(readFileSync(0, 'utf8'), readFileSync(args[1], 'utf8'));
      process.stdout.write(missing.map((m) => `${m}\n`).join(''));
    } else if (args[0] === '--action-pins') {
      const pins = actionPins(readFileSync(0, 'utf8'));
      process.stdout.write(pins.map((p) => `${p}\n`).join(''));
    } else if (args[0] === '--mask') {
      process.stdout.write(maskPins(readFileSync(0, 'utf8')));
    } else {
      const [sha, note = ''] = args;
      process.stdout.write(bumpCaller(readFileSync(0, 'utf8'), sha ?? '', note));
    }
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}
