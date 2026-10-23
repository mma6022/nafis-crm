import assert from "node:assert/strict";
import express from "express";
import multer from "multer";
import { supportedDocumentUpload } from "../src/lib/document-upload-type.ts";
import { documentFileAccept, supportedDocumentFile } from "../../crm-dashboard/src/lib/document-upload-type.ts";

// Synthetic JPEG signature only; no customer records, files, or providers.
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
for (const mimetype of ["image/jpeg", "image/jfif", "image/pjpeg", "application/octet-stream", ""]) {
  const file = { originalname: "synthetic.JFIF", mimetype, buffer: jpeg };
  assert.ok(supportedDocumentUpload(file));
  assert.equal(file.mimetype, "image/jpeg");
  assert.ok(supportedDocumentFile({ name: file.originalname, type: mimetype }));
}
assert.ok(documentFileAccept.includes(".jfif"));
assert.equal(supportedDocumentUpload({ originalname: "fake.jfif", mimetype: "image/jpeg", buffer: Buffer.from("<script>bad</script>") }), false);
assert.equal(supportedDocumentUpload({ originalname: "fake.jfif", mimetype: "image/jpeg", buffer: Buffer.from([0xff, 0xd8]) }), false);
assert.equal(supportedDocumentUpload({ originalname: "fake.exe", mimetype: "image/jpeg", buffer: jpeg }), false);
for (const [name, type] of [["old.jpg", "image/jpeg"], ["old.jpeg", "image/jpeg"], ["old.png", "image/png"], ["old.pdf", "application/pdf"]]) {
  assert.ok(supportedDocumentUpload({ originalname: name, mimetype: type, buffer: jpeg }));
  assert.ok(supportedDocumentFile({ name, type }));
}
assert.equal(supportedDocumentFile({ name: "script.html", type: "text/html" }), false);
const app = express();
app.post("/upload", multer({ storage: multer.memoryStorage() }).single("file"), (req, res) => {
  if (!req.file || !supportedDocumentUpload(req.file)) return res.status(400).json({ error: "invalid" });
  return res.json({ mime: req.file.mimetype, name: req.file.originalname });
});
const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
try {
  for (const mime of ["image/jpeg", "image/jfif", "application/octet-stream"]) {
    const body = new FormData();
    body.append("file", new Blob([jpeg], { type: mime }), "synthetic.jfif");
    const response = await fetch(`http://127.0.0.1:${server.address().port}/upload`, { method: "POST", body });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).mime, "image/jpeg");
  }
  const invalid = new FormData();
  invalid.append("file", new Blob(["not a JPEG"], { type: "image/jpeg" }), "fake.jfif");
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/upload`, { method: "POST", body: invalid })).status, 400);
  console.log("Passed JFIF client selection, multipart MIME normalization, uppercase extension, invalid-content rejection and existing PDF/PNG/JPEG support.");
} finally {
  await new Promise(resolve => server.close(resolve));
}