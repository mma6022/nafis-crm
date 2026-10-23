import { isIP } from "node:net";

// SIP realm/server authority, not a URL or a WebSocket endpoint.
// Accept company LAN hosts and IP addresses as well as public DNS names.
export function validSipServerAddress(value: string): boolean {
  if (value.length > 260) return false;
  const match = /^(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(value);
  if (!match) return false;
  const [, host, port] = match;
  if (port && (Number(port) < 1 || Number(port) > 65535)) return false;
  if (host.startsWith("[")) return isIP(host.slice(1, -1)) === 6;
  if (/^[\d.]+$/.test(host)) return isIP(host) === 4;
  return host.length <= 253 && host.split(".").every(label =>
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}