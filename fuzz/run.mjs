// `node fuzz/run.mjs` runs every Jazzer.js target in ./fuzz. This is the fuzzer CI runs
// (.github/workflows/fuzz.yml) and the local repro loop. The targets import the scripts directly, so
// no build is needed, and a script's command line never runs on import (each guards its main).
// Environment:
//   FUZZ_SECONDS       per-target budget in seconds (default 30)
//   FUZZ_JOBS          how many targets fuzz at once (default 1, one after another); each still
//                      gets its whole FUZZ_SECONDS. CI on GitHub-hosted runners sets it to the
//                      runner's CPU count; on the self-hosted runner it stays unset, so one at a time
//   FUZZ_ONLY          run only the target with this name (default: all)
//   FUZZ_CORPUS_DIR    root of per-target corpus dirs, created on demand; libFuzzer reads its
//                      seeds from <dir>/<target> and saves every interesting input there, so a
//                      corpus that persists between runs keeps getting deeper. Unset: a
//                      temporary directory, so a local run never writes into the repository.
//   FUZZ_ARTIFACT_DIR  where a crashing input is written, created on demand. Unset: the cwd.
// Hand-written starting inputs live in fuzz/seeds/<target>/ and are read, never written.
// Jazzer comes from .clusterfuzzlite/package.json (`npm ci --prefix .clusterfuzzlite`): this
// repository has no package.json of its own and its scripts take no dependencies.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const only = process.env.FUZZ_ONLY || '';
const targets = readdirSync(dir).filter((f) => f.endsWith('.fuzz.js') && (!only || f === `${only}.fuzz.js`)).sort();
if (!targets.length) {
  console.error(`no fuzz target matches ${only || '*.fuzz.js'}`);
  process.exit(1);
}
const secs = process.env.FUZZ_SECONDS || '30';
const corpusRoot = process.env.FUZZ_CORPUS_DIR || mkdtempSync(path.join(tmpdir(), 'ci-fuzz-corpus-'));
const artifactDir = process.env.FUZZ_ARTIFACT_DIR || '';
// Run Jazzer's JS CLI directly under `node`: no .cmd wrapper, no shell, so a space in the repo
// path cannot break the invocation.
const jazzerCli = createRequire(new URL('../.clusterfuzzlite/package.json', import.meta.url)).resolve('@jazzer.js/core/dist/cli.js');
// The scripts start with a shebang, which Jazzer.js's ES module instrumentation breaks; the hook
// comments it out as each module loads (see shebang-hooks.mjs).
const shebangHook = new URL('./shebang-register.mjs', import.meta.url).href;
if (artifactDir) mkdirSync(artifactDir, { recursive: true });

const jobs = Math.min(targets.length, Math.max(1, Number.parseInt(process.env.FUZZ_JOBS ?? '', 10) || 1));

// Fuzzes one target and resolves with how it ended. With one job its output streams as it comes;
// with more, each target's output is held and printed as one block when it ends, so the logs of
// targets running side by side never interleave.
function fuzz(t) {
  const name = t.replace(/\.fuzz\.js$/, '');
  // Every target is a plain synchronous function, so Jazzer runs in its faster sync mode.
  const args = [jazzerCli, `fuzz/${name}.fuzz`, '--sync'];
  // libFuzzer saves new inputs into the FIRST directory it is given, so the corpus comes first
  // and the read-only seeds after it.
  const corpus = path.join(corpusRoot, name);
  mkdirSync(corpus, { recursive: true });
  args.push(corpus);
  const seeds = path.join(dir, 'seeds', name);
  if (existsSync(seeds)) args.push(seeds);
  // -timeout turns a hang (a super-linear regex on hostile input) into a failing input in seconds
  // rather than libFuzzer's 20 minute default.
  args.push('--', `-max_total_time=${secs}`, '-timeout=10', '-print_final_stats=1');
  if (artifactDir) args.push(`-artifact_prefix=${artifactDir}${path.sep}`);
  const header = `\n=== fuzzing ${name} (${secs}s) ===`;
  return new Promise((resolve) => {
    if (jobs === 1) console.log(header);
    const child = spawn(process.execPath, ['--import', shebangHook, ...args], { stdio: jobs === 1 ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    const out = [];
    child.stdout?.on('data', (d) => out.push(d));
    child.stderr?.on('data', (d) => out.push(d));
    child.on('error', (err) => resolve({ name, status: null, signal: null, err }));
    child.on('close', (status, signal) => {
      if (jobs > 1) process.stdout.write(`${header}\n${Buffer.concat(out)}`);
      resolve({ name, status, signal });
    });
  });
}

// After a failure no further target starts; the ones already running finish their budget. With
// one job that is the first failing target, as before.
const failures = [];
let next = 0;
await Promise.all(Array.from({ length: jobs }, async () => {
  while (!failures.length && next < targets.length) {
    const r = await fuzz(targets[next++]);
    if (r.status !== 0) failures.push(r);
  }
}));
for (const r of failures) {
  console.error(`\n${r.name}: jazzer exited with ${r.err?.message ?? r.status ?? r.signal}; a reproducing input is in ${artifactDir || 'the working directory'}`);
}
// exitCode rather than exit(): a target's held output can still be draining into a pipe, and exit()
// would cut it off, crash report included.
if (failures.length) process.exitCode = failures[0].status || 1;
