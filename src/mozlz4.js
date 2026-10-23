// Read/write Mozilla's mozLz4 files (magic + uint32 LE size + raw LZ4 block).
// Pure-JS LZ4 block codec so the tool has no native dependencies.

import { readFileSync, writeFileSync } from "node:fs";

const MAGIC = Buffer.from("mozLz40\0", "binary");

const MIN_MATCH = 4;
const MF_LIMIT = 12; // last match must start at least 12 bytes before the end
const LAST_LITERALS = 5; // last 5 bytes are always literals
const HASH_LOG = 16;
const MAX_OFFSET = 65535;

export function decompressBlock(src, size) {
  const dst = Buffer.alloc(size);
  let s = 0;
  let d = 0;

  while (s < src.length) {
    const token = src[s++];

    let litLen = token >>> 4;
    if (litLen === 15) {
      let b;
      do {
        b = src[s++];
        litLen += b;
      } while (b === 255);
    }
    if (s + litLen > src.length || d + litLen > size) {
      throw new Error("Corrupt LZ4 block (literal overrun)");
    }
    src.copy(dst, d, s, s + litLen);
    s += litLen;
    d += litLen;

    if (s >= src.length) break; // last sequence has no match

    const offset = src[s] | (src[s + 1] << 8);
    s += 2;
    if (offset === 0 || offset > d) {
      throw new Error("Corrupt LZ4 block (bad offset)");
    }

    let matchLen = token & 15;
    if (matchLen === 15) {
      let b;
      do {
        b = src[s++];
        matchLen += b;
      } while (b === 255);
    }
    matchLen += MIN_MATCH;
    if (d + matchLen > size) {
      throw new Error("Corrupt LZ4 block (match overrun)");
    }

    // Byte-by-byte copy: matches may overlap their own output.
    let m = d - offset;
    for (let i = 0; i < matchLen; i++) dst[d++] = dst[m++];
  }

  if (d !== size) {
    throw new Error(`Corrupt LZ4 block (expected ${size} bytes, got ${d})`);
  }
  return dst;
}

function writeLength(out, op, len) {
  while (len >= 255) {
    out[op++] = 255;
    len -= 255;
  }
  out[op++] = len;
  return op;
}

export function compressBlock(src) {
  const n = src.length;
  const out = Buffer.alloc(n + Math.ceil(n / 255) + 16);
  let op = 0;
  let anchor = 0;

  const emit = (litEnd, offset, matchLen) => {
    const litLen = litEnd - anchor;
    const tokenPos = op++;
    let token = Math.min(litLen, 15) << 4;
    if (litLen >= 15) op = writeLength(out, op, litLen - 15);
    src.copy(out, op, anchor, litEnd);
    op += litLen;

    if (offset) {
      out[op++] = offset & 0xff;
      out[op++] = offset >>> 8;
      const ml = matchLen - MIN_MATCH;
      token |= Math.min(ml, 15);
      if (ml >= 15) op = writeLength(out, op, ml - 15);
    }
    out[tokenPos] = token;
  };

  if (n > MF_LIMIT) {
    const table = new Int32Array(1 << HASH_LOG).fill(-1);
    const matchLimit = n - LAST_LITERALS;
    const lastMatchStart = n - MF_LIMIT;
    let ip = 0;

    while (ip < lastMatchStart) {
      const seq = src.readUInt32LE(ip);
      const h = Math.imul(seq, 2654435761) >>> (32 - HASH_LOG);
      const ref = table[h];
      table[h] = ip;

      if (ref < 0 || ip - ref > MAX_OFFSET || src.readUInt32LE(ref) !== seq) {
        ip++;
        continue;
      }

      // Extend the match backwards into pending literals, then forwards.
      let start = ip;
      let refStart = ref;
      while (start > anchor && refStart > 0 && src[start - 1] === src[refStart - 1]) {
        start--;
        refStart--;
      }
      let end = ip + MIN_MATCH;
      let refEnd = ref + MIN_MATCH;
      while (end < matchLimit && src[end] === src[refEnd]) {
        end++;
        refEnd++;
      }

      emit(start, ip - ref, end - start);
      anchor = end;
      ip = end;
    }
  }

  emit(n, 0, 0);
  return out.subarray(0, op);
}

export function readMozLz4(path) {
  const data = readFileSync(path);
  if (data.length < 12 || !data.subarray(0, 8).equals(MAGIC)) {
    throw new Error(`Invalid mozlz4 format: ${path}`);
  }
  const size = data.readUInt32LE(8);
  return decompressBlock(data.subarray(12), size);
}

export function readMozLz4Json(path) {
  return JSON.parse(readMozLz4(path).toString("utf8"));
}

export function writeMozLz4Json(path, value) {
  const raw = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(12);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(raw.length, 8);
  writeFileSync(path, Buffer.concat([header, compressBlock(raw)]));
}
