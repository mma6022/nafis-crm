import { spawn } from "node:child_process";
import { mkdir, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

type Phase = "idle" | "awaiting_authorization" | "authorized" | "failed";

/** Runs the official OAuth client only; no model call, shell or staff-supplied command. */
export class CodexLoginController {
  private phase: Phase = "idle";
  private url: string | null = null;
  private inFlight: Promise<string> | null = null;
  private startedAt = 0;

  status() { return this.phase; }

  start(origin: string): Promise<string> {
    if (this.inFlight) return this.inFlight;
    if (this.phase === "awaiting_authorization" && this.url)
      return Promise.resolve(this.url);
    if (Date.now() - this.startedAt < 15_000) return Promise.reject(new Error("oauth_start_rate_limited"));
    this.startedAt = Date.now();
    const operation = this.launch(origin);
    this.inFlight = operation;
    void operation.finally(() => { this.inFlight = null; }).catch(() => {});
    return operation;
  }

  private async launch(origin: string): Promise<string> {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" || parsed.origin !== origin)
      throw new Error("invalid_oauth_origin");
    const home = path.join(homedir(), ".config/nafis-repair-codex");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
    const executable = path.resolve(process.cwd(), "../../scripts/node_modules/@openai/codex/bin/codex.js");
    const callback = `${origin}/api/diagnostics-worker/codex/callback`;
    const env: Record<string, string> = { CODEX_HOME: home, BROWSER: "true" };
    for (const name of ["HOME", "PATH", "LANG", "SHELL", "SSL_CERT_FILE", "NIX_SSL_CERT_FILE", "SSL_CERT_DIR"]) {
      if (process.env[name]) env[name] = process.env[name]!;
    }
    this.phase = "awaiting_authorization";
    this.url = null;
    return new Promise<string>((resolve, reject) => {
      let ready = false, buffer = "";
      const child = spawn(process.execPath, [executable,
        "-c", "mcp_oauth_callback_port=7436",
        "-c", `mcp_oauth_callback_url=${JSON.stringify(callback)}`,
        "mcp", "login", "replit",
      ], { cwd: "/tmp", env, stdio: ["ignore", "pipe", "pipe"] });
      const fail = () => {
        clearTimeout(deadline);
        this.phase = "failed"; this.url = null;
        if (!ready) reject(new Error("codex_oauth_start_failed"));
      };
      const deadline = setTimeout(() => { if (!ready) { child.kill("SIGTERM"); fail(); } }, 30_000);
      const consume = (chunk: Buffer) => {
        // OAuth client output stays in bounded private memory, never app logs.
        buffer = (buffer + chunk.toString("utf8")).slice(-16_384);
        const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("https://replit.com/oidc/auth?")) continue;
          try {
            const authorization = new URL(line.trim());
            const redirect = authorization.searchParams.get("redirect_uri") ?? "";
            if (!redirect.startsWith(`${callback}/`) || !authorization.searchParams.get("state") ||
                authorization.searchParams.get("code_challenge_method") !== "S256") continue;
            clearTimeout(deadline); ready = true; this.url = authorization.href;
            resolve(authorization.href);
          } catch { /* Ignore malformed client output without reflecting it. */ }
        }
      };
      child.stdout.on("data", consume); child.stderr.on("data", consume);
      child.once("error", fail);
      child.once("close", code => {
        clearTimeout(deadline);
        this.phase = code === 0 ? "authorized" : "failed"; this.url = null;
        if (!ready) reject(new Error("codex_oauth_start_failed"));
      });
    });
  }
}
