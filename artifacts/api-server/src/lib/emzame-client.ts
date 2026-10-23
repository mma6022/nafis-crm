let cachedToken: { value: string; expires: number } | undefined;

function providerBase(): string {
  return (process.env.EMZAME_BASE_URL || "https://core.emzame.com/api/v1/backoffice").replace(/\/+$/, "");
}

async function timedFetch(url: string, init: RequestInit, timeoutMs = 20_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function emzameAuth(base = providerBase(), force = false): Promise<string> {
  if (!force && cachedToken && cachedToken.expires > Date.now() + 30_000) return cachedToken.value;
  const nationalCode = process.env.EMZAME_NATIONAL_CODE;
  const password = process.env.EMZAME_PASSWORD;
  if (!nationalCode || !password) throw new Error("provider_configuration");
  const response = await timedFetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nationalCode, password }),
  });
  const body = await response.json().catch(() => ({})) as any;
  const token = body.accessToken ?? body.data?.accessToken ?? body.token;
  if (!response.ok || typeof token !== "string") throw new Error("provider_auth_failed");
  cachedToken = { value: token, expires: Date.now() + 10 * 60_000 };
  return token;
}

export async function emzameRequest(
  resource: string,
  init: RequestInit = {},
  timeoutMs = 20_000,
): Promise<Response> {
  const base = providerBase();
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await emzameAuth(base, attempt > 0);
    const response = await timedFetch(`${base}/${resource.replace(/^\/+/, "")}`, {
      ...init,
      headers: {
        accept: "application/json",
        ...init.headers,
        authorization: `Bearer ${token}`,
      },
    }, timeoutMs);
    if (response.status !== 401 || attempt > 0) return response;
    cachedToken = undefined;
    await response.body?.cancel();
  }
  throw new Error("provider_auth_failed");
}