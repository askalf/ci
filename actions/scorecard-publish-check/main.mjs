// The action's entry. The runner runs this file with the Node it ships (runs.using in action.yml),
// and hands each input over as INPUT_<NAME>, the name upper-cased with its hyphens kept.
import { main } from '../../scripts/scorecard-publish/check.mjs';

const input = (name) => (process.env[`INPUT_${name.toUpperCase()}`] ?? '').trim();

process.exitCode = await main({
  GITHUB_TOKEN: input('token'),
  REPO: process.env.GITHUB_REPOSITORY,
  GITHUB_EVENT_PATH: process.env.GITHUB_EVENT_PATH,
  GITHUB_API_URL: process.env.GITHUB_API_URL,
  DRY_RUN: input('dry-run'),
});
