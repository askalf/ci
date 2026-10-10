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
//
// The third form moves the drift-report action pin (actions/drift-report), which a watcher
// workflow carries as a step and not as a job, so it has no redline-ref to keep in step.

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
const ACTION_PIN = new RegExp(`^(\\s*(?:- )?uses:\\s*)${ACTION_PATH}@[0-9a-f]{40}[ \\t]*(#[^\\r]*)?(\\r?)$`);

/** How many drift-report action pins a workflow carries. Zero means the file is not a caller. */
export function countActionPins(yaml) {
  return yaml.split('\n').filter((l) => ACTION_PIN.test(l)).length;
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
    return m ? `${m[1]}${DRIFT_REPORT_ACTION}@${sha}${note ? ` # ${note}` : ''}${m[3]}` : l;
  }).join('\n');
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
    } else {
      const [sha, note = ''] = args;
      process.stdout.write(bumpCaller(readFileSync(0, 'utf8'), sha ?? '', note));
    }
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}
