import JSZip from "jszip";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";

const zip = new JSZip();
const xml = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/></w:sectPr></w:body></w:document>`;
const p = (text) => `<w:p><w:r><w:rPr><w:rFonts w:ascii="Arial"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`;
const split = `<w:p><w:r><w:rPr><w:rFonts w:ascii="Arial"/></w:rPr><w:t>سلام %%na</w:t></w:r><w:r><w:rPr><w:rFonts w:ascii="Arial"/></w:rPr><w:t>me%%</w:t></w:r></w:p>`;
zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`);
zip.file("_rels/.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
zip.file("word/_rels/document.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`);
zip.file("word/document.xml", xml(`${split}<w:tbl><w:tr><w:tc><w:p><w:r><w:t>%customer.phone%</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`));
zip.file("word/header1.xml", `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>%%header%%</w:t></w:r></w:p></w:hdr>`);
zip.file("word/footer1.xml", `<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>%%footer%%</w:t></w:r></w:p></w:ftr>`);
const input = await zip.generateAsync({ type: "nodebuffer" });
const normalized = await JSZip.loadAsync(input);
for (const name of Object.keys(normalized.files)) if (/^word\/(document|header\d*|footer\d*)\.xml$/.test(name)) normalized.file(name, (await normalized.file(name).async("string")).replaceAll("%%", "%"));
const templater = new Docxtemplater(new PizZip(await normalized.generateAsync({ type: "nodebuffer" })), { delimiters: { start: "%", end: "%" }, paragraphLoop: true, linebreaks: true });
templater.render({ name: "رضایی", "customer.phone": "۰۹۱۲", header: "سربرگ", footer: "پابرگ" });
const output = templater.getZip().generate({ type: "nodebuffer" });
const rendered = await JSZip.loadAsync(output);
const generatedDirectories = Object.keys(rendered.files).filter((name) => rendered.files[name].dir);
if (!generatedDirectories.length || generatedDirectories.some((name) => !name.endsWith("/"))) {
  throw new Error("Expected safe DOCX directory entries in rendered output");
}
for (const name of ["word/document.xml", "word/header1.xml", "word/footer1.xml"]) {
  const text = await rendered.file(name).async("string");
  if (/%%?[A-Za-z][A-Za-z0-9_.-]*%%?/.test(text)) throw new Error(`Unresolved placeholder in ${name}`);
}
const document = await rendered.file("word/document.xml").async("string");
if (!document.includes("رضایی") || !document.includes("۰۹۱۲")) throw new Error("Fixture values were not rendered");
console.log("PASS contracts DOCX single/double-percent split-run/table/header/footer fixture");