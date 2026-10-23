// Browsers may label .jfif as JPEG, image/jfif, or application/octet-stream.
// Normalize only after verifying JPEG bytes, so previews use a safe MIME type.
export function supportedDocumentUpload(file: { originalname: string; mimetype: string; buffer: Buffer }): boolean {
  if (/\.jfif$/i.test(file.originalname)) {
    if (file.buffer.length < 3 || file.buffer[0] !== 0xff || file.buffer[1] !== 0xd8 || file.buffer[2] !== 0xff) return false;
    file.mimetype = "image/jpeg";
    return true;
  }
  return ["application/pdf", "image/jpeg", "image/png"].includes(file.mimetype) &&
    /\.(pdf|jpe?g|png)$/i.test(file.originalname);
}