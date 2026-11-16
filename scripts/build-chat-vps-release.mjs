import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [baselinePath, outputPath] = process.argv.slice(2);
if (!baselinePath || !outputPath) throw new Error("Usage: build-chat-vps-release.mjs verified-baseline.mjs output.mjs");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = value => createHash("sha256").update(value).digest("hex");
const original = await readFile(baselinePath, "utf8");
// Verified external CRM baseline. Abort rather than patch a different release.
const expectedHash = "df7d505a08eb9f38dfd81ef143f9545ae84e97f00125e24bdf5715aa5f6c6171";
assert.equal(hash(original), expectedHash, "Production baseline changed");
const bindings = {
  express: ["Router"],
  "../lib/crm-db": ["crmDb", "execute", "executeChanges", "queryRow", "queryRows", "runImmediateTransaction"],
  "../lib/customer-portal-auth": ["customerPortalSession", "requireCustomerPortal"],
  "../lib/access-control": ["requirePermission"],
};
const result = await build({
  entryPoints: [path.join(root, "src/routes/customer-chat.ts")],
  bundle: true, platform: "node", format: "iife", globalName: "ApprovedChatFeature",
  write: false, logLevel: "silent",
  plugins: [{
    name: "verified-live-bindings",
    setup(context) {
      context.onResolve({ filter: /.*/ }, args => {
        const key = Object.keys(bindings).find(candidate =>
          candidate === args.path || (candidate.startsWith("../lib/") &&
            args.path.endsWith(`/${candidate.split("/").at(-1)}`)));
        return key || args.path === "multer" ? { path: key ?? args.path, namespace: "live" } : undefined;
      });
      context.onLoad({ filter: /.*/, namespace: "live" }, args => ({
        contents: args.path === "multer" ? "export default chatDeps.multer;" :
          bindings[args.path].map(name => `export const ${name}=chatDeps.${name};`).join("\n"),
        loader: "js",
      }));
    },
  }],
});
const feature = result.outputFiles[0].text;
assert.ok(!feature.includes("customer_portal_inquiry_claims") && !feature.includes("allocation_programs"),
  "Chat release must not include portal intake/allocation changes");
const customerMarker = "var requireApiAuth = (req, res, next) => {";
const staffMarker = 'app.use("/api", requireApiAuth, routes_default);';
assert.equal(original.split(customerMarker).length, 2);
assert.equal(original.split(staffMarker).length, 2);
const insertion = `// BEGIN approved private VPS customer chat
import {createRequire as chatReleaseRequire} from "node:module";
const ChatRelease=(()=>{
  const require=chatReleaseRequire(import.meta.url);
  const chatDeps={Router:require_express().Router,multer:require_multer(),crmDb,execute,executeChanges,queryRow,queryRows,runImmediateTransaction,customerPortalSession,requireCustomerPortal,requirePermission};
${feature}
  return ApprovedChatFeature;
})();
app.use("/api/customer-portal",ChatRelease.customerChatRouter);
// END approved private VPS customer chat
`;
const staffMount = 'app.use("/api/chat",requireApiAuth,ChatRelease.staffChatRouter);\n';
const staged = original.replace(customerMarker, () => insertion + customerMarker)
  .replace(staffMarker, () => staffMount + staffMarker);
assert.equal(hash(staged.replace(insertion, "").replace(staffMount, "")), hash(original),
  "Every byte outside the approved chat insertion must remain identical");
await writeFile(outputPath, staged);
await writeFile(`${outputPath}.chat-feature.cjs`, feature);
await writeFile(`${outputPath}.scope.json`, JSON.stringify({
  baselineHash: hash(original), stagedHash: hash(staged),
  scope: "Chat routes, private storage and additive chat-only schema; all baseline bytes unchanged",
}, null, 2));
console.log("Bounded chat release built; baseline byte preservation verified.");
