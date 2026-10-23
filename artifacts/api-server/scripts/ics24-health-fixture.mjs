import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";

// Synthetic transport only: no real provider, credentials, customer or charge.
const dir = await mkdtemp(path.join(os.tmpdir(), "ics24-health-"));
try {
  const entry = path.join(dir, "ics24.mjs");
  await build({ entryPoints: ["src/lib/ics24.ts"], outfile: entry, bundle: true, platform: "node", format: "esm" });
  process.env.ICS24_BRIDGE_URL = "https://credit.synthetic.invalid";
  process.env.ICS24_BRIDGE_KEY_ID = "synthetic-key";
  process.env.ICS24_BRIDGE_SHARED_SECRET = "synthetic-secret";
  let mode = "healthy", paidCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/healthz")) {
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
      if (mode === "timeout") throw new DOMException("synthetic timeout", "TimeoutError");
      if (mode === "html") return new Response("<html>gateway error</html>");
      if (mode === "wrong-service") return Response.json({ status: "ok", service: "other-service" });
      return Response.json({ status: mode === "healthy" ? "ok" : "failed", service: "ics24-bridge" },
        { status: mode === "healthy" ? 200 : 503 });
    }
    assert.equal(String(url), "https://credit.synthetic.invalid/v1/credit-checks/initiate");
    assert.equal(init.method, "POST");
    assert.ok(init.headers["X-Bridge-Signature"]);
    paidCalls++;
    return Response.json({ data: "synthetic-reference" });
  };
  const { initiate } = await import(pathToFileURL(entry));
  assert.equal(await initiate("0000000000", "09120000000"), "synthetic-reference");
  assert.equal(paidCalls, 1);
  for (mode of ["timeout", "html", "wrong-service", "down"]) {
    await assert.rejects(initiate("0000000000", "09120000000"), /استعلام جدید به سرویس ارسال نشد/);
    assert.equal(paidCalls, 1, "unhealthy bridge must never initiate a paid inquiry");
  }
  mode = "healthy";
  assert.equal(await initiate("0000000000", "09120000000"), "synthetic-reference");
  assert.equal(paidCalls, 2, "restored bridge resumes without a stale failure cache or automatic retry");
  console.log("PASS: bridge health gate rejects timeout/HTML/wrong-service/unavailable responses, sends no paid inquiry while down, preserves signed requests and resumes on recovery.");
} finally { await rm(dir, { recursive: true, force: true }); }
