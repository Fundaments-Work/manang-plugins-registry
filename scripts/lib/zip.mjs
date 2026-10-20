// A strict, dependency-free zip reader for `.manangplugin` archives.
//
// It reads the central directory first (names, sizes, attributes), refuses
// anything odd (encryption, zip64, multi-disk, symlinks, directories that carry
// data) and only then inflates, with an output cap per entry so a header that
// lies about its size cannot make us allocate more than the limit.

import { inflateRawSync } from "node:zlib";

export class ArchiveError extends Error {}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

/**
 * @param {Uint8Array} bytes
 * @param {{ maxEntries: number }} opts
 * @returns {{ name: string, isDir: boolean, method: number, compressed: number, size: number, offset: number }[]}
 */
export function listEntries(bytes, { maxEntries }) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 22) throw new ArchiveError("not a zip file (too short)");
  // The end-of-central-directory record is in the last 22 + 65535 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ArchiveError("not a zip file (no end-of-central-directory)");
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0) throw new ArchiveError("multi-disk zips are refused");
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ArchiveError("zip64 archives are refused");
  }
  if (total > maxEntries) {
    throw new ArchiveError(`the archive holds more than ${maxEntries} files`);
  }
  if (cdOffset + cdSize > eocd) throw new ArchiveError("corrupt central directory");

  const out = [];
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) {
      throw new ArchiveError("corrupt central directory entry");
    }
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38);
    const offset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length) throw new ArchiveError("corrupt entry name");
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 1) throw new ArchiveError(`\`${name}\` is encrypted`);
    if (compressed === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) {
      throw new ArchiveError("zip64 entries are refused");
    }
    if (method !== 0 && method !== 8) {
      throw new ArchiveError(`\`${name}\` uses unsupported compression ${method}`);
    }
    // Unix attributes live in the high 16 bits when the creator is Unix (3).
    if (madeBy >> 8 === 3) {
      const mode = (external >>> 16) & S_IFMT;
      if (mode === S_IFLNK) {
        throw new ArchiveError(`\`${name}\` is a symbolic link; links are not allowed`);
      }
      if (mode !== 0 && mode !== S_IFREG && mode !== S_IFDIR) {
        throw new ArchiveError(`\`${name}\` is not a regular file`);
      }
    }
    out.push({
      name,
      isDir: name.endsWith("/"),
      method,
      compressed,
      size,
      offset,
    });
  }
  return out;
}

/**
 * Inflate one entry, never producing more than `limit` bytes.
 * @param {Uint8Array} bytes
 * @param {{ name: string, method: number, compressed: number, size: number, offset: number }} entry
 * @param {number} limit
 */
export function readEntry(bytes, entry, limit) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const p = entry.offset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOC_SIG) {
    throw new ArchiveError(`corrupt local header for \`${entry.name}\``);
  }
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const end = start + entry.compressed;
  if (end > buf.length) throw new ArchiveError(`\`${entry.name}\` is truncated`);
  if (entry.size > limit) {
    throw new ArchiveError(
      `\`${entry.name}\` is larger than the limit of ${limit} bytes`,
    );
  }
  const raw = buf.subarray(start, end);
  let data;
  try {
    data =
      entry.method === 0
        ? raw
        : inflateRawSync(raw, { maxOutputLength: Math.max(1, limit + 1) });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new ArchiveError(`cannot inflate \`${entry.name}\`: ${message}`);
  }
  if (data.length > limit) {
    throw new ArchiveError(
      `\`${entry.name}\` is larger than the limit of ${limit} bytes`,
    );
  }
  if (data.length !== entry.size) {
    throw new ArchiveError(`\`${entry.name}\` does not match its declared size`);
  }
  return data;
}
