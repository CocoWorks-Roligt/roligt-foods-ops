# DECISIONS.md — assumptions register, dependency log, blocked list
Verdicts from audit slice 2 (2026-10-13). RULE: ASSUMED/PARTIAL items are built as CONFIGURABLE values (meta.app_config or new config rows), never hard-coded; surfaced in Phase 1 summary. Tax/compliance fields need business/accountant validation before relied upon.

## Assumptions Register
| # | item | verdict | evidence / default to build (configurable) |
|---|---|---|---|
| 1 | Grading scale | EXISTS-IN-APP | A/B/C+reject+free, Piece-uom only (`lib/grn.ts`); keep, add config for scale labels |
| 2 | Mass-balance tolerance | PARTIAL | yieldTolerance/pmTolerance are variance-vs-history alerts only; ADD mass-balance tolerance, ASSUMED default 2%, per-material override; unit conversions (avg nut weight ASSUMED ~500 g configurable; density ASSUMED ~1.0 kg/L configurable) |
| 3 | Spoilage reason codes | MISSING | per-stage editable reference data; ASSUMED defaults — extraction: rotten, cracked, overripe, pulp loss; blend/fill: spillage, burst pouch, line loss; any: QC reject |
| 4 | Malai storage | PARTIAL | all bulk → one Cold Room type today; ASSUMED malai = chilled (not frozen); storage-condition field added to material master |
| 5 | QC-at-receipt | MISSING | ASSUMED default OFF (receipts post Available as today); per-material flag to route receipt lots to Quarantine |
| 6 | Control-sample stock deduction | EXISTS-IN-APP | samples draw bulk+PM cost today (absorbed, never stock) — matches §3 default "yes, via explicit movement": ADD explicit sample ledger movement for visibility |
| 7 | Cold-chain limits | MISSING | ASSUMED alert at 30 min out-of-cold (configurable), loading timestamp recorded |
| 8 | FEFO rules | PARTIAL | pick lists FEFO-sorted + allocations seeded; make enforced + configurable (strict/relaxed) |
| 9 | QC spec limits | PARTIAL | TestParameter has method/unit only, results Pass/Fail strings; ADD numeric min/target/max per parameter (enables control charts); ASSUMED initial limits empty until lab supplies |
| 10 | Challan numbering | EXISTS-IN-APP | DC series configurable (`lib/numbering.ts`); ADD challan document (PDF, immutable, versioned, FY prefix option ASSUMED FY-Apr–Mar India) |
| 11 | Tax / e-way fields | MISSING | Customer.gst exists; challan gets configurable tax fields (GSTIN, HSN, tax rate) — FLAG: business/accountant must validate before production use |
| 12 | OTP at delivery | MISSING | ASSUMED optional, default OFF, flag per customer |
| 13 | procurement_form tri-state | PARTIAL | Item.directUse bool ≈ DIRECT_USE; extend to RAW/READY_EXTRACT/DIRECT_USE + shelf life, storage condition, min/max |
| 14 | Pouch→carton config | MISSING | ASSUMED defaults per BIB size (1L/2.5L/5L → carton type + pouches/carton) entered as editable reference data at rollout |
| 15 | Partial dispatch | MISSING (blocked by design today) | overhaul adds partial + packaging decision per line |

## Dependency log (one line each; UI deps pre-approved, guardrails: ONE component lib + ONE chart lib, permissive license, no framework migration)
- (Phase 2 SHELL will append: component library, chart library, signature-capture, etc.)

## Blocked
- (none)
