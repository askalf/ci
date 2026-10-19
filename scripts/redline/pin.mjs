#!/usr/bin/env node
// Rewrites a Redline caller so it calls its askalf/ci reusable workflow at one commit and has
// the script fetched at that same commit. Two callers share the shape: redline.yml calls
// redline-review.yml (the review) and redline-fix.yml calls redline-fix-run.yml (the fix). The
// reusable workflow cannot learn its own commit (github.job_workflow_sha is not available to
// expressions), so the caller passes it as the redline-ref input, and the two must always name
// the same sha.
//
// CLI: node scripts/redline/pin.mjs <sha> [note] < redline.yml > redline.yml.new
//      node scripts/redline/pin.mjs --caller <sha> <runner-label> [note] > redline-fix.yml
//      node scripts/redline/pin.mjs --action <sha> [note] < watcher.yml > watcher.yml.new
//      node scripts/redline/pin.mjs --action-pins < watcher.yml
//      node scripts/redline/pin.mjs --grants <called.yml> < caller.yml
//
// The third form moves the drift-report action pin (actions/drift-report), which a watcher
// workflow carries as a step and not as a job, so it has no redline-ref to keep in step.
// The fourth prints the sha of each of those pins, one per line, so a caller deciding whether a
// file needs the third form recognises exactly the lines the third form rewrites.
// The fifth prints each permission the called workflow asks for that the caller does not grant,
// one `scope: level` per line. GitHub refuses to start a called workflow that asks for more than
// its caller grants (startup_failure, before any job runs), so a pin must never move ahead of
// the grant it needs.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const REVIEW_WORKFLOW = 'askalf/ci/.github/workflows/redline-review.yml';
export const FIX_WORKFLOW = 'askalf/ci/.github/workflows/redline-fix-run.yml';
export const DRIFT_REPORT_ACTION = 'askalf/ci/actions/drift-report';
/** Every reusable workflow a caller pins, and the caller file that pins it. */
export const CALLERS = [
  { workflow: REVIEW_WORKFLOW, path: '.github/workflows/redline.yml' },
  { workflow: FIX_WORKFLOW, path: '.github/workflows/redline-fix.yml' },
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

// The action path has only letters, dashes, dots and slashes; the dots are what a pattern must escape.
const ACTION_PATH = DRIFT_REPORT_ACTION.replace(/\./g, '\\.');
// After the sha: spaces, an optional comment, and the carriage return a CRLF file leaves on every
// line once it is split on '\n'. Each is matched on its own, so a pin with trailing spaces and no
// comment, or an uncommented pin in a CRLF file, is a pin.
const ACTION_PIN = new RegExp(`^(\\s*(?:- )?uses:\\s*)${ACTION_PATH}@([0-9a-f]{40})[ \\t]*(#[^\\r]*)?(\\r?)$`);

/** The sha of each drift-report action pin a workflow carries, in file order. */
export function actionPins(yaml) {
  return yaml.split('\n').map((l) => ACTION_PIN.exec(l)?.[2]).filter(Boolean);
}

/** How many drift-report action pins a workflow carries. Zero means the file is not a caller. */
export function countActionPins(yaml) {
  return actionPins(yaml).length;
}

/**
 * The workflow's yaml with every drift-report action pin at `sha`. A workflow without one comes
 * back unchanged, so a caller may pass any workflow file through without checking it first.
 * @param {string} yaml
 * @param {string} sha
 * @param {string} [note] the pin's trailing comment, e.g. "main 2026-10-09, askalf/ci#37"
 */
export function bumpActionPins(yaml, sha, note = '') {
  if (!SHA.test(sha)) throw new Error(`not a full commit sha: ${sha}`);
  return yaml.split('\n').map((l) => {
    const m = ACTION_PIN.exec(l);
    // The line keeps its ending; the old comment gives way to the note, or to nothing.
    return m ? `${m[1]}${DRIFT_REPORT_ACTION}@${sha}${note ? ` # ${note}` : ''}${m[4]}` : l;
  }).join('\n');
}

const LEVEL = { none: 0, read: 1, write: 2 };
const SCOPES = ['actions', 'attestations', 'checks', 'contents', 'deployments', 'discussions', 'id-token', 'issues',
  'models', 'packages', 'pages', 'pull-requests', 'repository-projects', 'security-events', 'statuses'];
// A YAML scalar without its quotes: 'read' and "read" are read.
const unquote = (x) => (/^(['"]).*\1$/.test(x) ? x.slice(1, -1) : x);
// A mapping key, quoted or not: "permissions": is the permissions key, "review": the review job.
const keyOf = (l) => unquote(l.trim().split(':')[0].trim());
const valueOf = (l) => l.replace(/\s+#.*$/, '').split(':').slice(1).join(':').trim();

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
 * job's own block by job name. Line based, like the rest of this file: a top-level key sits at
 * indent 0, a job name one level under `jobs:`, and a job's keys one level under its name.
 * Only that block shape is read. A form that could carry permissions this does not see throws
 * instead of reading as none: `jobs:` or a job written inline (a flow map or an alias), and a
 * `<<` merge key at any of those levels.
 * @param {string} yaml
 */
export function permissionsOf(yaml) {
  const lines = yaml.split('\n').map((l) => l.replace(/\r$/, ''));
  let top = null;
  const jobs = {};
  let inJobs = false, job = null, jobPad = -1, keyPad = -1;
  const refuse = (i, what) => { throw new Error(`${what} at line ${i + 1} cannot be read for permissions: ${lines[i].trim()}`); };
  lines.forEach((l, i) => {
    if (blank(l)) return;
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
  });
  return { top, jobs };
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
  const lines = callerYaml.split('\n');
  // The calling job is found from its uses line; a caller where that line cannot be found (a flow
  // map job, say) throws, so a job-level override it might hold is never skipped for the top level.
  const usesAt = lines.findIndex((l) => !blank(l) && keyOf(l) === 'uses' && CALLERS.some((c) => unquote(valueOf(l)).startsWith(`${c.workflow}@`)));
  if (usesAt < 0) throw new Error(`no ${CALLERS.map((c) => c.workflow).join(' or ')} call this can read`);
  let callingJob = null;
  for (let i = usesAt - 1; usesAt > 0 && i >= 0; i--) {
    if (!blank(lines[i]) && indentOf(lines[i]) < indentOf(lines[usesAt])) { callingJob = keyOf(lines[i]); break; }
  }
  const grant = (callingJob !== null ? caller.jobs[callingJob] : undefined) ?? caller.top;
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
    } else {
      const [sha, note = ''] = args;
      process.stdout.write(bumpCaller(readFileSync(0, 'utf8'), sha ?? '', note));
    }
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}
