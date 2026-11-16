const respond = (payload) => new Response(JSON.stringify(payload), {
  status: 200,
  headers: { "Content-Type": "application/json" },
});
let authorizationCode = "";
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init.method ?? "GET").toUpperCase();
  if (url.origin === "https://api.instagram.com" && url.pathname === "/oauth/access_token" && method === "POST") {
    const form = new URLSearchParams(String(init.body ?? ""));
    if (
      init.headers?.["Content-Type"] !== "application/x-www-form-urlencoded" ||
      form.get("grant_type") !== "authorization_code" ||
      ![
        "synthetic-oauth-code",
        "synthetic-subscription-failure",
        "synthetic-other-page",
        "synthetic-delayed-connect",
      ].includes(form.get("code"))
    ) throw new Error("Unexpected synthetic authorization-code exchange");
    authorizationCode = form.get("code");
    if (authorizationCode === "synthetic-delayed-connect") await delay(750);
    return respond({
      data: [{
        access_token: "synthetic-short-token",
        user_id: 111222333,
        permissions: ["instagram_business_basic", "instagram_business_manage_messages"],
      }],
    });
  }
  if (url.origin === "https://graph.instagram.com" && url.pathname === "/access_token" && method === "GET") {
    if (
      url.searchParams.get("grant_type") !== "ig_exchange_token" ||
      url.searchParams.get("access_token") !== "synthetic-short-token"
    ) throw new Error("Unexpected synthetic long-lived token exchange");
    return respond({ access_token: "synthetic-long-lived-token", expires_in: 5_184_000 });
  }
  if (url.origin === "https://graph.instagram.com" && url.pathname === "/me" && method === "GET") {
    if (init.headers?.Authorization !== "Bearer synthetic-long-lived-token" || url.searchParams.get("fields") !== "user_id,username") {
      throw new Error("Unexpected synthetic Instagram account lookup");
    }
    return authorizationCode === "synthetic-other-page"
      ? respond({ user_id: "999888777", username: "other_synthetic_business" })
      : respond({ user_id: "111222333", username: "synthetic_business" });
  }
  if (
    url.origin === "https://graph.instagram.com" &&
    /^\/v26\.0\/(?:111222333|999888777)\/subscribed_apps$/.test(url.pathname) &&
    method === "POST"
  ) {
    if (
      init.headers?.Authorization !== "Bearer synthetic-long-lived-token" ||
      url.searchParams.get("subscribed_fields") !== "messages"
    ) throw new Error("Unexpected synthetic webhook subscription");
    return respond({ success: authorizationCode !== "synthetic-subscription-failure" });
  }
  throw new Error(`Unexpected outbound request blocked in Instagram OAuth fixture: ${method} ${url.origin}${url.pathname}`);
};