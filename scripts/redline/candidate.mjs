// The build lane's verify job fetches the build job's candidate with this: the
// redline-build-candidate artifact the build job uploaded, by the id its upload step gave (a job
// output, which a verify job re-run alone still reads), unpacked into a directory for build.mjs
// (BUILD_CANDIDATE). It holds the job's read token and reads one artifact and its zip; build.mjs,
// which runs the checkout's commands, holds no token.
//
// CLI: GH_READ_TOKEN, REPO, RUN_ID, CANDIDATE_ID (empty when the build job uploaded none) and
// CANDIDATE_OUT in the environment. Exit 0 with the files written, or 0 with none when there is
// no candidate (build.mjs then says so in its record); 2 when the artifact could not be read.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zipEntry } from './zip.mjs';

/** The build job's artifact name, and the files build.mjs reads from it. */
export const CANDIDATE_ARTIFACT = 'redline-build-candidate';
export const CANDIDATE_FILES = ['build.json', 'notes.md', 'description.md', 'diff.patch', 'build.bundle', 'replay.json'];
/** The most a candidate's zip and each file in it may hold: a build's diff is capped at 400,000 bytes. */
export const MAX_CANDIDATE_BYTES = 16_000_000;

/**
 * The build job's candidate, artifact `artifactId`, unpacked into `dir`: { files } (the names
 * written), { none: true } when the build job gave no id, or throws, also when the artifact is not
 * a redline-build-candidate of this run or has expired. `fetch` is the global one; the zip is read
 * through GitHub's redirect to storage, which is fetched without the token.
 */
export async function fetchCandidate({ repo, runId, artifactId, token, dir, fetch = globalThis.fetch }) {
  if (!artifactId) return { none: true };
  if (!/^\d+$/.test(String(artifactId))) throw new Error(`the candidate id is not an artifact id: ${String(artifactId).slice(0, 40)}`);
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  const meta = await fetch(`https://api.github.com/repos/${repo}/actions/artifacts/${artifactId}`, { headers, signal: AbortSignal.timeout(30_000) });
  if (meta.status !== 200) throw new Error(`artifact ${artifactId} could not be read (HTTP ${meta.status})`);
  const art = await meta.json();
  if (art?.name !== CANDIDATE_ARTIFACT || Number(art?.workflow_run?.id) !== Number(runId)) throw new Error(`artifact ${artifactId} is not this run's ${CANDIDATE_ARTIFACT}`);
  if (art.expired === true) throw new Error(`artifact ${artifactId} has expired`);
  if (Number(art.size_in_bytes ?? 0) > MAX_CANDIDATE_BYTES) throw new Error(`the candidate is ${art.size_in_bytes} bytes, over the ${MAX_CANDIDATE_BYTES} byte cap`);
  const first = await fetch(`https://api.github.com/repos/${repo}/actions/artifacts/${art.id}/zip`, { headers, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
  const location = first.headers?.get?.('location');
  const res = first.status >= 300 && first.status < 400 && location ? await fetch(location, { signal: AbortSignal.timeout(60_000) }) : first;
  if (res.status !== 200) throw new Error(`the candidate could not be downloaded (HTTP ${res.status})`);
  const zip = Buffer.from(await res.arrayBuffer());
  if (zip.length > MAX_CANDIDATE_BYTES) throw new Error(`the candidate is ${zip.length} bytes, over the ${MAX_CANDIDATE_BYTES} byte cap`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (const name of CANDIDATE_FILES) {
    const entry = zipEntry(zip, name, MAX_CANDIDATE_BYTES);
    if (entry === null) continue;
    writeFileSync(join(dir, name), entry);
    files.push(name);
  }
  return { files };
}

async function main() {
  const { GH_READ_TOKEN: token, REPO: repo, RUN_ID: runId, CANDIDATE_ID: artifactId = '', CANDIDATE_OUT: dir } = process.env;
  for (const [k, v] of Object.entries({ GH_READ_TOKEN: token, REPO: repo, RUN_ID: runId, CANDIDATE_OUT: dir })) {
    if (!v) { console.error(`::error::${k} is not set`); process.exit(2); }
  }
  let got;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { got = await fetchCandidate({ repo, runId, artifactId, token, dir }); break; } catch (e) {
      console.log(`attempt ${attempt}: ${e.message}`);
      if (attempt === 3) { console.error(`::error::the build job's candidate could not be read: ${e.message}`); process.exit(2); }
      await new Promise((r) => setTimeout(r, attempt * 5000));
    }
  }
  if ('none' in got) console.log(`the build job gave no ${CANDIDATE_ARTIFACT}`);
  else console.log(`fetched ${got.files.join(', ')} from ${CANDIDATE_ARTIFACT}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
