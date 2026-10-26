# nafisvam-bale sidecar (piece 1a — NOT installed anywhere yet)

Loopback-only Python service that talks to Bale for each expert's personal account, using the vendored
`aiobale` 0.3.10 (unmodified, see `vendor/README.md`). The CRM API is the only client; contract in `CONTRACT.md`.

* Listens on `127.0.0.1:18470` only; every request needs `x-bale-internal-token` (file `BALE_SIDECAR_TOKEN_FILE`, ≥32 chars).
* Holds login flows in memory (5 min). Never writes a session to disk; the API stores sessions sealed with AES-256-GCM
  (`BALE_SESSION_KEY_FILE`). Logs are `path status` only — never phones, codes, passwords or tokens.
* Per-expert random device id; the library default device hash is rejected.

Local tests: `python -m unittest discover -s tests -v` (FakeClient, no network).

## Draft for piece 1b install (do not apply without a release plan)

```
useradd --system --home /opt/nafisvam/bale-sidecar --shell /usr/sbin/nologin nafisbale
python3 -m venv /opt/nafisvam/bale-sidecar/venv && /opt/nafisvam/bale-sidecar/venv/bin/pip install -r requirements.txt
# /etc/nafisvam/bale-sidecar.token (0640 root:nafisbale) shared with the API user; /etc/nafisvam/bale-session.key (0600, API user only)
```

`/etc/systemd/system/nafisvam-bale.service`:

```
[Unit]
Description=Nafis CRM Bale sidecar (loopback)
After=network-online.target
[Service]
User=nafisbale
WorkingDirectory=/opt/nafisvam/bale-sidecar
Environment=BALE_SIDECAR_HOST=127.0.0.1 BALE_SIDECAR_PORT=18470 BALE_SIDECAR_TOKEN_FILE=/etc/nafisvam/bale-sidecar.token
ExecStart=/opt/nafisvam/bale-sidecar/venv/bin/python sidecar.py
Restart=on-failure
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=
[Install]
WantedBy=multi-user.target
```
