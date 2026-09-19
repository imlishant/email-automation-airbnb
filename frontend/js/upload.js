// ---------------------------------------------------------------------------
// Preparing a file in the browser, before it is sent.
//
// Re-encoding a photo through a canvas does three useful things at once:
//
//   1. It strips ALL metadata, including the GPS coordinates a phone writes
//      into a photo of a passport — usually someone's home address. The server
//      strips EXIF too, but doing it here means it never leaves the device.
//   2. It shrinks a 12-megapixel photo to something a security desk can read,
//      which turns a 6MB upload into a few hundred KB. That matters on a phone
//      at a gate on mobile data.
//   3. It normalises orientation, so a sideways photo arrives upright.
//
// PDFs are passed through untouched — there is nothing safe to re-encode.
// ---------------------------------------------------------------------------

/** Long edge in pixels. Comfortably readable for an ID, far smaller than a raw photo. */
const MAX_EDGE = 2000;
const JPEG_QUALITY = 0.85;

export class FileRejected extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * @returns {Promise<Blob>} the bytes to upload.
 * @throws FileRejected with a message written for a guest, not a developer.
 */
export async function prepareForUpload(file, { maxBytes, accept }) {
  if (!file) throw new FileRejected("no_file", "No file chosen.");

  const allowed = accept.split(",").map((s) => s.trim());
  const isImage = file.type.startsWith("image/");
  if (!isImage && !allowed.includes(file.type)) {
    throw new FileRejected("unsupported", "Choose a photo or a PDF of the ID.");
  }

  // A PDF cannot be usefully re-encoded here, so it is only size-checked.
  if (!isImage) {
    if (file.size > maxBytes) throw new FileRejected("too_large", sizeMessage(maxBytes));
    return file;
  }

  let blob;
  try {
    blob = await reencode(file);
  } catch {
    // If the browser cannot decode it, fall back to sending the original and
    // let the server judge — better than refusing a valid photo.
    if (file.size > maxBytes) throw new FileRejected("too_large", sizeMessage(maxBytes));
    return file;
  }
  if (blob.size > maxBytes) throw new FileRejected("too_large", sizeMessage(maxBytes));
  return blob;
}

const sizeMessage = (maxBytes) =>
  `That file is larger than ${Math.round(maxBytes / 1048576)}MB. A photo from your phone camera is usually fine.`;

async function reencode(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  // White behind a transparent PNG, so an ID does not arrive on black.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
  if (!blob) throw new Error("canvas produced nothing");
  return blob;
}
