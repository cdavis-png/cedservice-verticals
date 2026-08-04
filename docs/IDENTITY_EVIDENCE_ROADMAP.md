# Identity Evidence Roadmap

**Status:** planning only. **The live assessment is not modified by this
document.** Nothing here changes
[the nail-salon page](../verticals/beauty-wellness-fitness/nails/site/index.html)
until it is separately approved and implemented.

**Why this exists.** Identity resolution can only be as good as the signals it
receives. Today's nail-salon assessment collects business name, owner name,
email, and an optional mobile — three of which are classified
`INSUFFICIENT_ALONE` in
[identity-resolution.schema.js](../shared/business-record/identity-resolution.schema.js).

Measured against the model, today's best achievable outcome is **`probable_match`
— never `unique_match`.** Automatic linking is therefore **impossible**, and
every returning business lands in a human review queue. Adding a single strong
signal changes that outcome.

---

## 1. Friction budget

The assessment is 8 steps and 24 questions, and completion is the entire point
of the page. A longer assessment that nobody finishes resolves no identities at
all.

The budget for identity evidence is therefore: **one new required field and
three optional ones.** Everything else waits for checkout or onboarding, where
the business has already committed and the friction is justified.

---

## 2. Field classification

| Field | Signal strength | When collected | Why then |
|---|---|---|---|
| **Location count** | — (eligibility gate) | **Required before assessment completion** | One tap. Multi-location is a close-readiness hard blocker, so without it the platform can recommend a package it cannot deliver zero-touch. |
| **Google Business Profile URL** | **strong (0.95)** | **Optional during assessment** | The single highest-value field — the only one that makes `unique_match` and auto-linking possible. |
| **Website** | moderate (0.70) | Optional during assessment | One field, low friction, and the registrable domain is a durable signal. |
| **Business phone** | moderate (0.65) | Optional during assessment | Distinct from the owner mobile already collected. Business lines change less often. |
| **Street address** | moderate (0.60) | **Collected during checkout** | Billing address is needed anyway. Also the strongest *conflict* detector — two salons at one address are usually one business; the same name at two addresses usually is not. |
| **Legal name** | weak, but required commercially | **Collected during checkout** | Needed for the agreement. Irrelevant before purchase. |
| **Verified GBP place id** | strong (0.95) | **Collected during onboarding** | Every package includes Google Business Profile optimization, so onboarding necessarily establishes it. This upgrades a self-reported URL to a verified identifier at no extra friction. |

---

## 3. Placement notes

**Location count** belongs on step 1 with the other business facts, as a select
(`1` / `2–3` / `4+`) rather than a number input. A select is one tap and it maps
directly onto the eligibility decision; a free number invites typos on a field
that gates automated close.

**Google Business Profile URL** belongs on **step 6**, not step 1. Step 6 already
asks for Google review count and current rating — the business owner is already
looking at their Google listing to answer those. Asking for the link at that
moment is the lowest-friction placement available, and it reads as helpful
context rather than an identity demand.

This is the highest-leverage placement decision in this document: the same field
on step 1 is an interrogation; on step 6 it is a natural follow-up.

**Website and business phone** belong on step 1 alongside the existing contact
fields, both clearly marked optional. Neither should ever be `required`.

---

## 4. Expected effect on resolution

| Scenario | Best achievable status | Auto-link? |
|---|---|---|
| Today (name, email, optional mobile) | `probable_match` | No — every match queues for review |
| Plus website and business phone | `probable_match` | No — still no strong signal |
| Plus Google Business Profile URL | `unique_match` | **Yes**, at ≥ 0.90 with no conflicts |
| Plus verified GBP id at onboarding | `unique_match` | Yes, with third-party verification |

The step change comes entirely from the Google Business Profile field. Website
and phone improve *scores* but cannot change *status*, because status requires a
signal in `STRONG_SIGNALS`. That is worth knowing before trading conversion for
either of them.

---

## 5. Constraints on implementation

- **Optional means optional.** No identity field may become `required` beyond
  location count without a separate decision. A visitor who declines every
  identity question must still be able to complete the assessment and receive
  results.
- **Address is not collected pre-purchase.** It adds meaningful friction for a
  signal we can obtain later, and collecting a street address before any
  relationship exists is poor practice.
- **No new prohibited data.** None of these fields touch payment, credential,
  government-identifier, or health categories.
- **Attribution rules are unchanged.** These are identity signals, not marketing
  attribution; first-touch remains immutable.
- **Consent rules are unchanged.** Collecting a business phone is not consent to
  call or text it. SMS consent stays gated on the mobile field, as it is today.

---

## 6. Open questions

1. **Does location count belong in scoring?** It gates eligibility today. Whether
   a multi-location business should also score differently is a separate
   question, and out of scope until the pricing model for multi-location exists.
2. **GBP URL versus place id.** A pasted URL must be normalized to a place id to
   be useful. That normalization is a lookup, and no integrations are being built
   yet — so early collection stores the raw URL as a moderate signal and upgrades
   it at onboarding.
3. **Verticals beyond nails.** The same evidence needs apply to hair, barber, and
   spa. This roadmap should become part of the shared vertical template rather
   than being re-litigated per industry.
