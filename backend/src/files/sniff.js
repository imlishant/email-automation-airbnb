// ---------------------------------------------------------------------------
// What is actually in this upload?
//
// The client's Content-Type and the filename are both hints from an untrusted
// source. The bytes are not. Everything here reads the bytes.
// ---------------------------------------------------------------------------

const TYPES = [
  { type: "image/jpeg", ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: "image/png", ext: "png", test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { type: "image/webp", ext: "webp", test: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  { type: "application/pdf", ext: "pdf", test: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
];

/** @returns {{type,ext}|null} — null means "not something we accept". */
export function sniff(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  return TYPES.find((t) => t.test(buffer)) || null;
}

/**
 * Remove JPEG metadata segments.
 *
 * A phone photo of a passport carries GPS in its EXIF: where the document was
 * photographed, which is usually someone's home. The browser re-encodes before
 * upload, which strips this — but a guest can POST raw bytes past the browser,
 * so the server strips it too rather than trusting that.
 *
 * APP1 holds EXIF and XMP; APP2 holds ICC and sometimes more EXIF. Dropping
 * them leaves a valid JPEG.
 */
export function stripJpegMetadata(buffer) {
  if (!(buffer[0] === 0xff && buffer[1] === 0xd8)) return buffer;
  const out = [buffer.subarray(0, 2)];
  let i = 2;
  while (i < buffer.length - 1) {
    if (buffer[i] !== 0xff) break;                      // not a marker: stop, keep the rest
    const marker = buffer[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    if (marker === 0xda) { out.push(buffer.subarray(i)); return Buffer.concat(out); }  // image data, to the end
    const length = buffer.readUInt16BE(i + 2);
    if (length < 2 || i + 2 + length > buffer.length) break;                            // malformed
    const isMetadata = marker === 0xe1 || marker === 0xe2 || marker === 0xed || marker === 0xfe;
    if (!isMetadata) out.push(buffer.subarray(i, i + 2 + length));
    i += 2 + length;
  }
  out.push(buffer.subarray(i));
  return Buffer.concat(out);
}

export function hasExif(buffer) {
  for (let i = 2; i < Math.min(buffer.length - 4, 65536); i++) {
    if (buffer[i] === 0xff && buffer[i + 1] === 0xe1) return true;
  }
  return false;
}
