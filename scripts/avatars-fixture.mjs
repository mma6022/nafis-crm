import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "avatars-"));
const sourceDb = path.resolve(process.cwd(), "..", "..", "attached_assets/customers_1789823100050.db");
const copy = path.join(dir, "t.db");
const { DatabaseSync } = await import("node:sqlite");
const src = new DatabaseSync(sourceDb); src.exec(`VACUUM INTO '${copy}'`); src.close();
process.env.CRM_DATABASE_PATH = copy;
process.env.SESSION_SECRET = "fixture-secret-fixture-secret-123456";
const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const out = path.join(process.cwd(), `.avatars-fixture-${process.pid}.mjs`);
await build({
  stdin: { contents: `export * from './src/lib/avatars'; export * from './src/lib/crm-db'; export {createSession} from './src/lib/auth'; export {hashPassword} from './src/lib/auth';`, resolveDir: process.cwd(), loader: "ts" },
  bundle: true, platform: "node", format: "esm", outfile: out, external: ["express", "node:*", "pino", "pino-http", "pino-pretty"], logLevel: "error",
  banner: { js: "import {createRequire as __cr} from 'node:module'; const require = __cr(import.meta.url); import {fileURLToPath as __f} from 'node:url'; const __filename=__f(import.meta.url); const __dirname=__filename.slice(0,__filename.lastIndexOf('/'));" },
});
const m = await import(out);
const { default: express } = await import(require.resolve("express"));
const { default: cookieParser } = await import(require.resolve("cookie-parser"));
const { createAvatarRouter, execute, createSession } = m;
const now = new Date().toISOString();
const mk = (u, role) => Number(execute("INSERT INTO users(username,password_hash,full_name,role,active,created_at) VALUES(?,?,?,?,1,?)", [u, "x", u, role, now]));
const adminId = mk("fx-adm"+process.pid, "admin"), staffId = mk("fx-stf"+process.pid, "salesperson"), other = mk("fx-oth"+process.pid, "salesperson");
const app = express(); app.use(cookieParser()); app.use(express.json());
app.post("/login/:id", (req, res) => { createSession(Number(req.params.id), res); res.json({}); });
app.use("/api", createAvatarRouter());
const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}`;
async function session(id) { const r = await fetch(`${base}/login/${id}`, { method: "POST" }); return r.headers.get("set-cookie").split(";")[0]; }
const png = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.alloc(200, 1)]);
const img = "data:image/png;base64," + png.toString("base64");
const call = (cookie, method, p, body) => fetch(base + p, { method, headers: { cookie, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const adm = await session(adminId), stf = await session(staffId);
assert.equal((await fetch(base + "/api/avatars")).status, 401);
assert.equal((await call(stf, "PUT", "/api/profile/avatar", { image: img })).status, 200);
assert.equal((await call(stf, "PUT", "/api/profile/avatar", { image: "data:image/png;base64,AAAA" })).status, 400);
assert.equal((await call(stf, "PUT", "/api/profile/avatar", { image: "data:image/png;base64," + Buffer.alloc(70000, 1).toString("base64") })).status, 400);
const v = await (await call(adm, "GET", "/api/avatars")).json();
assert.ok(v.versions[String(staffId)]);
const got = await call(adm, "GET", `/api/avatars/${staffId}`);
assert.equal(got.status, 200); assert.equal(got.headers.get("content-type"), "image/png");
assert.equal((await call(adm, "GET", `/api/avatars/${other}`)).status, 404);
assert.equal((await call(stf, "PUT", `/api/users/${other}/avatar`, { image: img })).status, 403);
assert.equal((await call(adm, "PUT", `/api/users/${other}/avatar`, { image: img })).status, 200);
assert.equal((await call(adm, "PUT", `/api/users/9999/avatar`, { image: img })).status, 404);
assert.equal((await call(stf, "DELETE", `/api/users/${other}/avatar`)).status, 403);
assert.equal((await call(adm, "DELETE", `/api/users/${other}/avatar`)).status, 204);
assert.equal((await call(stf, "DELETE", "/api/profile/avatar")).status, 204);
assert.equal((await call(adm, "GET", `/api/avatars/${staffId}`)).status, 404);
console.log("avatars fixture ok");
server.close(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(out, { force: true }); process.exit(0);
