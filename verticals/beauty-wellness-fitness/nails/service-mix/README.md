# Nail salon — Quick Service Mix Review

The first configuration of the shared Service Mix engine, and the reference
implementation for the next vertical.

```
service-mix.config.js   starters, question wording, results copy, transport
site/index.html         the page
site/page.js            DOM wiring only
site/styles.css         mobile-first; imports the design tokens, never redefines one
```

## Opening it

Double-click `site/index.html`. Opened from `file://` there is no server, so
the submission endpoint stays null and the adapter logs the payload instead —
the same documented preview mode the Growth Review has. Served over http(s)
it POSTs to `/api/assessments`.

## What belongs here, and what does not

| Here | Shared |
| --- | --- |
| The twelve nail-salon starters | The category vocabulary they map onto |
| Every question's wording | Every field name |
| Results copy, keyed to the classifier's own vocabulary | The classifier, its thresholds, and its version |
| The disclaimer text | The requirement that it travels with the figure |

If something in `page.js` starts to look like a *rule*, it belongs in
`shared/service-mix-engine/` instead — the second vertical will need it too.

## The starters are optional

Nothing is pre-selected. A salon that does not do acrylics should not have to
delete a row it never asked for, so the list is a menu rather than a default.

`defaultDuration` in the config is a placeholder hint for the form and is
**never** used as an answer. An unanswered duration is a measurement gap;
filling it with a plausible number would turn a gap into a fabricated
measurement.

## Compliance

Every figure is a diagnostic estimate and the disclaimer sits with it on
screen. The review collects no direct costs, so it produces no contribution,
margin, or profit figure and says so in those words rather than leaving a
section silently empty.

Consent wording carries `data-legal-review="pending"`. **Do not launch until
counsel has signed off and that attribute is removed.**

Full contract: [docs/SERVICE_MIX_REVIEW.md](../../../../docs/SERVICE_MIX_REVIEW.md).
