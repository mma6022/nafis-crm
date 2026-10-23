import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Native TS stripping cannot resolve the API's extensionless bundler imports.
// Bundle the synthetic fixture without changing production import conventions.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.resolve(root, process.argv[2]);
const temp = await mkdtemp(path.join(tmpdir(), "crm-ts-fixture-"));
try {
  const out = path.join(temp, "fixture.mjs");
  await build({
    entryPoints: [entry], outfile: out, bundle: true, format: "esm", platform: "node",
    logLevel: "silent",
    banner: { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(pathToFileURL(path.join(root, "package.json")).href)});` },
  });
  const result = spawnSync(process.execPath, [out], { stdio: "inherit", timeout: 60000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(temp, { recursive: true, force: true });
}
