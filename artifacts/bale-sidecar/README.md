# nafisvam-bale sidecar (pieces 1a + 1b)

Loopback-only Python service that talks to Bale for each expert's personal account, using the vendored
`aiobale` 0.3.10 (unmodified, see `vendor/README.md`). The CRM API is the only client; contract in `CONTRACT.md`.

* Listens on `127.0.0.1:18470` only; every request needs `x-bale-internal-token` (file `BALE_SIDECAR_TOKEN_FILE`, ≥32 chars).
* Holds login flows in memory (5 min). Never writes a session to disk; the API stores sessions sealed with AES-256-GCM
  (`BALE_SESSION_KEY_FILE`). Logs are `path status` only — never phones, codes, passwords or tokens.
* Per-expert random device id; the library default device hash is rejected.
* 1b: one live client per connected expert (memory only; `bootId` in `/v1/health` changes on restart so the API re-attaches),
  `/v1/send` (typing indicator, phone lookup, error mapping) and a forwarder that POSTs private inbound messages to
  `BALE_INBOUND_URL` (loopback, direct API port). The sidecar makes no decisions: caps, quiet hours, filters, scope and
  auto-stop are all in the API (`artifacts/api-server/src/lib/bale-outbox.ts`).

Local tests: `python -m unittest discover -s tests -v` (FakeClient, no network).

## Server install (release kit `bale-rel`, B.sh)

* Python 3.14 (server) — pins in `requirements.txt` (aiohttp 3.13.2 / pydantic 2.12.3: first versions with cp314 wheels),
  full set in `requirements.lock`. The venv is built from a wheelhouse shipped with the kit (`pip --no-index`), so the
  server never downloads from PyPI.
* System user `nafisbale` (no shell), code + venv in `/opt/nafisvam/bale-sidecar` (root-owned, read-only for the service).
* `/etc/nafisvam/bale-sidecar.token` 0640 `www-data:nafisbale` (API reads it as owner). `/etc/nafisvam` is 0750 root:www-data,
  so the sidecar gets the token through systemd `LoadCredential=sidecar.token:/etc/nafisvam/bale-sidecar.token`
  (`BALE_SIDECAR_TOKEN_FILE=%d/sidecar.token`);
  `/etc/nafisvam/bale-session.key` 0600 `www-data:www-data` (API only). Both generated on the server, never printed.
* `nafisvam-bale.service`: `BALE_SIDECAR_HOST=127.0.0.1`, port 18470, `BALE_INBOUND_URL=http://127.0.0.1:<API_PORT>/internal/bale/inbound`
  (direct API port, never nginx), `ProtectSystem=strict`, `NoNewPrivileges`, `PrivateTmp`, `IPAddressDeny`-free (it must reach Bale).
* API env (`/etc/nafisvam/crm.env`): `BALE_SIDECAR_URL`, `BALE_SIDECAR_TOKEN_FILE`, `BALE_SESSION_KEY_FILE`.
  Every Bale switch stays off after install. An account is connected by the eligible sales expert themself on
  `/settings/bale` (number → code → second password); this needs the master switch ON. Admins can only switch
  modes / disconnect accounts (`/admin/bale`), there is no admin connect form.
