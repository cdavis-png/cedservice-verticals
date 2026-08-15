# BI → Sales operations

How a researched business becomes a CRM contact, and conditionally an
opportunity. The runbook for the two server surfaces migrations 0009–0011
created, and the canonical record of which GHL objects they address.

**Companions:** [SUPABASE_SETUP.md](SUPABASE_SETUP.md) ·
[AUTOMATION_POLICY.md](AUTOMATION_POLICY.md) ·
[STAFF_IDENTITY_RESOLUTION_OPERATIONS.md](STAFF_IDENTITY_RESOLUTION_OPERATIONS.md)
· CLAUDE.md §12 and §14

---

## 1. The lifecycle, and who owns what

```
BI research → Supabase Business Record → Qualified Lead → GHL Contact
            → GHL Opportunity → sales progression → Won / Client
```

| | Supabase owns | GHL owns |
| --- | --- | --- |
| Business identity | ✅ | |
| Research and evidence | ✅ | |
| Qualification and handoff decisions | ✅ | |
| Cross-system links | ✅ | |
| Historical milestones | ✅ | |
| Communications | | ✅ |
| Sales execution | | ✅ |
| **Current** opportunity state and stage | | ✅ |
| Won / Lost / client status | | ✅ |

Two rules follow, and neither is negotiable:

- **Supabase is not a second CRM.** It stores no live pipeline stage, no
  next-action queue and no message history. The webhook receiver writes
  *history* — a milestone happened, at a time, for a linked record. Anything
  wanting to know where an opportunity is *now* asks GHL.
- **No database trigger calls GHL.** A trigger that made an outbound HTTP call
  would put a network round trip inside a lock and turn a CRM outage into a
  failed transaction. The promotion boundary is server-side, always.

**Qualification and approval-to-pursue are separate human decisions.**
`sales_handoffs.qualification_status = 'qualified'` makes a Lead.
`pursuit_approved_by` / `pursuit_approved_at` is the *separate* decision that
permits an Opportunity, and the schema refuses to let one imply the other.

---

## 2. Canonical GHL objects

Sub-account **CED Service**, location `qy50mN2frSwxhSAEcqxF`.
`allowDuplicateContact: false`, `allowDuplicateOpportunity: false`; contact
uniqueness is email, then phone.

### Pipeline — `CED Service Leads`, `CJsWJoJy9PmiEe5BJYfy`

There is exactly one pipeline and a second must not be created.

| Position | Stage | ID |
| --- | --- | --- |
| 0 | New Inquiry | `a32500fb-c823-42be-abec-58e1b980b3e9` |
| 1 | Qualified — Not Contacted | `dfa60f8f-48c3-45d4-a254-7738af36ab1e` |
| 2 | Contacted | `b605459f-093a-464d-a49d-ccb456f937b5` |
| 3 | Teardown/Audit Delivered | `bb456594-95b9-4bed-8298-18d8b1b60ced` |
| 4 | Proposal Sent | `7d1ac95c-83b9-4801-bc39-a01212d70a10` |
| 5 | Won | `e29fb5ac-8bdf-4e5f-9219-4699287863aa` |
| 6 | Lost | `bbd0cac6-1985-49f8-9012-6991bcf6da39` |

Verified live on 2026-08-14: seven stages, one pipeline, the six pre-existing
stage IDs unchanged and unrenamed, and the new stage named with a **spaced em
dash** (U+2014) exactly as above.

**Entry rules.** Inbound enquiries enter `New Inquiry`, which belongs to GHL's
own workflows and is never set from this repository. Researched **outbound**
opportunities are created directly into `Qualified — Not Contacted`. That
separation is the only thing distinguishing the two lead sources in the
pipeline, so it must not be blurred.

`Qualified — Not Contacted` sits **before** `Contacted` deliberately: a
researched business that has been qualified has, by definition, not been
contacted yet. Ordering it after `Contacted` would make the pipeline say an
opportunity is contacted and then becomes not-contacted.

Stages are addressed by **ID** everywhere in this repository — never by name
and never by position — so a future rename or reorder in the GHL UI cannot
break the promotion boundary. Update this table when that happens.

### Contact custom fields

| Field | ID | Key | Type |
| --- | --- | --- | --- |
| CED Business ID | `QZKukYCCSaBr3o1rpUAq` | `contact.ced_business_id` | TEXT |
| Lead Focus | `imH7mOH9zhfrnz56gNsC` | `contact.lead_focus` | TEXT |

`CED Business ID` holds the canonical Supabase `business_id` UUID. It is the
recovery key: when a contact link row is lost, the promotion boundary finds the
existing contact by searching this field rather than creating a duplicate.
Custom fields are addressed by **ID**, never by `fieldKey` — a key can be
renamed in the CRM UI and an ID cannot.

`Lead Focus` is reused, not duplicated. It carries `need_key` or
`need_key / offer_key`.

### Tags

| Tag | ID |
| --- | --- |
| `ced_lead` | `YaHIXvVzYOvSaC3SDWNo` |
| `ced_source_bi_research` | `GkwOEaknKtpGub81PbWV` |

Both are applied to every BI-sourced contact. `ced_lead` marks it a lead;
`ced_source_bi_research` records *how it arrived*, which is what stops
researched outbound being mistaken for an inbound enquiry later.

### Opportunity naming

`[Business Name] — [Need/Offer]`, em dash, e.g. `Test Salon — Missed calls`.
One **open** opportunity per canonical `business_id + need_key + offer_key`.

---

## 3. The two surfaces

Both are Vercel Node functions: an `api/` entrypoint whose only job is platform
adaptation, and the implementation in `server/`, outside the `api/` tree,
because Vercel deploys every file under `api/` as its own function (§12). There
are no Supabase Edge Functions in this project and adding one would be a second
deployment architecture.

| | `POST /api/sales/promote` | `POST /api/webhooks/ghl` |
| --- | --- | --- |
| Entrypoint | `api/sales/promote.mjs` | `api/webhooks/ghl.mjs` |
| Implementation | `server/sales-promotion.mjs` | `server/crm-webhook.mjs` |
| Caller | a staff operator | HighLevel |
| Credential | bearer access token + live `staff_operators` lookup | Ed25519 signature |
| Origin check | required, exact-matched | **none** — GHL is not a browser |
| Rate-limit namespaces | `sales_preauth:`, `sales:` | `crm_webhook:` |

### Promote to Sales

Ordered so nothing is spent before the caller is proved: HTTPS → origin →
content type → method → pre-auth rate limit → token → authenticated rate limit
→ **live `staff_operator_guard`** → handoff → Business Record → idempotency
claim → contact → opportunity → complete.

- **A handoff that is not `qualified` is refused outright** — `deferred` and
  `withdrawn` are decisions not to pursue, and `not_qualified` is a decision
  against.
- **An existing link is authoritative** and is consulted before GHL is asked
  anything.
- **`CED Business ID` is searched before anything is created.** This is the
  partial-failure recovery path.
- **No name, email or phone is invented.** A contact is created with the
  Business Record's display name and nothing else. A placeholder email would
  defeat GHL's own deduplication and attach a real business to a value nobody
  can verify.
- **An opportunity requires `qualified` AND `pursuit_approved_at`.** Requesting
  one without pursuit approval links the contact and reports
  `opportunitySkippedReason: "pursuit_not_approved"` — it does not create a CRM
  opportunity the database would then refuse to link.
- **Idempotency**: `Idempotency-Key` header, required. Same key + same request
  replays the first outcome with `replayed: true`. Same key + *different*
  request is refused `409 idempotency_conflict`, never answered with the first
  call's result. The operator is part of the request hash.

### The webhook receiver

- **The signature is the only credential** and is verified over the
  **unmodified raw bytes**, before parsing, before the database, before a
  rate-limit bucket. There is no configuration flag that disables it.
- The deprecated RSA `X-WH-Signature` is **not accepted**; honouring both would
  let whoever chooses the header choose the weaker scheme.
- Duplicate deliveries answer **200**. HighLevel retries any non-2xx, so a 409
  on an already-processed delivery would retry forever.
- Events about records this platform never linked are acknowledged and acted on
  by nothing — the ordinary case for every inbound opportunity CED did not
  create.
- **Staleness is judged by the external timestamp**, never arrival order, so a
  late-delivered earlier event cannot undo a later milestone.
- Won / Lost / Abandoned deactivate the opportunity link. `abandoned` writes
  **no** milestone: no approved event name describes abandonment, `sales.lost`
  would assert a loss that did not happen, and `sales.disqualified` a judgement
  CED never made.
- Only a SHA-256 of the payload is retained. No raw CRM body is stored.

---

## 4. Configuration

Server-only, set in the Vercel Function environment. `.env.example` carries the
names and the reasoning.

```
GHL_API_TOKEN=                     # preferred; GHL_PI_TOKEN is the legacy fallback
GHL_LOCATION_ID=qy50mN2frSwxhSAEcqxF
GHL_PIPELINE_ID=CJsWJoJy9PmiEe5BJYfy
GHL_STAGE_QUALIFIED_NOT_CONTACTED=dfa60f8f-48c3-45d4-a254-7738af36ab1e
GHL_FIELD_CED_BUSINESS_ID=QZKukYCCSaBr3o1rpUAq
GHL_FIELD_LEAD_FOCUS=imH7mOH9zhfrnz56gNsC
```

Every one is required and every accessor fails closed, because a client that
silently posts to the wrong location or omits the Business ID writes bad data a
human then unpicks by hand.

**Token scopes, as measured on 2026-08-14** against the CED Service Private
Integration, by probing with deliberately invalid bodies so nothing was created:

| Operation | Result |
| --- | --- |
| `POST /contacts/search` | 200 — works, including a filter on `customFields.QZKukYCCSaBr3o1rpUAq` |
| `POST /opportunities/` | 422 validation — scope present |
| `POST /contacts/` | 403 missing-location — scope present |
| `PUT /opportunities/pipelines/{id}` | **401 `not authorized for this scope`** |

The token cannot modify pipelines. Stage changes are a UI operation, which is
also the safer route: the API form replaces the complete stages array, and
every existing stage ID has to survive verbatim.

---

## 5. What is NOT enabled

- **There is no automatic BI-to-GHL promotion.** Promotion is an explicit,
  authenticated, per-handoff call. Nothing sweeps qualified handoffs.
- **No researched-outbound opportunity automation exists**, and none should be
  built until the Voice AI inbound-call workflow's opportunity-creation
  behaviour is understood — see §6.
- Neither surface has been deployed or reached a real CRM. Every result above
  is from the test suite plus read-only and non-mutating probes.

---

## 6. Open items

- **The Voice AI workflow.** Contact `AsRMUVZXSAjB9xPrfFKl` (Chris Davis) holds
  three `Voice AI Lead - C DAVIS` opportunities, all `open`, all `$0`, all in
  `New Inquiry`, all from source `Voice AI Inbound Call` — created 2026-07-15
  00:03Z, 2026-07-18 00:18Z and 2026-07-18 00:45Z. **They are test data. Do not
  delete, close, merge or alter them.** Two on one night 27 minutes apart is
  repeated workflow entry, not three leads.

  The responsible workflow is almost certainly **`CED Voice AI - Post-Call
  Intake + Internal Notify`** (`fdd1f46f-437d-4bbb-bfbc-84abd1aec237`);
  secondary candidate **`Missed-Call Catcher`**
  (`2a0844f3-15a1-4db0-a7c1-f89aeea0d780`). This cannot be confirmed through
  the API: `GET /workflows/{id}` and `/versions` both 404, and the public API
  exposes only the workflow *list*, never triggers or actions. Inspect
  Automation → Workflows → that workflow → the Create/Update Opportunity action
  and its Allow Re-Entry setting.
- **Migration 0011 is written and tested but not applied.**
- **No staff operator exists.** `auth.users` and `staff_operators` are both
  empty, so no handoff can be qualified: `qualified_by` and
  `pursuit_approved_by` are both foreign keys into `staff_operators`.
