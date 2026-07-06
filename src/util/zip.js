// Minimal ZIP writer — STORE method (no compression). PDFs are already compressed, so storing them
// keeps the archive tiny without pulling in a compression dependency; the whole thing runs in the
// browser, offline, with no external library. Enough to package several small PDFs into one .zip
// (used by Split → "extract all pages"). Not a general-purpose zipper (no unicode-path flag games,
// no zip64) — just correct, minimal local-header + central-directory + EOCD output.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const utf8 = (s) => new TextEncoder().encode(s);

/**
 * Build a ZIP (STORE) from `files` = [{ name:string, bytes:Uint8Array }]. Returns a Uint8Array.
 * DOS date/time are left at 0 (deterministic output; the timestamp is irrelevant for our use).
 */
export function makeZip(files) {
  const entries = (files || []).map((f) => {
    const name = utf8(f.name);
    const data = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes);
    return { name, data, crc: crc32(data), offset: 0 };
  });

  // Local headers + data
  const localParts = [];
  let offset = 0;
  for (const e of entries) {
    e.offset = offset;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);           // local file header signature
    h.setUint16(4, 20, true);                    // version needed
    h.setUint16(6, 0, true);                     // flags
    h.setUint16(8, 0, true);                     // method 0 = store
    h.setUint16(10, 0, true);                    // mod time
    h.setUint16(12, 0, true);                    // mod date
    h.setUint32(14, e.crc, true);                // crc32
    h.setUint32(18, e.data.length, true);        // compressed size (== uncompressed for store)
    h.setUint32(22, e.data.length, true);        // uncompressed size
    h.setUint16(26, e.name.length, true);        // name length
    h.setUint16(28, 0, true);                    // extra length
    const head = new Uint8Array(h.buffer);
    localParts.push(head, e.name, e.data);
    offset += head.length + e.name.length + e.data.length;
  }

  // Central directory
  const centralParts = [];
  let centralSize = 0;
  for (const e of entries) {
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);            // central dir header signature
    c.setUint16(4, 20, true);                    // version made by
    c.setUint16(6, 20, true);                    // version needed
    c.setUint16(8, 0, true); c.setUint16(10, 0, true); // flags, method
    c.setUint16(12, 0, true); c.setUint16(14, 0, true); // mod time/date
    c.setUint32(16, e.crc, true);
    c.setUint32(20, e.data.length, true);
    c.setUint32(24, e.data.length, true);
    c.setUint16(28, e.name.length, true);
    c.setUint16(30, 0, true); c.setUint16(32, 0, true); // extra, comment lengths
    c.setUint16(34, 0, true); c.setUint16(36, 0, true); // disk #, internal attrs
    c.setUint32(38, 0, true);                    // external attrs
    c.setUint32(42, e.offset, true);             // offset of local header
    const head = new Uint8Array(c.buffer);
    centralParts.push(head, e.name);
    centralSize += head.length + e.name.length;
  }

  // End of central directory
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);       // entries on this disk
  eocd.setUint16(10, entries.length, true);      // total entries
  eocd.setUint32(12, centralSize, true);         // central dir size
  eocd.setUint32(16, offset, true);              // central dir offset (== total local size)

  const parts = [...localParts, ...centralParts, new Uint8Array(eocd.buffer)];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}
