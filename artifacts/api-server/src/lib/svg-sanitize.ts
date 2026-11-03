/**
 * links v1.0: server-side SVG sanitizer for uploaded logos (spec §۵.۲). Allow-list re-serializer, not a filter:
 * the output is rebuilt token by token from a small set of drawing elements and presentation attributes, so anything
 * not explicitly allowed (script, style, foreignObject, image, a, animate/set, event handlers, external or javascript:
 * references, DOCTYPE/ENTITY, CDATA, processing instructions) never reaches the output. Throws SvgRejected when the
 * input is not a well-formed SVG we can rebuild.
 */
export class SvgRejected extends Error {}

const ELEMENTS = new Set([
  "svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "defs", "lineargradient", "radialgradient",
  "stop", "clippath", "mask", "title", "desc", "text", "tspan", "use", "symbol",
]);
/** Elements dropped together with everything inside them. */
const DROP_SUBTREE = new Set(["script", "style", "foreignobject", "image", "a", "iframe", "object", "embed", "animate", "animatemotion",
  "animatetransform", "set", "discard", "handler", "listener", "feimage", "metadata", "switch", "video", "audio", "canvas", "pattern", "filter"]);
const ATTRS = new Set([
  "viewbox", "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "fill", "fill-rule", "fill-opacity",
  "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity",
  "opacity", "transform", "id", "class", "offset", "stop-color", "stop-opacity", "gradientunits", "gradienttransform", "spreadmethod", "fx", "fy",
  "clip-path", "clip-rule", "clippathunits", "mask", "maskunits", "maskcontentunits", "preserveaspectratio", "version", "xmlns", "xmlns:xlink",
  "href", "xlink:href", "font-size", "font-weight", "font-family", "text-anchor", "dominant-baseline", "letter-spacing", "dx", "dy", "vector-effect",
]);
const CASE: Record<string, string> = { lineargradient: "linearGradient", radialgradient: "radialGradient", clippath: "clipPath", viewbox: "viewBox",
  gradientunits: "gradientUnits", gradienttransform: "gradientTransform", spreadmethod: "spreadMethod", clippathunits: "clipPathUnits",
  maskunits: "maskUnits", maskcontentunits: "maskContentUnits", preserveaspectratio: "preserveAspectRatio" };
const MAX_NODES = 4000;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const decodeEntities = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e: string) => {
  const l = e.toLowerCase();
  if (l === "amp") return "&"; if (l === "lt") return "<"; if (l === "gt") return ">"; if (l === "quot") return '"'; if (l === "apos") return "'";
  const n = l.startsWith("#x") ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
  return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
});
/** A value is safe when it cannot reach outside the document: only local `url(#id)` references, nothing script-like. */
function safeValue(name: string, raw: string): string | null {
  const v = decodeEntities(raw).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (v.length > 20000) return null;
  const flat = v.replace(/\s+/g, "").toLowerCase();
  if (/javascript:|vbscript:|data:|expression\(|@import|<|>/.test(flat)) return null;
  if (name === "href" || name === "xlink:href") return /^#[A-Za-z_][\w.-]{0,63}$/.test(v) ? v : null;
  if (name === "xmlns") return v === "http://www.w3.org/2000/svg" ? v : null;
  if (name === "xmlns:xlink") return v === "http://www.w3.org/1999/xlink" ? v : null;
  const urls = flat.match(/url\(([^)]*)\)/g) ?? [];
  for (const u of urls) if (!/^url\(['"]?#[a-z_][\w.-]*['"]?\)$/.test(u)) return null;
  if (/url\(/.test(flat) && urls.length === 0) return null;
  return v;
}

type Tok = { t: "open"; name: string; attrs: [string, string][]; self: boolean } | { t: "close"; name: string } | { t: "text"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = []; let i = 0; const n = src.length;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) { out.push({ t: "text", v: src.slice(i) }); break; }
    if (lt > i) out.push({ t: "text", v: src.slice(i, lt) });
    if (src.startsWith("<!--", lt)) { const e = src.indexOf("-->", lt + 4); if (e < 0) throw new SvgRejected("comment"); i = e + 3; continue; }
    if (src.startsWith("<?", lt)) {
      const e = src.indexOf("?>", lt + 2); if (e < 0) throw new SvgRejected("pi");
      if (!/^<\?xml[\s?]/i.test(src.slice(lt, lt + 6)) || out.some((x) => x.t !== "text" || x.v.trim())) throw new SvgRejected("pi");
      i = e + 2; continue;
    }
    if (src.startsWith("<!", lt)) throw new SvgRejected("doctype_or_cdata"); // DOCTYPE / ENTITY / CDATA: never needed for a logo
    if (src[lt + 1] === "/") {
      const m = /^<\/\s*([A-Za-z][\w:.-]*)\s*>/.exec(src.slice(lt, lt + 200)); if (!m) throw new SvgRejected("close");
      out.push({ t: "close", name: m[1].toLowerCase() }); i = lt + m[0].length; continue;
    }
    const nm = /^<([A-Za-z][\w:.-]*)/.exec(src.slice(lt, lt + 200)); if (!nm) throw new SvgRejected("tag");
    let j = lt + nm[0].length; const attrs: [string, string][] = []; let self = false;
    for (;;) {
      while (j < n && /\s/.test(src[j])) j++;
      if (j >= n) throw new SvgRejected("eof");
      if (src[j] === ">") { j++; break; }
      if (src[j] === "/" && src[j + 1] === ">") { self = true; j += 2; break; }
      const an = /^[A-Za-z_:][\w:.-]*/.exec(src.slice(j, j + 200)); if (!an) throw new SvgRejected("attr");
      j += an[0].length; while (j < n && /\s/.test(src[j])) j++;
      if (src[j] !== "=") throw new SvgRejected("attr_value"); // XML: every attribute has a quoted value
      j++; while (j < n && /\s/.test(src[j])) j++;
      const q = src[j]; if (q !== '"' && q !== "'") throw new SvgRejected("attr_quote");
      const e = src.indexOf(q, j + 1); if (e < 0) throw new SvgRejected("attr_eof");
      attrs.push([an[0].toLowerCase(), src.slice(j + 1, e)]); j = e + 1;
    }
    out.push({ t: "open", name: nm[1].toLowerCase(), attrs, self }); i = j;
    if (out.length > MAX_NODES) throw new SvgRejected("too_complex");
  }
  return out;
}

export function sanitizeSvg(input: string): string {
  const src = input.replace(/^\uFEFF/, "");
  const toks = tokenize(src);
  const stack: string[] = []; let drop = 0; let out = ""; let rootSeen = false, rootClosed = false;
  for (const tk of toks) {
    if (tk.t === "text") {
      if (drop) continue;
      if (!stack.length) { if (tk.v.trim()) throw new SvgRejected("text_outside"); continue; }
      const top = stack[stack.length - 1];
      if (["title", "desc", "text", "tspan"].includes(top)) out += esc(decodeEntities(tk.v));
      continue;
    }
    if (tk.t === "open") {
      if (rootClosed) throw new SvgRejected("after_root");
      if (!rootSeen) { if (tk.name !== "svg") throw new SvgRejected("root"); rootSeen = true; }
      if (drop || DROP_SUBTREE.has(tk.name) || !ELEMENTS.has(tk.name) || tk.name.includes(":")) { if (!tk.self) { stack.push(tk.name); drop++; } continue; }
      const kept: string[] = [];
      for (const [a, v] of tk.attrs) {
        if (a.startsWith("on") || !ATTRS.has(a)) continue;
        const sv = safeValue(a, v); if (sv === null) continue;
        kept.push(`${CASE[a] ?? a}="${esc(sv)}"`);
      }
      if (tk.name === "svg" && stack.length === 0 && !kept.some((k) => k.startsWith("xmlns="))) kept.unshift('xmlns="http://www.w3.org/2000/svg"');
      const tag = CASE[tk.name] ?? tk.name;
      out += `<${tag}${kept.length ? " " + kept.join(" ") : ""}${tk.self ? "/>" : ">"}`;
      if (!tk.self) stack.push(tk.name);
      else if (tk.name === "svg" && stack.length === 0) rootClosed = true;
      continue;
    }
    // close
    const top = stack.pop();
    if (top !== tk.name) throw new SvgRejected("mismatch");
    if (drop) { drop--; continue; }
    out += `</${CASE[tk.name] ?? tk.name}>`;
    if (!stack.length) rootClosed = true;
  }
  if (!rootSeen || stack.length) throw new SvgRejected("unclosed");
  return out;
}
