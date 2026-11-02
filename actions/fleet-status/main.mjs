// The action's entry. The runner runs this file with the Node it ships (runs.using in action.yml),
// so the job spends nothing on a setup-node step. The runner hands each input over as
// INPUT_<NAME>, the name upper-cased with its hyphens kept; the script reads the CLI's names.
import { main } from '../../scripts/fleet-status/fleet-status.mjs';

const input = (name) => (process.env[`INPUT_${name.toUpperCase()}`] ?? '').trim();
const { GITHUB_REPOSITORY: repo, GITHUB_SERVER_URL: server, GITHUB_RUN_ID: runId } = process.env;

process.exitCode = await main({
  GITHUB_TOKEN: input('token'),
  REPO: repo,
  PR: input('pr'),
  HEAD_REPO: input('head-repo'),
  HEAD_BRANCH: input('head-branch'),
  ALL_OPEN: input('all-open'),
  DRY_RUN: input('dry-run'),
  // Empty links the run, as the input's description says.
  TARGET_URL: input('target-url') || `${server}/${repo}/actions/runs/${runId}`,
}, []);
