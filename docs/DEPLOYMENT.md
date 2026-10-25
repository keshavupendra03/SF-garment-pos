# Garment POS — Deployment Guide

How to deploy the Garment POS app into a new Salesforce org (scratch org, Developer Edition, Sandbox or a client's Production org) and give a user full access, using the one-command script.

**Script:** `scripts\deploy\Deploy-GarmentPOS.ps1`
**Permission set it assigns:** `Garment_POS_Full_Access` (label *Garment POS - Full Access*)
**Run from:** the project folder (the one containing `sfdx-project.json`)

---

## 1. What the script does

One command runs eight stages in order and stops at the first problem. Every stage prints `OK` / `FAIL`, and a full log is saved in the `logs\` folder.

| Stage | What happens | Changes the org? |
|---|---|---|
| 1/8 Pre-flight | Checks the Salesforce CLI, the project folder, the org login, the org type, and that the target user exists, is active and has a licence | No |
| 2/8 Validate | Dry-run deploy of the whole app in one payload | No |
| 3/8 Deploy | The real deploy (objects, fields, Apex, LWC, app, tabs, receipt page, permission set) | Yes |
| 4/8 Permissions | Assigns *Garment POS - Full Access* to the target user, any extra users, and you (the deploying admin). Already assigned counts as success | Yes |
| 5/8 Store | Creates the POS Store record (holds settings, bills, customers, credit notes) and applies any shop details you passed | Yes |
| 6/8 Sample data | Loads a demo garment catalog, only with `-WithSampleProducts` | Only if asked |
| 7/8 Apex tests | Runs all of the project's test classes in the org | No |
| 8/8 Smoke test | Makes a real bill, saves it, returns an item, issues a credit note, checks stock — then rolls everything back | No (nothing is kept) |

The script is **safe to re-run** on the same org. Re-running updates the app and keeps all existing bills, customers and products.

> **Why tests run after the deploy (stage 7) and not during it:** a brand-new org has no field access for this app until the permission set exists and is assigned, so tests are skipped inside the deploy (`NoTestRun`) and run separately once access is in place. On a **Production** org Salesforce does not allow `NoTestRun`; the script detects Production and runs this project's own tests inside the deploy instead (they do not depend on field access). Production also needs `-AllowProduction` (see section 7).

---

## 2. One-time setup (once per computer)

1. **Salesforce CLI** — install from https://developer.salesforce.com/tools/salesforcecli, then check in a terminal:
   ```powershell
   sf --version
   ```
2. **VS Code** with the **Salesforce Extension Pack** (optional but convenient for logging in to orgs).
3. **Project folder** — have this project on your machine and open it in VS Code. All commands below run from this folder.

---

## 3. Deploy to a new org — step by step

### Step 1 — Get the org

Pick one:

- **Developer Edition (free, permanent):** sign up at https://developer.salesforce.com/signup. Good for demos and small shops trying the app.
- **Scratch org (temporary, for testing):** needs a Dev Hub.
  1. In a Developer Edition or production org: *Setup → Dev Hub → Enable Dev Hub*.
  2. Log in to the Dev Hub once:
     ```powershell
     sf org login web --set-default-dev-hub --alias devhub
     ```
  3. Create the scratch org (the definition file is in this project):
     ```powershell
     sf org create scratch --definition-file config\project-scratch-def.json --alias posscratch --duration-days 30 --target-dev-hub devhub
     ```
     The scratch org is logged in automatically under the alias `posscratch`, so you can skip Step 3.
     **Scratch orgs are deleted when they expire (30 days max), including all data.** Never use one for a real shop.
- **Sandbox or Production (a client's org):** get the login URL and an admin login from the client. Sandbox logins use `https://test.salesforce.com`.

### Step 2 — Create the end user

The person who will use the POS needs their own user.

**From Setup:** *Setup → Users → Users → New User*

| Field | What to enter |
|---|---|
| First / Last name, Email | The shop owner or cashier |
| Username | Must look like an email and be unique across all of Salesforce, e.g. `owner@keshavgarments.pos` |
| User License | **Salesforce** or **Salesforce Platform** |
| Profile | **Standard User** (or **Standard Platform User** with a Platform licence) |

Tick *Generate new password and notify user immediately* and save. The user activates their login from the email.

**In a scratch org, from the terminal instead:**
```powershell
sf org create user --target-org posscratch username=owner@keshavgarments.pos email=you@example.com profileName="Standard User"
sf org generate password --target-org posscratch --on-behalf-of owner@keshavgarments.pos
```

> Developer Edition orgs include only a few user licences (check *Setup → Company Information → User Licenses*). Your own admin login uses one of them.

### Step 3 — Log the CLI in to the org

**Option A — VS Code:** open the Command Palette (`Ctrl+Shift+P`) → **SFDX: Authorize an Org** → choose *Production* (login.salesforce.com) or *Sandbox* (test.salesforce.com) → enter an alias such as `shop01` → log in as the org's **admin** in the browser and click *Allow*.

**Option B — terminal:**
```powershell
sf org login web --alias shop01 --instance-url https://login.salesforce.com
```
(use `https://test.salesforce.com` for a Sandbox)

Check you are connected to the right org before deploying:
```powershell
sf org display --target-org shop01
```
Look at **Org Id**, **Username** and **Instance Url**.

> Log in as an **admin**, not as the end user. The script uses this login to deploy and to assign permissions.

### Step 4 — Run the script

From the project folder in the VS Code terminal:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\deploy\Deploy-GarmentPOS.ps1" -TargetOrg shop01 -TargetUsername owner@keshavgarments.pos
```

Replace:
- `shop01` with the alias you used in Step 3
- `owner@keshavgarments.pos` with the username you created in Step 2

**With the shop's details and a demo catalog in one go:**
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\deploy\Deploy-GarmentPOS.ps1" -TargetOrg shop01 -TargetUsername owner@keshavgarments.pos -StoreName "Keshav Garments" -StorePhone 9876500000 -StoreGstin 08ABCDE1234F1Z5 -StoreAddress "Shop 12, MG Road, Jaipur" -WithSampleProducts
```

**Several staff users at once:**
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\deploy\Deploy-GarmentPOS.ps1" -TargetOrg shop01 -TargetUsername owner@keshavgarments.pos -AdditionalUsernames cashier1@keshavgarments.pos,cashier2@keshavgarments.pos
```

**Just check, change nothing:**
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\scripts\deploy\Deploy-GarmentPOS.ps1" -TargetOrg shop01 -TargetUsername owner@keshavgarments.pos -ValidateOnly
```

A full run takes about 5–10 minutes.

### Step 5 — Read the result

A successful run ends with:

```
SUMMARY
  Pre-flight     PASSED   Developer Edition org, 2 user(s) checked
  Validate       PASSED   61 components
  Deploy         PASSED   61 components
  Permissions    PASSED   assigned to owner@keshavgarments.pos, admin@...
  Store          PASSED   Keshav Garments (a0H...)
  Sample data    SKIPPED  not requested
  Apex tests     PASSED   20 passed, 0 failed
  Smoke test     PASSED   bill + return + credit note OK

DEPLOYMENT COMPLETE
```

If any stage shows `FAILED`, read the red `FAIL` lines just above the summary, fix the cause (see section 8), and run the same command again.

The log of every run is saved as `logs\deploy-<alias>-<date-time>.log`. Keep it with the client's records.

---

## 4. After the script — manual steps

These cannot be scripted. Do them once per org.

1. **Log in as the end user.** *App Launcher (9 dots) → Garment POS → POS Billing.* You should see the tabs Billing · Bills · Products · Customers · Settings.
2. **Make Garment POS the default app** (so it opens straight away): *Setup → App Manager → Garment POS → Edit → User Profiles* → add the user's profile. Users can also pin it from the App Launcher.
3. **Shop settings** — in the app, *Settings tab*:
   - Shop details: name, phone, GSTIN, address, receipt footer (the receipt preview updates as you type).
   - Billing & GST: bill prefix, GST slabs, loyalty points, **shop time zone** (India by default), **return window**.
4. **Products** — *Products tab → New style* to add garments (sizes × colours, barcodes generated automatically), or load products in bulk with Data Import Wizard / Data Loader into **POS Product**.
5. **Phone setup** (each phone that will bill):
   1. Install the **Salesforce** app (Play Store / App Store) and log in as the end user. Garment POS appears in the app menu.
   2. **Printer (Android):** install **RawBT**, pair the Bluetooth printer (PIN usually `0000` or `1234`), in RawBT pick Bluetooth → the printer → ESC/POS → 58 mm. Then in the POS: *Settings → Receipt printer → Bluetooth printer → Print test page*.
   3. Keep **Barcode format** on *Standard (printed as image)* for RPD-588 and similar portable printers.
   4. **iPhone:** only printers with Bluetooth Low Energy work; until then use *Receipt page* and share it.
6. **Test once through the real screens:** sell 2 items with a customer mobile → print → scan the receipt barcode in Billing → return one item as an exchange → check the Bills tab.
7. **Optional branding:** *Setup → Themes and Branding* (logo, colours) and *App Manager → Garment POS → Edit* (app colour/logo).

---

## 5. Updating an org that already has the app

Run the **same command** again with the same alias and username. The script redeploys the latest code, re-checks permissions, re-runs tests and the smoke test. Bills, customers, credit notes, products and settings are kept.

---

## 6. Script parameters

| Parameter | Required | Meaning |
|---|---|---|
| `-TargetOrg` | Yes | Alias (or username) of the logged-in org |
| `-TargetUsername` | Yes | End user who gets full access |
| `-AdditionalUsernames` | No | More users, comma separated |
| `-SkipAdminAssignment` | No | Don't give the deploying admin access |
| `-StoreName`, `-StorePhone`, `-StoreGstin`, `-StoreAddress` | No | Shop details for the receipt (editable later in Settings) |
| `-WithSampleProducts` | No | Load the demo catalog (39 garment SKUs) |
| `-ValidateOnly` | No | Pre-flight + dry run only; nothing changes |
| `-SkipTests` | No | Skip stage 7 (not recommended) |
| `-AllowProduction` | Only for Production | Confirms you really mean to deploy to a live Production org |

---

## 7. Production orgs

- The script refuses a Production org unless you add `-AllowProduction`.
- In Production the project's tests run inside the deploy (Salesforce requires it) and must pass with at least 75% code coverage. They currently cover 88–100% of each class.
- Run `-ValidateOnly` first, ideally outside shop hours.

---

## 8. Troubleshooting

| Message | Cause | Fix |
|---|---|---|
| `Salesforce CLI (sf) is not installed` | CLI missing or terminal opened before install | Install the CLI, reopen VS Code |
| `Org 'xyz' is not authenticated` / status `Expired` | Not logged in, or login expired | `sf org login web --alias xyz` and re-run |
| `User '...' was not found in this org` | Username typo, or user not created yet | Check *Setup → Users*; usernames must match exactly |
| `User '...' is inactive` | User deactivated | Activate the user |
| `Licence ... may not allow custom apps` (warning) | User has e.g. a Chatter licence | Use a Salesforce or Salesforce Platform licence |
| `GSTIN ... is not valid` | Wrong format | 15 characters, e.g. `08ABCDE1234F1Z5`, or leave it out and set it in the app |
| `This is a PRODUCTION org` | Safety stop | Add `-AllowProduction` if intended |
| `Network problem ... Retrying` (yellow) | Internet dropped | The script retries 3 times; if it still fails, check the connection and re-run |
| Validate/Deploy `FAIL` with a component name | Org is missing a feature, or a name clashes with something already in the org | Read the component and problem shown; fix in the org or project, re-run |
| `Tests failed` | Real bug, or the org has data/rules that break the code (e.g. a validation rule) | The failing test and message are printed above; fix and re-run |
| `Smoke test ... failed` | Usually a validation rule/flow in the client org blocking POS records | The message names the check that failed |
| End user sees no Garment POS app | Permission set not assigned to them | Re-run with their username, or assign *Garment POS - Full Access* in *Setup → Users* |

---

## 9. Rules when the app changes

- **Anything new goes into the permission set.** A new object, field, Apex class, tab or Visualforce page must be added to `force-app\main\default\permissionsets\Garment_POS_Full_Access.permissionset-meta.xml`, otherwise it silently fails for every end user.
- **Test classes are picked up automatically.** Any class named `*Test` is run in stage 7 (and in Production deploys).
- **Keep the smoke test meaningful.** If billing or returns change shape, update `scripts\apex\smoke-test.apex` so stage 8 still exercises the real flow.

---

## 10. Quick checklist (per org)

- [ ] Org created (Developer / scratch / sandbox / production)
- [ ] End user created with a Salesforce or Salesforce Platform licence
- [ ] CLI logged in as admin (`sf org display` shows the right org)
- [ ] Script run → all stages `PASSED`
- [ ] End user can open *Garment POS → POS Billing*
- [ ] Shop details, GST, time zone and return window set in *Settings*
- [ ] Products added
- [ ] Phone: Salesforce app + RawBT + printer test page
- [ ] One real sale, receipt scan, and return tested
- [ ] Log file saved with the client's records
