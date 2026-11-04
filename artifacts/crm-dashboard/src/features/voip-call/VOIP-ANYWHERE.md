# VOIP-ANYWHERE (Armita design v1.0 «تماس ویپ همه‌جا»)

Flags (call_queue_settings, read live, absent = OFF):
- `flag.voip_call_anywhere` / `flag.voip_call_anywhere.user.<id>` — the placements below. Needs `flag.voip_call` + an extension, as before.
- `flag.voip_call.registrar_scope` / `.user.<id>` — server scope for a registrar without salesperson (see below).

Placements (all go through VoipCallBox → POST /api/voip-call/start → vcStart; nothing new on the server for experts):
- /calls site-lead queue: lead card «تماس» + `.vi` icon per row (lead_idle / ring / incall / form / done / err).
- /customers list + search: `.vi` icon on own rows only (search_list); customer page: ONE call button —
  with an extension and voip_call on, VoIP «تماس» replaces «تماس سیستمی» (single-button rule); no extension → «تماس سیستمی» stays (no_ext_sys).
- /smart-filing lead cards (smart_list), my-queue.
- Incoming wizard: while the caller is on the line there is NO call button (in_card); after a missed call the existing s1b «تماس دوباره» (in_missed).

Unchanged server rules: vcCustomerAllowed (403 not_own_customer for other experts' customers), expert lockdown, one_call, needs_result, no_extension.
No-answer SMS untouched. Calls started here have fileId=null: they are customer calls, not file tasks, so needsResult/file-lock rules for
file tasks do not apply and the result goes to the customer (as on the customer page today).

First call (Mohammad: a first call auto-opens the mandatory form — same as FIRSTFORM-VOIP 47e9e2a): when SIMOTEL-132 marks the call
first_call, the required first-call form opens by itself as soon as the expert picks up and the customer is dialed / talking (not during
the ring), and again after the hang-up if Simotel says «جواب داد» and it is still unsaved (first_form). If Simotel says no answer, a
talk-time form closes again (draft kept). VoipAnywhereFirstFormHost, never doubled with a page's own opener (customer page / Today):
it waits 700 ms and skips while any first-call form is open. Later calls ask nothing.

Registrar scope (Mohammad, steering 3b): with the flag ON, a user with role registrar and no salesperson id (user 7) may VoIP-call ONLY
customers (not merged) that she registered (customers.registered_by = her), or that have an open smart-filing job (finished_at IS NULL) she created or approved for submit,
or that have an unexpired incoming-call grant (el_grants) for her. Everyone else → 403 not_own_customer. Never customerScope 'all'.
The UI shows «تماس» only for ids the server confirmed (GET /api/voip-call/anywhere/own, same A/B/C rule), otherwise the system button.
Flag OFF → exactly today's behaviour.

Known limits: expert lockdown ON hides /calls and /customers for locked experts (their VoIP stays on /today); other_calling and dnd_on
scenes have no server signal yet.
Tests: `pnpm run test:voip-anywhere` (crm-dashboard), `pnpm run test:voip-registrar-scope` (api-server).
