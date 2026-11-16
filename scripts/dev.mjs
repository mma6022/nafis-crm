import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Keep the optional development egress tunnel in the same managed workflow as
// the API. Production runs dist/index.mjs directly and never starts this helper.
const artifact = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const children = new Set();
let stopping = false;
function start(command, args) {
  const child = spawn(command, args, { cwd: artifact, stdio: "inherit", detached: true });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
  }
  setTimeout(() => process.exit(code), 300).unref();
}
process.on("SIGTERM", () => stop(0));
process.on("SIGINT", () => stop(0));
process.env.NODE_ENV = "development";
if (process.env.SIMOTEL_TUNNEL_API_PORT && process.env.SIMOTEL_TUNNEL_AUDIO_PORT) {
  function tunnel() {
    if (stopping) return;
    const child = start("python3", [path.resolve(artifact, "../../.local/deploy/simotel-dev-tunnel.py")]);
    child.on("error", () => { console.error("Development Simotel tunnel unavailable."); });
    child.once("exit", () => { if (!stopping) setTimeout(tunnel, 5000).unref(); });
  }
  tunnel();
}
const build = start("pnpm", ["run", "build"]);
build.on("error", () => stop(1));
build.once("exit", code => {
  if (stopping) return;
  if (code !== 0) return stop(code ?? 1);
  const api = start("pnpm", ["run", "start"]);
  api.on("error", () => stop(1));
  api.once("exit", code => stop(code ?? 1));
});