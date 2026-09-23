# Zia prompts — Creator form build sheet

Creator's builder has AI assistance (Zia, rolled out Apr 2024): **New Form → describe it**, and Zia generates the form with fields. Paste one prompt per form, review what it produces against the line below it (Zia guesses types — fix any it gets wrong), wire lookups if it didn't, save. Then say "done" — each form gets verified via metadata reads and seeded through the data API.

Order matters (lookups need their target form to exist). Forms 1–15 are masters, 16–30 transactional. Field names are **exact** — the seeds and the posting engine reference them.

## Phase M — masters

1. **Vendor Type** — *already created; needs its 3 fields*
   Fields: Name (single line) · Source Kind (dropdown: Farmer, Vendor, Other) · Description (multi line) · Status (dropdown: Active, Inactive)

2. **Vendors**
   > Create a vendor register form. Fields: Name (single line), Vendor Type (lookup to the Vendor Type form showing Name), Phone, Area, Payment Terms, Status (dropdown: Active, Inactive), Email (email), Notes (multi line).

3. **Customers**
   > Create a customer register form. Fields: Name (single line), Ship To (single line), GSTIN (single line), Status (dropdown: Active, Inactive), Phone, Email (email), Contact Person, Notes (multi line).

4. **Items**
   > Create an inventory item master. Fields: Name (single line), Type (dropdown: Raw Material, Semi Finished, Packing Material, Finished Goods), UOM (dropdown: Piece, Kg, Litre, Pack, Bottle), Lot Controlled (decision box, default checked), Reorder Level (number), Cost Method (dropdown: Lot Actual, Batch Actual, By-product, Weighted Avg).

5. **Purchase Products**
   > Create a form for products that may be purchased. Fields: Name (single line), Item (lookup to Items form showing Name), Default UOM (single line), Linked Vendors (lookup to Vendors form showing Name, multi-select if offered).

6. **Storage Locations**
   > Create a storage location master. Fields: Name (single line), Label (single line), Holds (multi line), Type (dropdown: Cold Room, Dry Store, Hold Area), Status (dropdown: Active, Inactive).

7. **Test Categories**
   > Create a lab test category master. Fields: Title (single line), Format (dropdown: Results, Scored), Required for Release (decision box, default checked), Pass Score (number), Minor Score (number), Signatory (single line), Status (dropdown: Active, Inactive).

8. **Test Parameters**
   > Create a test parameter master. Fields: Name (single line, e.g. Salmonella spp), Category (lookup to Test Categories showing Title), Method (single line, IS/ISO ref), Unit (single line, e.g. Cfu/mL).

9. **Products**
   > Create a pack product (SKU) master. Fields: Name (single line), Format (single line, e.g. BiB), Size (decimal), Unit (single line, e.g. L), Pack Volume (decimal), Shelf Life Days (number), Chilled Shelf Life Days (number), MRP (currency INR), Bulk Item (lookup to Items showing Name), Medium (dropdown: Water, Malai).
   Then add a **subform BOM Lines** with fields: Item (lookup to Items), Qty per Pack (number).

10. **BOM Lines** — if Creator prefers a standalone form over a subform: Item (lookup to Items), Product (lookup to Products), Qty per Pack (number).

11. **Melanges**
    > Create a recipe master for melange blends. Fields: Name (single line), Status (dropdown: Active, Inactive), Output Item (lookup to Items showing Name).
    Then add a **subform Components**: Item (lookup to Items), Share (decimal, percentages summing to 100).

12. **Melange Components** — standalone variant: Melange (lookup to Melanges), Item (lookup to Items), Share (decimal).

13. **Counters**
    > Create a document numbering counter table. Fields: Series (single line), Prefix (single line), Pattern (single line, e.g. {P}-{YYYY}-{N}), Pad (number), Next (number). One row per series; nothing but the posting engine writes Next.

14. **Config**
    > Create a settings form. Fields: Setting (single line), Value (single line), Notes (single line).

15. **Staff**
    > Create an operators register. Fields: Staff No (single line), Name (single line), Role (single line), Phone (phone), Status (dropdown: Active, Inactive), Added On (date).

## Phase T — transactional

16. **GRNs**
    > Create a goods receipt note form. Fields: Doc No (single line), Date (date), Product (lookup to Purchase Products), UOM (single line), Location (lookup to Storage Locations), Vendor (lookup to Vendors), Area (single line), Harvested On (date), Total / Accepted / Free (numbers), Grade A / Grade B / Grade C / Reject (numbers), Rate (currency INR), Other Charges (currency INR), Status (dropdown: Draft, Posted), Notes (multi line).

17. **Batches**
    > Create a production batch form. Fields: Batch No (single line), Date (date), Kind (dropdown: Extraction, Melange), Location (lookup to Storage Locations), Spoiled (number), Cost per Unit (currency INR), Status (dropdown: Awaiting QC, Released, On Hold, Rejected), Data JSON (multi line).

18. **Packing Runs**
    > Create a packing run form. Fields: Run No (single line), Date (date), Batch (lookup to Batches), Bulk Item (lookup to Items), Drawn (number), Location (lookup to Storage Locations), Status (dropdown: Draft, Posted), Data JSON (multi line).

19. **QC Records**
    > Create a quality control record form. Fields: Doc No (single line), Batch (lookup to Batches), Item (lookup to Items), Disposition (dropdown: Awaiting, Released, On Hold, Rejected), Tests JSON (multi line), Attachments (file upload).

20. **Lab Reports**
    > Create a lab report form. Fields: Report No (single line), Category (lookup to Test Categories), Batch (lookup to Batches), Sample Date (date), Customer (lookup to Customers), Issue Date (date), Scores JSON (multi line), Decision (single line), Attachment (file upload).

21. **Orders**
    > Create a customer order form. Fields: Order No (single line), Customer (lookup to Customers), Date (date), Status (dropdown: Open, Dispatched, Cancelled), Notes (multi line).

22. **Order Lines** *(child form — the demand feature sums it)*
    > Create an order line form. Fields: Order (lookup to Orders), SKU (lookup to Products), Qty (number).

23. **Dispatches**
    > Create a dispatch form. Fields: Challan No (single line), Date (date), Customer (lookup to Customers), SKU (lookup to Products), Batch (lookup to Batches), Location (lookup to Storage Locations), Expiry (date), Qty (number), Vehicle (single line), Status (dropdown: Dispatched, In Transit, Delivered), POD (file upload).

24. **Stock Issues**
    > Create a stock issue form. Fields: Doc No (single line), Date (date), Reason (dropdown: Spoilage, Sample, Internal Use, Return to Vendor, Other), Issued To (single line), Lines JSON (multi line), Value (currency INR).

25. **Production Plans**
    > Create a production plan form. Fields: Plan No (single line), Day (date), Stage (dropdown: Extraction, Melange, Packing), Product (single line), Qty (number), UOM (dropdown: Litre, Kg, Packs), Note (multi line), Status (dropdown: Planned, In progress, Done, Cancelled).

26. **Shifts**
    > Create a staff shift roster form. Fields: Key (single line, format STAFFID|DATE), Staff (lookup to Staff), Date (date), Shift (dropdown: Morning, Evening, General), Line (single line), Note (multi line).

27. **Attendance**
    > Create a daily attendance form. Fields: Key (single line, format STAFFID|DATE), Staff (lookup to Staff), Date (date), Status (dropdown: Present, Absent, Leave, Half day), Note (multi line).

28. **Ledger** *(append-only — nothing may edit or delete rows)*
    > Create a stock ledger form. Fields: Doc (single line), Type (single line), Item (lookup to Items), Lot (single line), Location (lookup to Storage Locations), Status (single line), Qty In (number), Qty Out (number), Unit Cost (currency INR), Expiry (date), Time (date-time), Data JSON (multi line).

29. **Audit Log**
    > Create an audit log form. Fields: Doc (single line), Action (single line), Details (multi line), Actor (single line), Time (date-time).

30. **Sticker Templates**
    > Create a sticker template form. Fields: Name (single line), Stage (dropdown: Extraction, Melange, Packing, Dispatch), Template JSON (multi line).

---

**After each form (or batch):** say "done" — each form is verified by metadata read, then seeded (masters) through the API. Vendor Type's two seed rows (Farmer, Vendor) go in the moment its fields exist.
