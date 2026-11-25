// social-hub v1.1 UI markers: everything renders nothing while the flags are OFF; no dock change; bale-workspace files untouched.
import { readFileSync, readdirSync } from "node:fs";
const r = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
let n = 0; const ok = (c, m) => { if (!c) { console.error(`FAIL ${m}`); process.exit(1); } n++; console.log(`ok - ${m}`); };
const shell = r("components/CrmShell.tsx");
ok(/href: '\/social-hub'[^\n]*sh: true/.test(shell) && /if \(item\.sh\) return Boolean\(shMeNav\?\.enabled && shMeNav\.manager\)/.test(shell), "nav item only for managers while flag.social_hub_v1 is ON");
const page = r("features/social-hub/SocialHubPage.tsx");
ok(/!me\.data\?\.enabled \|\| !me\.data\.manager/.test(page), "page and access route closed for non-managers / flag OFF");
ok(/if \(!me\?\.phoneAttach \|\| !phone\) return null;/.test(r("features/social-hub/AttachPhone.tsx")), "attach button renders nothing while flag.social_hub_phone_attach_v1 is OFF");
ok(/if \(!me\?\.enabled \|\| !q\.data\) return null;/.test(r("features/social-hub/TodayBox.tsx")), "today box renders nothing while flag.social_hub_v1 is OFF");
ok(/<AttachPhoneButton phone=\{c\.phone\} callEventId=\{c\.id\}/.test(r("features/voip-call/S132bLayer.tsx")), "incoming unknown card carries the second button");
const all = readdirSync(new URL("../src/features/social-hub/", import.meta.url)).map((f) => r(`features/social-hub/${f}`)).join("\n");
ok(!all.includes("الان مشتری جدید دارم"), "dock item «الان مشتری جدید دارم» not reintroduced");
ok(!/token/i.test(r("features/social-hub/Bots.tsx").replace(/کلید/g, "")), "add-bot wizard never asks for a bot token");
ok(!/className="(?!sh)[a-z]/.test(all.replace(/className="(btn btn-ghost|rb|rl|hd|t|l|side-link)"/g, "")), "only sh-* classes (and sh-scoped child names) inside the feature, plus the incoming card's own btn and the shell drawer's side-link (ShellTools)");

const docs = r("features/social-hub/Docs.tsx");
ok(/sh-filechip/.test(docs) && /<FileLabel name=\{file\.name\} \/>، \{fileSize\(file\.size\)\}/.test(docs), "file chip keeps the comma in the same span as the label (no flex gap before ،)");
const ui = r("features/social-hub/ui.tsx");
ok(/extraPhoneLabel/.test(ui) && ui.includes("شمارهٔ دیگر") && !/شمارهٔ اضافه \$\{fa\(i \+ 1\)\}/.test(ui), "NumList uses the card labels (custom or شمارهٔ دیگر), not شمارهٔ اضافه ۱");
const css = r("features/social-hub/social-hub.css");
ok(/max-content max-content/.test(css) && /\.sh-tr\.leg \.sh-row\.sh-wrap\{flex-wrap:nowrap/.test(css), "legacy row at 1280 keeps action buttons on one row");

const attach = r("features/social-hub/AttachPhone.tsx");
ok(/PickExtrasChip/.test(attach) && attach.includes("بدون شمارهٔ دیگر") && !/شمارهٔ اضافه`/.test(attach) && !/بدون شمارهٔ اضافه/.test(attach), "a_pick chip uses today-card labels (همسر / شمارهٔ دیگر), not شمارهٔ اضافه");
ok(/dir="auto"/.test(r("features/social-hub/Bots.tsx")) && r("features/social-hub/Bots.tsx").includes("هنوز نشانی ندارد") && !r("features/social-hub/Bots.tsx").includes("هموز"), "bot card empty handle is هنوز (dir=auto so Persian is not LTR-garbled)");

console.log(`social-hub UI fixture ${n}/${n}`);
