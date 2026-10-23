import assert from "node:assert/strict";
import { matchSocialContact, normalizeContact } from "../src/lib/social-contact-match.ts";

const people = [
  { id: 42, name: "علی کریمی", first_name: "علی", last_name: "کریمی" },
  { id: 142, name: "علی کریمی", first_name: "علی", last_name: "کریمی" },
  { id: 7, name: "سارا احمدی", first_name: "سارا", last_name: "احمدی" },
  { id: 8, name: "حسین محمدی", first_name: "حسین", last_name: "محمدی" },
];
for (const title of ["علی کریمی 42", "علي كريمي - ۴۲", "آقای علی کریمی (٤٢)", "علی کریمی | CRM: 42", "علی کریمی شناسه مشتری: ۴۲"]) {
  assert.equal(matchSocialContact(title, people).target?.id, 42, title);
}
assert.equal(matchSocialContact("سارا احمدی", people).target?.id, 7);
assert.equal(matchSocialContact("۷", people).target?.id, 7);
assert.equal(matchSocialContact("CRM: ٧", people).target?.id, 7);
assert.equal(matchSocialContact("علی کریمی", people).target, null, "Namesakes require a choice");
assert.equal(matchSocialContact("سارا احمدی - 42", people).target, null, "Conflicting name/ID requires a choice");
assert.equal(matchSocialContact("سارا احمدی - 999", people).target, null, "Unknown ID must not be ignored");
assert.equal(matchSocialContact("علی - 42", people).target, null, "Partial name is not proof");
assert.equal(matchSocialContact("ناشناس 42", people).target, null);
assert.equal(matchSocialContact("علی کریمی 42 142", people).target, null, "Multiple matching IDs are ambiguous");
assert.equal(matchSocialContact("سارا احمدی 09123456789", people).target, null);
assert.equal(matchSocialContact("ناشناس", people).candidates.length, 0);
assert.deepEqual(matchSocialContact("سارا احمدی - 42", people).candidates.map(p => p.id).sort((a,b) => a-b), [7,42]);
assert.equal(normalizeContact("۴۲"), "42");
assert.equal(normalizeContact("٤٢"), "42");
console.log("Social contact matching: Persian/Arabic/Latin IDs, duplicate names, conflicts and manual candidates passed");
