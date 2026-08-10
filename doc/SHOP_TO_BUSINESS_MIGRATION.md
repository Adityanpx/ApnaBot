# Shop → Business Rename Migration

This is a staged rename of the core tenant concept from "Shop"/"shopId" to
"Business"/"businessId" across the ApnaBot platform (backend, SuperAdmin
panel, web app). Done in stages to avoid downtime or breakage, since
shopId is threaded through nearly the entire backend (auth, webhook,
booking, chatbot, usage tracking, socket events, Redis cache keys) and
there is live production data already keyed on it.

## Stage 1 — Additive alias (DONE)
Added `src/models/Business.js` as a pure re-export of the existing `Shop`
model: same schema, same Mongoose model, same underlying MongoDB
collection, same data. Zero risk — nothing existing was touched or
renamed. This exists purely so future new code can import `Business`
instead of `Shop` without requiring any data migration yet.

## Stage 2 — New code uses "Business" naming (IN PROGRESS)
Any brand-new feature work going forward should import `Business` (not
`Shop`) and use `businessId` naming in new fields/variables where
practical, WITHOUT touching any existing shopId field, route, or
document. Existing code continues using `Shop`/`shopId` unchanged. The
two names coexist safely since Business is just an alias for Shop.

## Stage 3 — Mechanical backend rename (NOT STARTED)
The big, deliberate step: systematically rename `shopId` -> `businessId`
across every model (Vehicle, RouteFare, VehicleTypeCatalog, Booking,
Customer, Message, Rule, usage/subscription tracking, etc.), every
controller/service/route referencing `shopId` or `req.user.shopId`, and
every Redis cache key format (`rules:{shopId}`, `tenant:{phoneNumberId}`
payloads that embed shopId, booking session keys
`booking_session:{shopId}:{customerNumber}`, etc.).

Requires:
- A MongoDB migration script that renames the `shopId` field to
  `businessId` on every collection that has it (field rename, not a
  new field — existing data must carry over, not be duplicated).
- Renaming the `Shop` model file/collection itself (or deciding to keep
  the MongoDB collection name `shops` for backward compatibility while
  the Mongoose model and code-level naming become `Business` — TBD,
  decide before starting this stage).
- Careful sequencing during low-traffic hours, with a tested rollback
  plan, since this touches live webhook/booking code paths.
- Full regression test of the entire booking flow (Phase 1 fleet CRUD,
  Phase 2 vehicle carousel, generic business types) after this stage,
  before considering it complete.

Do not start this stage without explicit go-ahead — it's the highest
risk step in this migration.

## Stage 4 — Frontend labels (NOT STARTED, can happen independently)
Cosmetic only, low risk, does not require Stage 3 to be complete first:
- SuperAdmin panel: "Shops" nav item/page/hooks -> "Businesses" (label
  text only; underlying API calls can keep hitting shopId-based
  endpoints until Stage 3 lands).
- Web app: any "shop"/"shop owner" copy -> "business"/"business owner".
- Customer-facing bot text, if any currently says "shop".

## Notes
- `Business` and `Shop` are interchangeable at the code level throughout
  Stages 1-2 — importing either gives you the exact same Mongoose model
  and data. This is intentional and safe.
- Do not delete or diverge Shop.js until Stage 3 is fully complete and
  verified — Business.js depends on it as of Stage 1.