import JSZip from "jszip";

export type InvoiceBuyer = {
  name: string;
  national_code?: string | null;
  phone?: string | null;
  postal_code?: string | null;
  address?: string | null;
  official_address?: string | null;
  official_postal_code?: string | null;
};
type InvoiceSource = {
  id: number;
  creditAmountToman: string;
  invoiceVersion?: number;
  invoiceNumber: string;
  items: Array<{ title: string; quantity: number; unitPriceToman: string }>;
};
const latinDigits = (value: unknown) => String(value ?? "")
  .replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
  .replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
const escapeXml = (value: unknown) => latinDigits(value).replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
const formatNumber = (value: number | bigint) => value.toLocaleString("en-US");
const borders = ["top", "left", "bottom", "right", "insideH", "insideV"]
  .map(side => `<w:${side} w:val="single" w:sz="5" w:color="333333"/>`).join("");
function paragraph(text: string, bold = false, align = "right", size = 20) {
  const runs = latinDigits(text).split(/([0-9]+(?:[.,/:\-٬٫،][0-9]+)*)/g).map((part, index) => {
    if (!part) return "";
    const numeric = index % 2 === 1;
    const font = numeric ? "Noto Sans" : "Noto Naskh Arabic";
    return `<w:r><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:cs="${font}"/>${numeric ? '<w:rtl w:val="0"/>' : "<w:rtl/>"}${bold ? "<w:b/><w:bCs/>" : ""}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr><w:t xml:space="preserve">${numeric ? "\u200e" : ""}${escapeXml(part)}${numeric ? "\u200e" : ""}</w:t></w:r>`;
  }).join("");
  return `<w:p><w:pPr><w:bidi/><w:jc w:val="${align === "right" ? "start" : align}"/><w:spacing w:before="35" w:after="35"/></w:pPr>${runs}</w:p>`;
}
function metadataParagraph(label: string, value: string) {
  return `<w:p><w:pPr><w:bidi/><w:jc w:val="start"/><w:spacing w:before="65" w:after="65"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Noto Naskh Arabic" w:hAnsi="Noto Naskh Arabic" w:cs="Noto Naskh Arabic"/><w:rtl/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr><w:t xml:space="preserve">${escapeXml(label)}: </w:t></w:r><w:r><w:rPr><w:rFonts w:ascii="Noto Sans" w:hAnsi="Noto Sans" w:cs="Noto Sans"/><w:rtl w:val="0"/><w:b/><w:bCs/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr><w:t xml:space="preserve">\u200e${escapeXml(value)}\u200e</w:t></w:r></w:p>`;
}
function cell(text: string, width: number, options: { bold?: boolean; shade?: boolean; span?: number; align?: string; content?: string } = {}) {
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${options.span ? `<w:gridSpan w:val="${options.span}"/>` : ""}${options.shade ? '<w:shd w:fill="EEEEEE"/>' : ""}<w:vAlign w:val="center"/></w:tcPr>${options.content ?? text.split("\n").map(line => paragraph(line, options.bold, options.align ?? "right")).join("")}</w:tc>`;
}
function row(cells: string[], header = false) {
  return `<w:tr><w:trPr><w:cantSplit/>${header ? "<w:tblHeader/>" : ""}</w:trPr>${cells.join("")}</w:tr>`;
}
function table(widths: number[], rows: string[]) {
  return `<w:tbl><w:tblPr><w:bidiVisual/><w:tblW w:w="${widths.reduce((sum, width) => sum + width, 0)}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${borders}</w:tblBorders><w:tblCellMar><w:top w:w="65" w:type="dxa"/><w:left w:w="70" w:type="dxa"/><w:bottom w:w="65" w:type="dxa"/><w:right w:w="70" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map(width => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>${rows.join("")}</w:tbl>`;
}

export async function createInvoiceDocx(source: InvoiceSource, buyer: InvoiceBuyer | string, financingCompanyName: string, issuedAt = new Date()): Promise<Buffer> {
  if (!source.items.length || source.items.length > 200) throw new Error("invoice_items_required");
  if (!/^\d{4}(?:0[1-9]|1[0-2])(?:00[1-9]|0[1-9]\d|[1-9]\d{2})$/.test(source.invoiceNumber)) throw new Error("invoice_number_invalid");
  const companyName = financingCompanyName.trim();
  if (!companyName) throw new Error("invoice_financing_company_required");
  const customer = typeof buyer === "string" ? { name: buyer } : buyer;
  const value = (text?: string | null) => text?.trim() || "—";
  const widths = [650, 4700, 600, 1800, 1800, 1000, 1800, 1250, 2000];
  let total = 0n;
  const itemRows = source.items.map((item, index) => {
    if (!item.title.trim() || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || !/^\d+$/.test(item.unitPriceToman)) throw new Error("invoice_item_invalid");
    const amount = BigInt(item.unitPriceToman) * BigInt(item.quantity);
    total += amount;
    return row([formatNumber(index + 1), item.title, formatNumber(item.quantity), formatNumber(BigInt(item.unitPriceToman)), formatNumber(amount),
      "0", formatNumber(amount), "—", formatNumber(amount)].map((text, i) => cell(text, widths[i], { align: i === 1 ? "right" : "center" })));
  });
  if (total !== BigInt(source.creditAmountToman)) throw new Error("invoice_total_mismatch");
  const headers = ["ردیف", "شرح کالا", "تعداد", "مبلغ واحد", "مبلغ کل", "تخفیف اقلام",
    "مبلغ پس از تخفیف", "مالیات و عوارض", "جمع کل"];
  const header = row(headers.map((text, i) => cell(text, widths[i], { bold: true, shade: true, align: "center" })), true);
  const dateParts = new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-latn", {
    timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(issuedAt);
  const date = ["year", "month", "day"].map(type => dateParts.find(part => part.type === type)!.value.padStart(type === "year" ? 4 : 2, "0")).join("/");
  const meta = table([12000, 3600], [row([
    cell(`طرح اعتبار خرید کالا: ${companyName}\nواحد تمام مبالغ: تومان`, 12000),
    cell("", 3600, { content: [
      metadataParagraph("شماره فاکتور", source.invoiceNumber),
      metadataParagraph("تاریخ صدور", date),
      metadataParagraph("نسخه", String(source.invoiceVersion ?? 1)),
    ].join("") }),
  ])]);
  const buyerTable = table([900, 14700], [
    row([cell("خریدار", 900, { bold: true, shade: true, align: "center" }),
      cell(`نام و نام خانوادگی: ${value(customer.name)}     کد ملی: ${value(customer.national_code)}\nشماره همراه: ${value(customer.phone)}     کد پستی: ${value(customer.postal_code || customer.official_postal_code)}\nنشانی: ${value(customer.address || customer.official_address)}`, 14700)]),
  ]);
  const sumRow = row([
    cell("جمع کل فاکتور", 13600, { span: 8, bold: true, shade: true }),
    cell(formatNumber(total), 2000, { bold: true, shade: true, align: "center" }),
  ]);
  const footer = table([11400, 4200], [
    row([cell(`مبلغ کل فاکتور از طریق کیف پول شرکت (${companyName}) پرداخت گردیده است و تمامی کالاهای فوق در این تاریخ به صورت صحیح و سالم توسط آقای محمدحسین مهرپور ابربکوه تحویل اینجانب گردید و هیچ گونه ادعایی در مورد کالاها و مبلغ خرید ندارم.\nمالیات و عوارض جداگانه‌ای در این فاکتور ثبت نشده است.`, 11400),
      cell("مهر و امضای خریدار\n\n\n", 4200, { align: "center" })]),
  ]);
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraph("صورتحساب فروش الکترونیکی", true, "center", 36)}${meta}${paragraph("", false, "right", 8)}${buyerTable}${paragraph("", false, "right", 8)}${table(widths, [header, ...itemRows, sumRow])}${paragraph("", false, "right", 8)}${footer}${paragraph("این سند برای امضای الکترونیکی خریدار صادر شده است.", false, "center", 18)}<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="600" w:right="600" w:bottom="600" w:left="600" w:header="200" w:footer="200"/></w:sectPr></w:body></w:document>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", document);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}