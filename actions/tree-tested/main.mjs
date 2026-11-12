// The action's entry. The runner runs this file with the Node it ships (runs.using in action.yml)
// and hands each input over as INPUT_<NAME>. The event's facts (repository, event, ref, sha, the
// workflow's file) are the runner's own GITHUB_* variables; the script reads those.
import { appendFileSync } from 'node:fs';
import { main } from '../../scripts/tree-tested/check.mjs';

const input = (name) => (process.env[`INPUT_${name.toUpperCase()}`] ?? '').trim();

try {
  process.exitCode = await main({ ...process.env, GITHUB_TOKEN: input('token'), DEFAULT_BRANCH: input('default-branch'), SAME_ON_PULL_REQUEST: input('same-on-pull-request') });
} catch (e) {
  // A failure of the check runs the job in full; it never fails the job.
  console.log(`tested in full: ${e.message}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'tested=false\nrun=\n');
}
