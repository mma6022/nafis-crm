/** Loopback SSH forward to the isolated VPS connection service; no credential handling. */
export class VpsRepairConnection {
  constructor(private readonly request: typeof fetch = fetch) {}

  async status(): Promise<string> {
    try {
      const response = await this.request("http://127.0.0.1:7437/status", {
        redirect: "error", signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) return "unavailable";
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || !("phase" in result) || !("connected" in result))
        return "unavailable";
      return result.connected === true && result.phase === "authorized" ? "authorized" :
        ["idle", "awaiting_authorization", "authorization_received", "verification_failed", "failed"].includes(String(result.phase))
          ? String(result.phase) : "unavailable";
    } catch { return "unavailable"; }
  }

  async start(origin: string): Promise<string> {
    const response = await this.request("http://127.0.0.1:7437/login", {
      method: "POST", redirect: "error", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ origin }), signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) throw new Error("repair_connection_unavailable");
    const result: unknown = await response.json();
    if (!result || typeof result !== "object" || !("authorization" in result) ||
        typeof result.authorization !== "string") throw new Error("repair_connection_unavailable");
    const url = new URL(result.authorization);
    if (url.origin !== "https://replit.com" || url.pathname !== "/oidc/auth")
      throw new Error("invalid_authorization_origin");
    return url.href;
  }
}
