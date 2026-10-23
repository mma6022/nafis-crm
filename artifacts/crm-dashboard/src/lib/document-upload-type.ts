export const documentFileAccept = ".pdf,.png,.jpg,.jpeg,.jfif,application/pdf,image/png,image/jpeg";

export function supportedDocumentFile(file: Pick<File, "name" | "type">): boolean {
  return /\.jfif$/i.test(file.name) || ["application/pdf", "image/jpeg", "image/png"].includes(file.type);
}