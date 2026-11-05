// Fuzz the pin bump's workflow-file readers and rewriters: they take the text of a caller
// workflow from another repository (the fleet's callers, a fork's callers) and rewrite its pins or
// read its permissions, and what they get wrong either breaks a caller or lets a form they cannot
// read pass for a safe one.
// Contracts: actionPins, maskPins and bumpActionPins keep the line count and move only pin
// revisions (maskPins of the bumped text equals maskPins of the original), and bumping twice is
// bumping once; bumpCaller either throws its plain Error or returns text it would leave unchanged
// on a second bump; permissionsOf and missingGrants either throw a plain Error (the documented
// refusal of a form they cannot read) or return their documented shape, never a TypeError; and a
// job's name never changes the answer: a job called `constructor` or `__proto__` is judged like
// any other, since a map keyed by file text must not read an inherited property as a job's own.
// The input is three NUL-separated fields: a caller workflow, a called workflow and a job name.
import {
  CALLERS,
  actionPins,
  bumpActionPins,
  bumpCaller,
  countActionPins,
  fixCallerYaml,
  maskPins,
  missingGrants,
  permissionsOf,
} from '../scripts/redline/pin.mjs';
import { attempt, fail } from './violation.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const LEVELS = ['none', 'read', 'write'];

function checkShape(p) {
  if (!p || typeof p !== 'object') fail('permissionsOf did not return an object');
  for (const block of [p.top ?? {}, ...Object.values(p.jobs)]) {
    if (typeof block !== 'object') fail('a permissions block is not an object');
    for (const [scope, level] of Object.entries(block)) if (!LEVELS.includes(level)) fail(`permissions ${scope} has level ${level}`);
  }
  for (const v of Object.values(p.uses)) if (typeof v !== 'string') fail('a job uses value is not a string');
}

// What missingGrants answers for a caller and a called workflow, as a comparable string.
function grantsOf(caller, called) {
  const r = attempt(() => missingGrants(caller, called));
  if (r.refused) return 'refused';
  if (!Array.isArray(r.value) || r.value.some((x) => typeof x !== 'string')) fail('missingGrants did not return a list of strings');
  return JSON.stringify(r.value);
}

export function fuzz(data) {
  const [caller = '', called = '', job = ''] = data.toString('utf8').split('\0');

  const pins = actionPins(caller);
  if (pins.some((p) => !/^[0-9a-f]{40}$/.test(p)) || countActionPins(caller) !== pins.length) fail('actionPins returned a malformed pin list');
  const bumped = bumpActionPins(caller, SHA, 'note');
  if (bumped.split('\n').length !== caller.split('\n').length) fail('bumpActionPins changed the line count');
  if (actionPins(bumped).length !== pins.length || actionPins(bumped).some((p) => p !== SHA)) fail('bumpActionPins left a pin at its old revision');
  if (maskPins(bumped) !== maskPins(caller)) fail('bumpActionPins changed something other than a pin');
  if (bumpActionPins(bumped, SHA, 'note') !== bumped) fail('bumpActionPins is not idempotent');
  const masked = maskPins(caller);
  if (maskPins(masked) !== masked || masked.split('\n').length !== caller.split('\n').length) fail('maskPins is not a stable line-for-line rewrite');

  const once = attempt(() => bumpCaller(caller, SHA, 'note'));
  if (once.value !== undefined) {
    if (typeof once.value !== 'string' || !once.value.includes(`redline-ref: ${SHA}`)) fail('bumpCaller left no redline-ref at the new revision');
    if (!CALLERS.some((c) => once.value.includes(`uses: ${c.workflow}@${SHA}`))) fail('bumpCaller left no call at the new revision');
    const twice = attempt(() => bumpCaller(once.value, SHA, 'note'));
    if (twice.value !== once.value) fail('bumpCaller is not idempotent');
  }

  for (const text of [caller, called]) {
    const p = attempt(() => permissionsOf(text));
    if (p.value !== undefined) checkShape(p.value);
  }
  grantsOf(caller, called);

  // The same well-formed caller under the fuzzed job name and under an ordinary one. The calling
  // job is always called `ordinary`; a fuzzed name equal to it would be a duplicate key, not a test.
  const callerFor = (name) => `permissions:\n  contents: read\njobs:\n  ${name}:\n    uses: ${CALLERS[0].workflow}@${SHA}\n    with:\n      redline-ref: ${SHA}\n`;
  // Another job, under the fuzzed name, with a broad block of its own: it grants the calling job nothing.
  const withOther = (name) => `${callerFor('ordinary')}  ${name}:\n    permissions:\n      pull-requests: write\n    runs-on: x\n`;
  const calledNeeds = 'permissions:\n  contents: read\n  pull-requests: write\njobs:\n  review:\n    runs-on: x\n';
  const reference = grantsOf(callerFor('ordinary'), calledNeeds);
  for (const name of [job, ...Object.getOwnPropertyNames(Object.prototype)]) {
    // Only a valid job id (a letter or underscore, then letters, digits, dashes and underscores):
    // a name the reader rightly refuses as a key is not a counterexample.
    if (!/^[A-Za-z_][\w-]*$/.test(name) || name === 'ordinary') continue;
    if (grantsOf(callerFor(name), calledNeeds) !== reference) fail(`a job called ${name} is judged differently from an ordinary one`);
    if (grantsOf(withOther(name), calledNeeds) !== reference) fail(`another job called ${name} changed what the calling job is granted`);
  }

  const generated = attempt(() => fixCallerYaml(SHA, job, 'note'));
  if (generated.value !== undefined && (typeof generated.value !== 'string' || generated.value.includes('\r'))) fail('fixCallerYaml returned malformed text');
}
