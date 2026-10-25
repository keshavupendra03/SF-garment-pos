# Garment POS on Salesforce (LWC + JSON attachments)

Billing app for a garment shop, built for a Developer Edition org (5 MB data / 20 MB file storage).
Low-volume master data lives in records; high-volume data lives in JSON files stored as Attachments,
so it counts against the 20 MB file storage instead of the 5 MB data storage.

## Where data lives

| Data | Storage | Why |
|---|---|---|
| Products (one record per SKU) | `POS_Product__c` records | Limited count, needs list views and editing |
| Store settings, bill counter | one `POS_Store__c` record | Its row lock serializes all writes |
| Bills | Attachment `B-yyyyMMdd.ndjson` on the store record | One file per day, one bill per line, append-only |
| Customers | Attachment `C-<last digit of mobile>.json` | 10 shards keep each file small; lookup reads one shard |

Every bill save runs in one Apex transaction holding a `FOR UPDATE` lock on the store record:
bill number, stock decrement, day-file append and customer update either all commit or all roll back,
and two counters saving at once are serialized instead of overwriting each other.

## JSON formats

Bill (one line in `B-yyyyMMdd.ndjson`):

```json
{"no":"INV-000042","dt":"2026-10-24","tm":"18:05","ts":1792845900000,"by":"Cashier Name",
 "cu":{"m":"9876543210","n":"Ravi"},
 "l":[{"id":"a01...","s":"TSH-BLA-M","n":"Round Neck T-Shirt","z":"M","c":"Black","h":"6109",
       "q":2,"p":499,"dp":0,"ld":0,"bs":0,"net":998,"r":5,"tx":47.52}],
 "sub":998,"ld":0,"bd":0,"dis":0,"tx":47.52,"ro":0,"g":998,
 "pay":[{"m":"CASH","a":1000}],"chg":2,"due":0,"pts":9}
```

`l` = lines (`q` qty, `p` GST-inclusive price, `dp` item discount %, `ld` item discount, `bs` share of bill
discount, `r` GST rate, `tx` GST in the line). Totals: `sub` gross, `dis` total discount, `tx` GST,
`ro` round off, `g` grand total, `chg` change returned, `due` amount on credit, `pts` loyalty points earned.

Customer shard (`C-0.json`):

```json
{"9876543210":{"n":"Ravi","v":3,"s":5120,"pt":51,"du":0,"f":"2026-10-01","l":"2026-10-24"}}
```

`v` visits, `s` total spent, `pt` points, `du` credit due, `f`/`l` first/last visit.

## GST

Prices are GST inclusive. For each line the per-piece taxable value (after discounts, excluding GST) picks
the slab: up to `Tax_Threshold__c` → `Tax_Rate_Low__c`, otherwise `Tax_Rate_High__c` (defaults 2500 / 5% / 18%).
Change them on the POS Store record. Receipts show CGST/SGST split per rate (intra-state).

## Deploy

```powershell
sf org login web --alias posdev --instance-url https://login.salesforce.com
sf project deploy start --target-org posdev
sf org assign permset --name POS_User --target-org posdev
sf apex run --file scripts/apex/seed.apex --target-org posdev   # optional sample catalog
sf apex run test --class-names PosControllerTest --result-format human --target-org posdev
```

Then open the **Garment POS** app → **POS Billing** tab.
