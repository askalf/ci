// One entry of a zip archive, read in place: what the post (post.mjs) and the review (review.mjs)
// need to open a run's redline-verdict artifact, and nothing more. No dependency, no temp file.
import { inflateRawSync } from 'node:zlib';

/** The largest artifact either reader opens; a verdict.json is a few hundred bytes. */
export const MAX_ARTIFACT_BYTES = 1_000_000;

/**
 * One entry of a zip archive, by name, from the central directory. Stored and deflated entries
 * only, no zip64, at most `maxBytes` uncompressed. Null when the entry is absent or unreadable. Pure.
 */
export function zipEntry(zip, name, maxBytes = MAX_ARTIFACT_BYTES) {
  try {
    const min = Math.max(0, zip.length - 22 - 0xffff);
    let eocd = -1;
    for (let i = zip.length - 22; i >= min; i--) {
      if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const entries = zip.readUInt16LE(eocd + 10);
    let p = zip.readUInt32LE(eocd + 16);
    for (let e = 0; e < entries; e++) {
      if (zip.readUInt32LE(p) !== 0x02014b50) return null;
      const method = zip.readUInt16LE(p + 10);
      const csize = zip.readUInt32LE(p + 20);
      const usize = zip.readUInt32LE(p + 24);
      const nlen = zip.readUInt16LE(p + 28);
      const xlen = zip.readUInt16LE(p + 30);
      const clen = zip.readUInt16LE(p + 32);
      const local = zip.readUInt32LE(p + 42);
      const entryName = zip.subarray(p + 46, p + 46 + nlen).toString('utf8');
      p += 46 + nlen + xlen + clen;
      if (entryName !== name) continue;
      if (csize === 0xffffffff || usize === 0xffffffff || usize > maxBytes) return null;
      if (zip.readUInt32LE(local) !== 0x04034b50) return null;
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + csize);
      if (data.length !== csize) return null;
      const out = method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data, { maxOutputLength: maxBytes }) : null;
      return out && out.length === usize ? out : null;
    }
    return null;
  } catch {
    return null;
  }
}
