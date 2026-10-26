# API ↔ Bale sidecar contract (pieces 1a + 1b)

* Transport: HTTP on `127.0.0.1:18470` (API env `BALE_SIDECAR_URL`; the API refuses any non-loopback URL).
* Auth: header `x-bale-internal-token` = content of `BALE_SIDECAR_TOKEN_FILE` (≥ 32 chars, file mode 600, same file for both sides).
* Secrets (code, 2FA password, session token) travel only in JSON bodies. Neither side logs bodies. Max body 16 KB.
* Errors: `{"error": <code>}` with codes `phone_invalid | rate_limited | number_banned | wrong_code | code_expired |
  sign_up_needed | wrong_password | flow_expired | unauthorized | unknown` and (1b) `not_attached | peer_not_found |
  session_invalid | account_banned | peer_blocked (UNVERIFIED) | bad_request`.
* (1b-0.2) `client_error` (502): a local failure inside the sidecar or the library (not a Bale answer); never treated as an
  invalid or banned session. `timeout` (504): connect / get_me took longer than 25 s. `/v1/session/attach` errors also carry
  `step: load | connect | get_me`. The sidecar journal logs `attach failed step=… code=… <ExceptionClass> <redacted message>`
  (JWTs, long blobs and digit runs ≥ 5 redacted; pydantic errors reduced to field + type).
* (1b-0.2) aiobale 0.3.10 leaves `client.id` empty for a token-only client; the factories rebuild it from the JWT `user_id`
  claim (`prime_identity`) before `start`, otherwise `get_me()` fails on every attach.

| Route | Body | 200 response |
|---|---|---|
| `GET /v1/health` | – | `{ok, version, sessions, flows, bootId, attached:[accountRef]}` |
| `POST /v1/auth/start` | `{accountRef, phone:"09xxxxxxxxx", deviceHash:<uuid, per expert>, deviceTitle}` | `{flowId, codeType:"app"\|"sms"\|"unknown", expiresInS}` |
| `POST /v1/auth/code` | `{flowId, code}` | `{status:"connected", token, baleUserId}` or `{status:"password_needed"}` |
| `POST /v1/auth/password` | `{flowId, password}` | `{status:"connected", token, baleUserId}` |
| `POST /v1/auth/cancel` | `{flowId}` | `{ok:true}` |
| `POST /v1/session/signout` | `{accountRef, token, deviceHash}` | `{ok:true}` |

The Bale `transaction_hash` never leaves the sidecar; `flowId` is a random 24-byte handle, TTL 5 min.
No session is written to disk (`Client(session_file=None)`); the API seals the token with AES-256-GCM (`BALE_SESSION_KEY_FILE`).

## 1b: live sessions, send, inbound

| Route | Body | 200 response | Errors |
|---|---|---|---|
| `POST /v1/session/attach` | `{accountRef, token, deviceHash}` | `{ok:true, baleUserId}` | 401 session_invalid, 403 account_banned, 502 unknown (incl. 25 s connect timeout) |
| `POST /v1/session/detach` | `{accountRef}` | `{ok:true}` | – |
| `POST /v1/send` | `{accountRef, phone:"09…", peerId\|null, text (≤4000), typingMs}` | `{messageId, peerId}` | 409 not_attached, 404 peer_not_found, 429 rate_limited, 403 account_banned, 403 peer_blocked (UNVERIFIED), 401 session_invalid, 400 bad_request |

* Sessions live in memory only. A sidecar restart changes `bootId` and empties `attached`; the API worker sees that in
  `/v1/health` and re-attaches every connected, enabled account (and re-attaches once on a `not_attached` send).
* `/v1/send`: with no `peerId` the sidecar looks the phone up with `search_contact` (lookup only, never imports into the
  expert's contacts). "typing…" is shown for `typingMs`, capped at 8 s. `session_invalid`/`account_banned` drop the live
  session; `rate_limited` keeps it (the API auto-stops the account either way).
* Error mapping is by BaleError message substring (FLOOD/RATE/LIMIT/TOO_MANY → rate_limited; BAN/BLOCK/DEACTIVATED →
  account_banned; AUTH/TOKEN/SESSION/UNAUTHORIZED → session_invalid; PEER/NOT_FOUND → peer_not_found). **Confirm with the
  test SIM before go-live.**
* **UNVERIFIED — `peer_blocked`** (one customer blocked the expert): USER_BLOCKED / PEER_BLOCKED / BLOCKED_BY_USER /
  BLOCKED_BY_PEER / YOU_ARE_BLOCKED / USER_IS_BLOCKED, checked before the generic BAN/BLOCK rule. The sidecar keeps the
  session on `peer_blocked`; the API decides. Default (`bale_settings.peer_block_mode = account_stop`) = exactly the old
  behaviour: treated as `account_banned`, the whole account stops and the client is detached. Only after the real Bale
  wording is confirmed with the test SIM may an admin switch to `conversation_pause` (only that customer's chat pauses).
* Inbound: for every PRIVATE message the sidecar POSTs to `BALE_INBOUND_URL` (loopback HTTP, straight to the API port —
  the API refuses anything carrying proxy headers) with the same `x-bale-internal-token`:
  `{accountRef, events:[{peerId, peerPhone|null, messageId, text|null, hasFile, fromSelf, date(ms)}]}`.
  Retries 1 s / 3 s / 10 s on network or 5xx errors; no retry on 400/403. The API dedupes on `messageId` and keeps only
  messages from the expert's own customers. `peerPhone` is only known for peers this sidecar process has sent to.
