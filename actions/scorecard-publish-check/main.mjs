// The action's entry. The runner runs this file with the Node it ships (runs.using in action.yml),
// and hands each input over as INPUT_<NAME>, the name upper-cased with its hyphens kept. The run's
// facts are inputs, defaulted in action.yml from the workflow_run event; the script reads the
// CLI's names.
import { main } from '../../scripts/scorecard-publish/check.mjs';

const input = (name) => (process.env[`INPUT_${name.toUpperCase()}`] ?? '').trim();

process.exitCode = await main({
  GITHUB_TOKEN: input('token'),
  REPO: process.env.GITHUB_REPOSITORY,
  GITHUB_API_URL: process.env.GITHUB_API_URL,
  EVENT_NAME: process.env.GITHUB_EVENT_NAME,
  RUN_ID: input('run-id'),
  RUN_EVENT: input('run-event'),
  RUN_CONCLUSION: input('run-conclusion'),
  RUN_BRANCH: input('run-branch'),
  RUN_STARTED_AT: input('run-started-at'),
  RUN_PATH: input('run-path'),
  DEFAULT_BRANCH: input('default-branch'),
  PRIVATE: input('private'),
  DRY_RUN: input('dry-run'),
});
