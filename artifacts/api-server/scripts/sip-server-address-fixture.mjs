import assert from "node:assert/strict";
import { validSipServerAddress } from "../src/lib/sip-server-address.ts";

for (const value of ["pbx.example.com", "pbx", "pbx.company.local", "192.168.1.10", "192.168.1.10:5060",
  "pbx.example.com:5061", "[2001:db8::1]", "[::1]:5060", "127.0.0.1", "PBX.company.local"]) {
  assert.equal(validSipServerAddress(value), true, `Expected valid SIP server: ${value}`);
}
for (const value of ["", "999.1.1.1", "192.168.1", "192.168.1.10:0", "pbx:65536", "pbx:123456",
  "https://pbx.example.com", "sip:pbx.example.com", "foo@pbx.example.com", "pbx/ws",
  "pbx?token=secret", "bad domain", "pbx..local", "-pbx.local", "pbx-.local", "[not-ip]",
  "[2001:db8::1]:0", "pbx:", "2001:db8::1", `${"a".repeat(64)}.local`]) {
  assert.equal(validSipServerAddress(value), false, `Expected invalid SIP server: ${value}`);
}
console.log("SIP server validation passed: company LAN hosts, IPv4, IPv6, ports and invalid authorities.");