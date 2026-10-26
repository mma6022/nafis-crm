# API ↔ Bale sidecar contract (piece 1a)

* Transport: HTTP on `127.0.0.1:18470` (API env `BALE_SIDECAR_URL`; the API refuses any non-loopback URL).
* Auth: header `x-bale-internal-token` = content of `BALE_SIDECAR_TOKEN_FILE` (≥ 32 chars, file mode 600, same file for both sides).
* Secrets (code, 2FA password, session token) travel only in JSON bodies. Neither side logs bodies. Max body 16 KB.
* Errors: `{"error": <code>}` with codes `phone_invalid | rate_limited | number_banned | wrong_code | code_expired |
  sign_up_needed | wrong_password | flow_expired | unauthorized | unknown`.

| Route | Body | 200 response |
|---|---|---|
| `GET /v1/health` | – | `{ok, version, sessions, flows}` |
| `POST /v1/auth/start` | `{accountRef, phone:"09xxxxxxxxx", deviceHash:<uuid, per expert>, deviceTitle}` | `{flowId, codeType:"app"\|"sms"\|"unknown", expiresInS}` |
| `POST /v1/auth/code` | `{flowId, code}` | `{status:"connected", token, baleUserId}` or `{status:"password_needed"}` |
| `POST /v1/auth/password` | `{flowId, password}` | `{status:"connected", token, baleUserId}` |
| `POST /v1/auth/cancel` | `{flowId}` | `{ok:true}` |
| `POST /v1/session/signout` | `{accountRef, token, deviceHash}` | `{ok:true}` |

The Bale `transaction_hash` never leaves the sidecar; `flowId` is a random 24-byte handle, TTL 5 min.
No session is written to disk (`Client(session_file=None)`); the API seals the token with AES-256-GCM (`BALE_SESSION_KEY_FILE`).

Piece 1b adds: `POST /v1/session/attach` (API hands the decrypted token after a sidecar restart), `POST /v1/send`,
and sidecar → API `POST /internal/bale/inbound`.
