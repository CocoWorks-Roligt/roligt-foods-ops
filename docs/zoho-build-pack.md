# Zoho build pack — Roligt Plant Ops

**Companion to:** `docs/zoho-rebuild-blueprint.md` (decisions and architecture).
**This file is the execution pack:** every form, every field, the seed records, the apply order, and the spike protocol — ready to apply the moment the two access fixes land (Tables portal MCP flag; Creator OAuth builder scopes).

**Apply method:** via the Zoho Creator MCP (`createForm` → `getFormMetadata` for the section link → `createField` per row; lookups after both forms exist), or by hand in the builder following the same order. Field types are named as the MCP names them.

---

## 1. Apply order

Dependencies before dependents — lookups need their targets to exist first:

```
Phase M (masters):  Vendor Types → Vendors → Customers → Items → Purchase Products
                    → Storage Locations → Test Categories → Test Parameters
                    → Products (+ BOM Lines subform) → Melanges → Counters → Config
Phase T (docs):     GRNs → Batches → Packing Runs (+ Run Lines subform)
                    → QC Records → Lab Reports → Orders (+ Order Lines)
                    → Dispatches → Stock Issues → Production Plans
                    → Shifts → Attendance → Ledger → Audit Log
Phase D (Deluge):   paste posting functions (see zoho-posting-engine.deluge)
Phase S (spike):    §5 below, before any real use
```

**Staff:** deliberately absent from Phase M — see §4 (link to the existing Employee Management app instead).

## 2. Masters schema

Types: `SL` single line · `ML` multi line · `NUM` number · `DEC` decimal · `DD` dropdown · `DT` date/datetime · `DB` decision box · `LOOKUP` single-select lookup → (form · display field) · `SUB` subform.

### Vendor Types
| Field | Type | Req | Notes |
|---|---|---|---|
| Name | SL | ✓ | primary |
| Source Kind | DD | ✓ | Farmer / Vendor / Other |
| Description | ML | | |
| Status | DD | ✓ | Active / Inactive |

### Vendors
| Field | Type | Req | Notes |
|---|---|---|---|
| Name | SL | ✓ | |
| Vendor Type | LOOKUP | ✓ | → Vendor Types · Name |
| Phone | SL | | |
| Area | SL | | |
| Payment Terms | SL | | |
| Status | DD | ✓ | Active / Inactive |
| Email | EMAIL | | |
| Notes | ML | | |

### Customers
| Field | Type | Req | Notes |
|---|---|---|---|
| Name | SL | ✓ | |
| Ship To | SL | ✓ | |
| GSTIN | SL | | |
| Status | DD | ✓ | Active / Inactive |
| Phone / Email / Contact Person | SL / EMAIL / SL | | |
| Notes | ML | | |

### Items *(the one stock vocabulary: raw, bulk, PM, FG)*
| Field | Type | Req | Notes |
|---|---|---|---|
| Name | SL | ✓ | ledger key once written — never rename |
| Type | DD | ✓ | Raw Material / Semi Finished / Packing Material / Finished Goods |
| UOM | DD | ✓ | Piece / Kg / Litre / Pack / Bottle |
| Lot Controlled | DB | ✓ | default on |
| Reorder Level | NUM | | |
| Cost Method | DD | ✓ | Lot Actual / Batch Actual / By-product / Weighted Avg |

### Purchase Products *(what may be bought, and from whom)*
| Field | Type | Req | Notes |
|---|---|---|---|
| Name | SL | ✓ | |
| Item | LOOKUP | ✓ | → Items · Name |
| Default UOM | SL | | |
| Linked Vendors | LOOKUP (multi if available) | | → Vendors · Name |

### Storage Locations
| Field | Type | Req | Notes |
|---|---|---|---|
| Name | SL | ✓ | internal ledger key, fixed at creation |
| Label | SL | ✓ | what people read |
| Holds | ML | | |
| Type | DD | ✓ | Cold Room / Dry Store / Hold Area |
| Status | DD | ✓ | Active / Inactive |

### Test Categories
| Field | Type | Req | Notes |
|---|---|---|---|
| Title | SL | ✓ | |
| Format | DD | ✓ | results (certificate) / scored (sensory) |
| Required for Release | DB | ✓ | |
| Pass Score / Minor Score | NUM | | scored format only |
| Signatory | SL | | printed on certificates |
| Status | DD | ✓ | Active / Inactive |

### Test Parameters
| Field | Type | Req | Notes |
|---|---|---|---|
| Category | LOOKUP | ✓ | → Test Categories · Title |
| Name | SL | ✓ | e.g. Salmonella spp |
| Method | SL | | IS / ISO method ref |
| Unit | SL | | Cfu/mL, /25mL… |

### Products *(pack SKUs)* + BOM Lines subform
| Field | Type | Req | Notes |
|---|---|---|---|
| Name | SL | ✓ | |
| Format | SL | ✓ | BiB / Glass Bottle / Cover / … (admin-named) |
| Size / Unit | DEC / SL | ✓ | 5 · L, 250 · ml |
| Pack Volume | DEC | ✓ | size in base units (0.25 for 250 ml) — **stored, not derived** |
| Shelf Life Days | NUM | ✓ | frozen life from packing date |
| Chilled Shelf Life Days | NUM | | dispatch-label only |
| MRP | DEC | | dispatch label |
| Bulk Item | LOOKUP | ✓ | → Items · Name (Semi Finished only) — what may be drawn |
| Medium | SL | | Water / Malai |
| **BOM Lines** | SUB | | ▼ |
| &nbsp;&nbsp;Item | LOOKUP | ✓ | → Items · Name (Packing Material) |
| &nbsp;&nbsp;Qty per Pack | NUM | ✓ | |

### Melanges *(recipes)* + Component subform
| Field | Type | Req | Notes |
|---|---|---|---|
| Name / Status | SL / DD | ✓ | |
| Output Item | LOOKUP | ✓ | → Items · Name (the bulk it mints) |
| **Components** | SUB | | Item LOOKUP → Items (Semi Finished) · Share DEC (sums to 100) |

### Counters *(document numbering)*
| Field | Type | Req | Notes |
|---|---|---|---|
| Series | SL | ✓ | key: grn, lot, batch, melangeBatch, packing, qc, dispatch, order, challan, issue, pmReceipt, testReport, sticker, plan, staff |
| Prefix | SL | ✓ | RFTC, LOT, BAT, MEL, PKG, QC, DSP, ORD, DC, ISS, PMR, TR, STK, PLN, STF |
| Pattern | SL | ✓ | e.g. `{P}{YYYY}{N}` — see mintDocNo in the Deluge pack |
| Pad | NUM | ✓ | 4 |
| Next | NUM | ✓ | guarded by mintDocNo only — nothing else writes it |

### Config *(single row)*
yield tolerance · PM tolerance · expiry alert days · low-stock packs · report customer name · sticker size — all `NUM`/`SL`, one record, edited by admin.

## 3. Transactional schema (phase T — key fields only)

- **GRNs**: Date · Product (LOOKUP Purchase Products) · UOM · Location (LOOKUP Storage Locations) · Vendor/Farmer (LOOKUP Vendors) · Area · Harvested On · Total / Accepted / Free (NUM) · Grades A/B/C/Reject (NUM) · Rate · Other Charges · Landed (DEC, formula) · Status. Ledger lines minted by `postGrn`.
- **Batches**: Date · Kind DD (Extraction/Melange) · **Source Lots subform** (Item LOOKUP, Lot SL, Qty) · **Outputs subform** (Item LOOKUP, Qty, Main DB — one main carries cost) · Spoiled · Location · Cost/Unit (DEC, computed by postBatch) · Status DD (Awaiting QC/Released/On Hold/Rejected).
- **Packing Runs**: Date · Batch (LOOKUP Batches) · Bulk Item (LOOKUP) · Drawn · Location · **Lines subform** (Product LOOKUP, Packs NUM) · **Control Samples subform** (Product, Count, Collected By) · Status.
- **QC Records**: Batch LOOKUP · Item LOOKUP · Disposition DD (Awaiting/Released/On Hold/Rejected) · **Tests subform** (Category LOOKUP, Status DD Pending/Pass/Fail/Retest, Report attachment) · Attachments.
- **Lab Reports**: Report No (auto) · Category LOOKUP · **Scores subform** (Attribute, 1–5) · Decision (formula from scores) · Batch LOOKUP · Sample Date · Customer · Issue Date · Attachment.
- **Orders** + **Order Lines** (child form, not subform — the demand feature sums it): Order No · Customer LOOKUP · Date · Status DD (Open/Dispatched/Cancelled); Lines: Order LOOKUP · SKU LOOKUP Products · Qty.
- **Dispatches**: Date/Time · Customer · SKU · Batch LOOKUP · Location · Expiry · Qty · Vehicle · Challan · Status DD (Dispatched/In Transit/Delivered) · POD attachment.
- **Stock Issues**: Date · Reason DD · Issued To · **Lines subform** (Item, Lot, Location, Status, Qty, Expiry) · Value.
- **Production Plans**: Day · Stage DD · Product · Qty · UOM · Note · Status DD (Planned/In progress/Done/Cancelled).
- **Shifts / Attendance**: Staff LOOKUP (§4) · Date · Shift DD (Morning/Evening/General) · Line · / Status DD (Present/Absent/Leave/Half day). Key `staff|date`.
- **Ledger** *(flat, append-only — the source of truth)*: Doc · Type · Item LOOKUP · Lot · Location · Status · Qty In · Qty Out · Unit Cost · Expiry · Time. **No edit, no delete, ever** — reversals are new rows.
- **Audit Log**: Doc · Action · Details · Actor · Time.

## 4. Staff — link, don't rebuild

The live **Employee Management** app (17 forms: employee master, departments, designations, leave) already owns person data. The ops app should hold a lightweight **Operators** register that references employees (name + role + status) rather than a second HR master — or a cross-app lookup if Creator's cross-app lookup is available on the plan. Decide at apply time; the Shifts/Attendance forms above work identically either way.

## 5. Spike protocol (run before first real use)

1. Create throwaway `Spike` form with a `Number` field and a Counters row (`SPK`, next=1).
2. Fire `mintDocNo` from **two sessions simultaneously** (two browser tabs, two users) × 20 rounds. **Pass:** 40 sequential numbers, zero duplicates.
3. Fire `postGrn` twice with the same idempotency key. **Pass:** one GRN, one lot, one ledger line.
4. Walk the plant floor with a phone on Creator mobile, no Wi-Fi. **Record:** what happens to an unsaved form. This is the accepted-risk item — write the answer down.

## 6. Seed payloads (field link names as they'll be created)

**Vendor Types:** `{"Name":"Farmer","Source_Kind":"Farmer","Description":"Produce suppliers","Status":"Active"}` · `{"Name":"Vendor","Source_Kind":"Vendor","Description":"Material and packing suppliers","Status":"Active"}`

**Storage Locations:** (Name · Label · Type · Holds)
- `RM Store` · Raw Material Store · Dry Store · Produce received from farmers waiting to be pressed
- `PM Store` · Packaging Store · Dry Store · BiBs, cartons, bottles, caps and malai covers
- `Bulk Store` · Bulk Cold Room · Cold Room · Extracted juice, water, malai and melanges waiting to be packed
- `Cold Room` · Finished Goods Cold Room · Cold Room · Frozen finished packs until dispatched
- `Reject Hold` · Rejected Stock · Hold Area · Quality-rejected stock awaiting a decision

**Items:** (Name · Type · UOM · Reorder · Cost Method)
`Tender Coconut` · Raw Material · Piece · 500 · Lot Actual | `Coconut Water (bulk)` · Semi Finished · Litre · 0 · Batch Actual | `Malai (bulk)` · Semi Finished · Kg · 0 · By-product | `Malai Cover` · Packing Material · Piece · 100 · Weighted Avg | `5 L BiB` · PM · Piece · 100 · Weighted Avg | `5 L C-Box` · PM · Piece · 100 · Weighted Avg | `2.5 L BiB` · PM · Piece · 100 · Weighted Avg | `2.5 L C-Box` · PM · Piece · 100 · Weighted Avg | `250 ml Glass Bottle` · PM · Piece · 500 · Weighted Avg | `250 ml Cap` · PM · Piece · 500 · Weighted Avg | `OG Tender Coconut Water 5 L` · Finished Goods · Pack · 30 · Batch Actual | `OG TCW 2.5 L` · FG · Pack · 30 · Batch Actual | `OG TCW 250 ml` · FG · Bottle · 200 · Batch Actual | `Malai Pack` · FG · Kg · 10 · Batch Actual

**Products:** `OG TCW 5 L` (BiB · 5 L · vol 5 · shelf 7 · bulk Coconut Water (bulk) · BOM: 1× 5 L BiB + 1× 5 L C-Box) · `OG TCW 2.5 L` (BiB · 2.5 · vol 2.5 · BOM 1+1) · `OG TCW 250 ml` (Glass Bottle · 250 ml · vol 0.25 · BOM bottle+cap) · `Malai Cover 1 kg` (Cover · 1 kg · vol 1 · bulk Malai (bulk) · BOM 1× Malai Cover)

**Test Categories:** Microbiology (results, required) · Pesticide Residues (results, required) · Heavy Metals (results, required) · Physicochemical (results, required) · Sensory Evaluation (scored, required)

**Test Parameters (Microbiology):** Aerobic Plate count · IS 5402-1:2021 · Cfu/mL | Listeria monocytogenes · IS 14988-1:2020 · /25mL | Staphylococcus aureus · IS 5887-2:1976 · /mL | Vibrio cholerae · IS 5887-5/Sec-1:2023 · /25mL | Yeast and Moulds · IS 5403:1999 · Cfu/mL | E. coli · IS 5887-1:1976 · /mL | Salmonella spp · IS 5887-3/Sec-1:2020 · /25mL

**Counters:** the §2 Counters table, Next=1 each.
