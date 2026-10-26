/**
 * «اسکن بله و اتصال مشتری»: READ the expert's Bale contact list (sidecar /v1/contacts, read-only), match each contact to a CRM
 * customer and — only after the expert confirms — store a link in customer_bale_links. Customer rows are never modified.
 * Matching order: (a) a number in the contact name = customer id (name re-checked), (b) contact phone = customer mobile,
 * (c) normalized name. Every scan — the expert's own or an admin's scan of that expert's account — matches only that expert's own customers (customers.salesperson_id = theirs, not merged).
 * Contact names / phones live only in memory (scan cache, 30 min) and in the HTTP response; audit rows carry counts and ids only.
 */
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type BaleScanContact = { baleUserId: string; name: string; localName: string | null; phone: string | null };
export type MatchCustomer = { id: number; name: string; phone: string | null };
export type MatchMethod = "id" | "phone" | "name";
export type Candidate = { customerId: number; method: MatchMethod };
export type MatchRow = { contact: BaleScanContact; label: string; candidates: Candidate[]; note: null | "name_mismatch" | "conflict" | "duplicate" | "many" };
export type MatchResult = { confident: MatchRow[]; review: MatchRow[]; notFound: MatchRow[] };

const FA = "۰۱۲۳۴۵۶۷۸۹", AR = "٠١٢٣٤٥٦٧٨٩";
export const toAscii = (s: string) => s.replace(/[۰-۹]/g, d => String(FA.indexOf(d))).replace(/[٠-٩]/g, d => String(AR.indexOf(d)));
/** 09xxxxxxxxx from 09.. / 9.. / +98 / 0098 / 98 (Persian/Arabic digits ok). */
export function normMobile(raw: unknown): string | null {
  let s = toAscii(String(raw ?? "")).replace(/[\s\-()]/g, "");
  if (s.startsWith("+98")) s = "0" + s.slice(3); else if (s.startsWith("0098")) s = "0" + s.slice(4); else if (/^98\d{10}$/.test(s)) s = "0" + s.slice(2);
  else if (/^9\d{9}$/.test(s)) s = "0" + s;
  return /^09\d{9}$/.test(s) ? s : null;
}
const PREFIXES = ["مشتری", "مشتري", "آقای", "آقاي", "اقای", "آقا", "خانم", "سرکار", "جناب", "دکتر", "مهندس", "حاج", "حاجی", "mr", "mrs", "ms"];
/** Arabic ي/ى/ك/ة → Persian, ZWNJ/tatweel/diacritics out, digits + punctuation out, honorific prefixes out, lower-case, single spaces. */
export function normName(raw: unknown): string {
  let s = toAscii(String(raw ?? "")).replace(/[يى]/g, "ی").replace(/ك/g, "ک").replace(/ة/g, "ه").replace(/[أإٱ]/g, "ا").replace(/ؤ/g, "و")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "").replace(/[\u200c\u200d\u200e\u200f]/g, " ").toLowerCase()
    .replace(/[0-9]/g, " ").replace(/[^\p{L}\s]/gu, " ").replace(/\s+/g, " ").trim();
  let changed = true;
  while (changed && s) {
    changed = false;
    for (const p of PREFIXES) if (s === p || s.startsWith(p + " ")) { s = s.slice(p.length).trim(); changed = true; }
  }
  return s;
}
const compact = (s: string) => s.replace(/\s/g, "");
const numbersIn = (s: string) => (toAscii(s).match(/\d+/g) ?? []);

/** Pure matcher (also used by the read-only live count script). */
export function matchContacts(contacts: BaleScanContact[], customers: MatchCustomer[]): MatchResult {
  const byId = new Map(customers.map(c => [c.id, c]));
  const byPhone = new Map<string, number[]>(); const byName = new Map<string, number[]>();
  for (const c of customers) {
    const p = normMobile(c.phone); if (p) byPhone.set(p, [...(byPhone.get(p) ?? []), c.id]);
    const n = compact(normName(c.name)); if (n.length >= 3) byName.set(n, [...(byName.get(n) ?? []), c.id]);
  }
  const rows: MatchRow[] = contacts.map(contact => {
    const label = (contact.localName || contact.name || "").trim();
    const cands = new Map<number, MatchMethod>();
    const add = (id: number, m: MatchMethod) => { if (!cands.has(id)) cands.set(id, m); };
    let note: MatchRow["note"] = null;
    const nm = normName(label);
    // (a) customer id inside the contact name; long digit runs are treated as a phone instead.
    for (const d of numbersIn(label)) {
      if (d.length >= 10) { const p = normMobile(d); if (p) for (const id of byPhone.get(p) ?? []) add(id, "phone"); continue; }
      const id = Number(d); const c = byId.get(id);
      if (!c) continue;
      const cn = normName(c.name);
      const ok = !nm || compact(cn).includes(compact(nm)) || compact(nm).includes(compact(cn)) || nm.split(" ").some(t => t.length >= 3 && cn.split(" ").includes(t));
      if (ok) add(id, "id"); else { cands.set(id, "name"); note = "name_mismatch"; }
    }
    // (b) phone saved on the contact.
    const p = normMobile(contact.phone);
    if (p) for (const id of byPhone.get(p) ?? []) add(id, "phone");
    // (c) normalized name (only when nothing stronger matched).
    if (![...cands.values()].some(m => m !== "name") && nm) for (const id of byName.get(compact(nm)) ?? []) add(id, "name");
    const candidates = [...cands.entries()].map(([customerId, method]) => ({ customerId, method }))
      .sort((x, y) => "idphonename".indexOf(x.method) - "idphonename".indexOf(y.method) || x.customerId - y.customerId);
    const strong = candidates.filter(c => c.method !== "name");
    if (strong.length > 1) note = "conflict"; else if (!strong.length && candidates.length > 1) note = note ?? "many";
    return { contact, label, candidates, note };
  });
  // A customer may be confidently claimed by one contact only.
  const strongOwner = new Map<number, number>();
  rows.forEach(r => { const s = r.candidates.filter(c => c.method !== "name"); if (s.length === 1 && !r.note) strongOwner.set(s[0].customerId, (strongOwner.get(s[0].customerId) ?? 0) + 1); });
  const out: MatchResult = { confident: [], review: [], notFound: [] };
  for (const r of rows) {
    const s = r.candidates.filter(c => c.method !== "name");
    if (!r.candidates.length) out.notFound.push(r);
    else if (s.length === 1 && !r.note && (strongOwner.get(s[0].customerId) ?? 0) === 1) { r.candidates = s; out.confident.push(r); }
    else { if (s.length === 1 && !r.note) r.note = "duplicate"; out.review.push(r); }
  }
  return out;
}

export function ensureCustomerBaleLinks(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS customer_bale_links(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bale_user_id TEXT NOT NULL,
    customer_id INTEGER NOT NULL,
    expert_user_id INTEGER NOT NULL,
    account_id INTEGER,
    match_method TEXT NOT NULL CHECK(match_method IN ('id','phone','name','manual')),
    linked_at TEXT NOT NULL,
    linked_by INTEGER NOT NULL,
    unlinked_at TEXT,
    unlinked_by INTEGER,
    unlink_reason TEXT)`);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_cbl_customer_active ON customer_bale_links(expert_user_id, customer_id) WHERE unlinked_at IS NULL");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_cbl_peer_active ON customer_bale_links(expert_user_id, bale_user_id) WHERE unlinked_at IS NULL");
  db.exec("CREATE INDEX IF NOT EXISTS ix_cbl_customer ON customer_bale_links(customer_id)");
}

/** Short one-way tag for logs/reports when a contact must be referred to (never the phone itself). */
export const peerTag = (baleUserId: string) => crypto.createHash("sha256").update(`bale-peer:${baleUserId}`).digest("hex").slice(0, 10);
export const maskPhone = (p: string | null) => (p ? `${p.slice(0, 4)}•••${p.slice(-2)}` : null);
