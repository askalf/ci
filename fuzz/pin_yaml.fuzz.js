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

const SHA = '0123456789abcdef0123456789abcdef01234567';
const LEVELS = ['none', 'read', 'write'];

function fail(msg) {
  throw new Error(msg);
}

// The refusals the readers document are plain Errors; anything else is a defect in the reader.
function refusal(e) {
  return e instanceof Error && e.constructor === Error;
}

function shapeOf(p) {
  if (!p || typeof p !== 'object') fail('permissionsOf did not return an object');
  for (const block of [p.top ?? {}, ...Object.values(p.jobs)]) {
    if (typeof block !== 'object') fail('a permissions block is not an object');
    for (const [scope, level] of Object.entries(block)) if (!LEVELS.includes(level)) fail(`permissions ${scope} has level ${level}`);
  }
  for (const v of Object.values(p.uses)) if (typeof v !== 'string') fail('a job uses value is not a string');
}

function grantsOf(caller, called) {
  try {
    const m = missingGrants(caller, called);
    if (!Array.isArray(m) || m.some((x) => typeof x !== 'string')) fail('missingGrants did not return a list of strings');
    return JSON.stringify(m);
  } catch (e) {
    if (!refusal(e)) throw e;
    return 'refused';
  }
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

  try {
    const once = bumpCaller(caller, SHA, 'note');
    if (typeof once !== 'string' || !once.includes(`redline-ref: ${SHA}`)) fail('bumpCaller left no redline-ref at the new revision');
    if (!CALLERS.some((c) => once.includes(`uses: ${c.workflow}@${SHA}`))) fail('bumpCaller left no call at the new revision');
    if (bumpCaller(once, SHA, 'note') !== once) fail('bumpCaller is not idempotent');
  } catch (e) {
    if (!refusal(e)) throw e;
  }

  try {
    shapeOf(permissionsOf(caller));
    shapeOf(permissionsOf(called));
  } catch (e) {
    if (!refusal(e)) throw e;
  }
  grantsOf(caller, called);

  // The same well-formed caller under the fuzzed job name and under an ordinary one.
  const callerFor = (name) => `permissions:\n  contents: read\njobs:\n  ${name}:\n    uses: ${CALLERS[0].workflow}@${SHA}\n    with:\n      redline-ref: ${SHA}\n`;
  // Another job, under the fuzzed name, with a broad block of its own: it grants the calling job nothing.
  const withOther = (name) => `${callerFor('ordinary')}  ${name}:
    permissions:
      pull-requests: write
    runs-on: x
`;
  const calledNeeds = 'permissions:\n  contents: read\n  pull-requests: write\njobs:\n  review:\n    runs-on: x\n';
  const reference = grantsOf(callerFor('ordinary'), calledNeeds);
  for (const name of [job, ...Object.getOwnPropertyNames(Object.prototype)]) {
    if (!/^[\w-]+$/.test(name)) continue;
    if (grantsOf(callerFor(name), calledNeeds) !== reference) fail(`a job called ${name} is judged differently from an ordinary one`);
    if (grantsOf(withOther(name), calledNeeds) !== reference) fail(`another job called ${name} changed what the calling job is granted`);
  }

  try {
    const generated = fixCallerYaml(SHA, job, 'note');
    if (typeof generated !== 'string' || /[\r]/.test(generated)) fail('fixCallerYaml returned malformed text');
  } catch (e) {
    if (!refusal(e)) throw e;
  }
}
