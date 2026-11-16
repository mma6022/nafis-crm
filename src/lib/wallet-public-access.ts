/** Public payment capabilities only; private customer-wallet APIs stay authenticated. */
export function isPublicWalletRequest(method: string, path: string): boolean {
  return /^\/wallet\/share-links\/[^/]+(?:\/start)?\/?$/.test(path)
    || (method === "GET" && /^\/wallet\/share-links\/receipt\/[^/]+\/?$/.test(path))
    || (method === "GET" && path === "/wallet/zarinpal/callback");
}
