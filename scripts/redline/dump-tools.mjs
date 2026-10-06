// Writes the tools Redline hands a model to one file per lane, the tool surface as a file that
// truecopy can pin and poison-scan: tools.json is TOOLS in review.mjs (the reviewer's read-only
// tools), fix-tools.json is TOOLS in fix.mjs (the fixer's, which write and run in the checkout).
// The descriptions are what the model reads and acts on, so a change to one has to be regenerated
// and re-pinned on purpose. The system prompts are not here: they are installed on the runner hosts
// and never committed to this repository.
//
//   node scripts/redline/dump-tools.mjs           regenerate both files
//   node scripts/redline/dump-tools.mjs --check   exit 1 if either no longer matches its TOOLS
//
// The entries are written exactly as the Messages API receives them (input_schema, not MCP's
// inputSchema); truecopy scans the whole tool object either way.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOOLS as REVIEW_TOOLS } from './review.mjs';
import { TOOLS as FIX_TOOLS } from './fix.mjs';

const SURFACES = [
  { file: 'tools.json', name: 'redline', tools: REVIEW_TOOLS, source: 'review.mjs' },
  { file: 'fix-tools.json', name: 'redline-fix', tools: FIX_TOOLS, source: 'fix.mjs' },
];

const check = process.argv.includes('--check');
let stale = 0;
for (const s of SURFACES) {
  const path = fileURLToPath(new URL(`./${s.file}`, import.meta.url));
  const tools = s.tools.slice().sort((a, b) => a.name.localeCompare(b.name));
  const rendered = JSON.stringify({ name: s.name, tools }, null, 2) + '\n';
  if (!check) {
    writeFileSync(path, rendered);
    console.log(`wrote scripts/redline/${s.file} (${tools.length} tools)`);
    continue;
  }
  let committed = '';
  try { committed = readFileSync(path, 'utf8').replace(/\r\n/g, '\n'); } catch { /* missing counts as stale */ }
  if (committed === rendered) {
    console.log(`scripts/redline/${s.file} matches TOOLS in ${s.source} (${tools.length} tools)`);
    continue;
  }
  stale++;
  console.error(`scripts/redline/${s.file} is stale: TOOLS in ${s.source} changed.`);
  console.error('Regenerate with `node scripts/redline/dump-tools.mjs`, review the diff, and re-pin with '
    + `\`truecopy add scripts/redline/${s.file}\`.`);
}
if (stale) process.exit(1);
