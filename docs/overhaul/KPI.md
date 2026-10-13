# KPI.md — per-module metric catalog (ARCHITECT, 2026-10-13)
SHARED AGGREGATION: every metric below is served by `GET /api/kpis/:module` (module keys: procurement, grading-extraction, intermediates-blending, packing, qc, control-samples, inventory, packaging-materials, orders-dispatch, shipments). Server folds documents in `src/lib/kpis/`, memoized by revision (ARCHITECTURE §6); heavy folds cached in meta with computed_at. EVERY payload carries `last_updated` + `stale_after`; UI shows STALE past configured age. Dashboards, live reports, and CSV/XLSX/PDF exports all read this one layer. EXISTS = folds from today's collections; NEW = needs ARCHITECTURE §2 delta (cited).

## Procurement
| metric | formula | source / status | refresh | chart |
|---|---|---|---|---|
| PO status funnel | open POs by status Draft→Sent→Received→Closed | NEW — needs `purchase_orders` collection (absent from §2; add) | live | funnel |
| Supplier on-time % | GRN.at ≤ PO.promisedAt ÷ POs due | NEW — purchase_orders + grns | cached+1h | bar per vendor |
| Supplier lead time | avg(PO.sentAt → GRN.at) | NEW — purchase_orders | cached+1h | bar |
| Spend trend | Σ(qty×rate + transport) by month | EXISTS — grns (`src/lib/reports/procurement.ts`) | live | line |
| Pending deliveries calendar | open POs by expected date | NEW — purchase_orders | live | calendar |
| Days-of-stock-left | on-hand(base units) ÷ trailing-30d net consumption | NEW fold — ledger + items.avg_unit_weight/density_kg_per_l (§2) | cached+1h | KPI card + bar |
| Coconut intake by supplier | Σ grades.total by vendorId | EXISTS — grns.grades.total, vendorId | live | stacked bar |

## Grading (module grading-extraction, pt 1)
| metric | formula | source / status | refresh | chart |
|---|---|---|---|---|
| Grade distribution per lot | a/b/c/reject/free ÷ total | EXISTS — grns.grades | live | stacked bar per lot |
| Grade mix trend | grade share by month | EXISTS — grns | live | 100% stacked area |
| Reject % | reject ÷ total | EXISTS — grns.grades.reject (`lotYield.ts`) | live | line + KPI |

## Extraction (module grading-extraction, pt 2)
| metric | formula | source / status | refresh | chart |
|---|---|---|---|---|
| Water & malai yield per 100 nuts vs target | outputL ÷ (inputPieces÷100), vs recipe target | EXISTS yield — batches.outputLines/yieldPerUnit; NEW target — melanges.recipeId/version (§2); base units items.avg_unit_weight (§2) | live | bar + target line |
| Spoilage Pareto (reason / supplier lot / grade) | Σ spoilage qty by reasonCode; batch→lot via sourceLines | NEW — spoilage_records (§2); lots via batches.sourceLines EXISTS | cached+1h | pareto |
| Mass-balance variance % | (Σout_base − Σin_base) ÷ Σin_base, flag > tolerance | NEW — items.avg_unit_weight/density_kg_per_l + meta.massBalanceTolerancePct (§2) | live (at close) | bar vs limit |
| Extraction cycle time | stageTimes.closed − stageTimes.started | NEW — batches.stageTimes (§2) | live | line by week |

## Intermediates & Blending
| metric | formula | source / status | refresh | chart |
|---|---|---|---|---|
| Milk batches (count, L) | batches kind=Melange, intermediate output | EXISTS — batches (`batchWiseRows`) | live | line |
| Recipe vs actual variance | actual inputQty vs recipe share × output | NEW — melanges.recipeId/version (§2) + batches.blendLines EXISTS | live | bar per component |
| Malai/water consumption | Σ inputs to milk+blend batches | EXISTS — batches.blendLines + ledger issues | live | stacked bar |
| Intermediate stock & expiry | Semi Finished balances + expiry | EXISTS — ledger (fgOnHand fold) | live | table + expiry badge |
| Batches by stage | runs in Draft/InProgress/AwaitingQC/Closed | NEW — run state machine + batches.stageTimes (§2/§3) | live | stage tracker |
| Output vs plan | Σ output ÷ production_plans target | EXISTS — batches + production_plans | live | plan-vs-actual bar |

## Packing
| metric | formula | source / status | refresh | chart |
|---|---|---|---|---|
| Throughput per shift | packs ÷ shift | NEW — packing_runs +shiftId (§2 addendum); shifts EXISTS | live | bar by shift |
| Packed vs planned | packing run lines vs plan | EXISTS — packing_runs + production_plans | live | bar |
| Glass vs BIB mix | packs by format | EXISTS — packing_runs PACK_TYPES; normalized by products.packFormat (§2) | live | donut |
| Pack-size mix | packs by SKU size | EXISTS — packs/products; +products.bibSize (§2) | live | donut |
| Rejects & wastage (fill) | fill-stage spoilage qty by reason | EXISTS qty — batches.spoiled/wastage; NEW reasons — spoilage_records stage=fill (§2) | live | pareto |

## QC
| metric | formula | source / status | refresh | chart |
|---|---|---|---|---|
| Pass/fail trend | dispositions by month | EXISTS — qcs (`qualityReport.ts`) | live | line |
| Parameters vs spec limits | result value vs min/target/max over time | NEW — qcs.results numeric limits + test_parameters (§2) | live | control chart |
| Out-of-spec alerts | count outside limits | NEW — same fields (§2) | live | KPI + list |
| Pending queue aging | days since batch made, disposition Pending | EXISTS — qcs + batches.date | live | aging-bucket bar |
| QC turnaround | disposition date − batch made-on | EXISTS — qcs + documents.updated_at (approx) | cached+1h | avg line |
| Quarantine volume | ledger balances status=Quarantine | EXISTS — ledger | live | KPI + trend |

## Control Samples
| metric | formula | source / status | refresh | chart |
|---|---|---|---|---|
| Register by batch | samples per run/batch | EXISTS — packing_runs.controlSamples[] | live | table |
| Retention-expiry timeline | packed + config.controlSampleDays | EXISTS — controlSampleRows | live | timeline |
| Due/expiring ≤7d | days-to-expiry buckets | EXISTS — alerts.ts controlSampleExceptions | live | KPI + list |
| Sample storage bin | bin per sample | NEW — +storageBin on controlSamples (§3.3-7; add to §2) | live | table column |

## Inventory / Storage
| metric | formula | source / status | refresh | chart |
|---|---|---|---|---|
| Stock by category | ledger balances by itemType | EXISTS — ledger | live | treemap |
| Cold-room occupancy heatmap | Σ qty by cold_room location vs capacity | EXISTS balances — ledger + storage_locations.zone (§2); NEW +capacity field (add) | live | heatmap |
| Near-expiry | Released FG ≤ expiryAlertDays | EXISTS — ledger.expiry + config | live | list + KPI |
| Slow-moving | no ledger movement > N days | EXISTS — ledger fold | cached+1d | table |
| Reorder alerts | on-hand < min | EXISTS PM — items.reorder; NEW all items — items.min_stock/max_stock (§2) | live | list + badge |
| Ageing | days-on-hand buckets | EXISTS — lotAgeing (`inventoryReports.ts`) | live | stacked bar |
| Loose BIB stock by size | FG BIB balances by size | NEW — products.bibSize (§2) | live | bar by size |

## Packaging Materials
| metric | formula | source / status | refresh | chart |
|---|---|---|---|---|
| Stock vs min/max | on-hand vs bands | EXISTS reorder — items.reorder; NEW min/max (§2) | live | bullet bar |
| Consumption trend | ledger PM issues by month | EXISTS — ledger (pm report) | live | line |
| Boxed vs loose ratio | BOXED lines ÷ dispatched lines | NEW — customers.dispatchPackaging, orders.lines override, shipments roll-up (§2) | cached+1h | donut trend |
| Per-customer carton use | cartons issued by customer/period | NEW — carton_specs + dispatch confirm lines (§2) | cached+1h | bar per customer |
| Carton reconciliation | issued / used / damaged | NEW — carton ledger lines + spoilage reason damaged (§2) | daily | waterfall |

## Orders & Dispatch
| metric | formula | source / status | refresh | chart |
|---|---|---|---|---|
| Order pipeline | orders by status Open/Partially Dispatched/Dispatched | EXISTS — orders; +Partially Dispatched value (§2) | live | funnel/counts |
| Fulfilment % | dispatched qty ÷ ordered qty | EXISTS — dispatches vs orders lines | live | KPI + trend |
| Overdue orders | open orders past expected date | EXISTS — orders + dispatches times | live | list |
| Dispatch vs plan | dispatched vs production_plans | EXISTS — dispatches + production_plans | live | bar |

## Shipment Tracking
| metric | formula | source / status | refresh | chart |
|---|---|---|---|---|
| Status board | shipments by status (§3 machine) | NEW — shipments (§2) | live | board columns |
| On-time % | delivered ≤ eta | EXISTS seed — dispatches expected vs deliveredTime; full — shipments.eta (§2) | live | KPI + trend |
| Pending / out-for-delivery counts | status counts | NEW — shipments (§2) | live | KPI + sidebar badge |
| Avg delivery time | times.delivered − times.dispatched | NEW — shipments.times (§2) | cached+1h | line by agent |
| Failed/returned reasons | delivery_events type=failed/rescheduled + returns reasons | NEW — delivery_events, returns (§2) | live | pareto |
| Agent performance / deliveries by agent | on-time %, volume by agentUserId | NEW — shipments.agentUserId (§2) | daily | bar per agent |
| Challan register | challans by series/FY/version | EXISTS ref — dispatches.challan + counters; full — challans (§2) | live | table |
| BIB/carton returns | return lines by packaging type | NEW — returns (§2) | live | bar |

OPEN ITEMS for ARCHITECT follow-up (schema additions this catalog needs beyond published §2): `purchase_orders` collection; packing_runs +shiftId; controlSamples +storageBin; storage_locations +capacity.
DECIDED 2026-10-13 (LEAD): the four `purchase_orders`-dependent Procurement KPIs (funnel, supplier on-time, lead time, deliveries calendar) are KEPT and blocked on the `purchase_orders` entity + a PO form — the PO form is added to WORKFLOW's stage forms (Receipt stage). No PO form ships, no PO numbers.
