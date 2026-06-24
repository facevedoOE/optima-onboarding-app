# Deploying Optima Onboarding to Azure App Service (LIVE mode)

This app runs in **DEMO** mode with zero config (local role-picker, stubbed
Graph/email). To go **LIVE** — real Microsoft sign-in, real account
provisioning, real email, PDFs filed to SharePoint — you need (1) an Entra app
registration with admin-consented Graph permissions, and (2) an HTTPS host.
This runbook covers both, end to end.

---

## Part 1 — Create the Entra app registration

Do this in the **Microsoft Entra admin center** (entra.microsoft.com) or the
Azure portal → *Microsoft Entra ID*. You need a role that can register apps and
grant admin consent (Global Admin or Cloud Application Admin) — if you don't
have that, this part goes to Marvin/IT.

1. **Entra ID → App registrations → New registration.**
   - **Name:** `Optima Onboarding`
   - **Supported account types:** *Accounts in this organizational directory only* (single tenant).
   - **Redirect URI:** platform **Web**, value `https://<your-app-url>/auth/callback`
     (you can set a placeholder now and update it after the App Service exists in Part 2).
   - Click **Register**.

2. **Copy the IDs** from the app's **Overview** page:
   - **Application (client) ID** → this is `CLIENT_ID`
   - **Directory (tenant) ID** → this is `TENANT_ID`

3. **Create a client secret** — *Certificates & secrets → Client secrets → New client secret.*
   - Description `onboarding-app`, expiry 6–24 months.
   - **Copy the secret VALUE immediately** (not the Secret ID) → this is `CLIENT_SECRET`.
     It is shown only once.

4. **Add Graph application permissions** — *API permissions → Add a permission →
   Microsoft Graph → Application permissions.* Add:
   | Permission | Why | Required? |
   |---|---|---|
   | `User.ReadWrite.All` | create new-hire accounts | yes |
   | `Group.ReadWrite.All` | add accounts to access groups | yes |
   | `Mail.Send` | send onboarding / owner-notify email | yes |
   | `Sites.Selected` | file completed PDFs to the HR SharePoint site | **OPTIONAL** — skip for now |

5. **Grant admin consent** — on the API permissions page click
   **“Grant admin consent for <tenant>.”** They should show green
   “Granted.” *(Application permissions do nothing until consented.)*

6. **(OPTIONAL — SharePoint) Scope `Sites.Selected` to just the HR site.**
   **You can skip this entirely.** Completed PDFs are always stored in the app
   and are viewable/downloadable per candidate; SharePoint is only an *extra*
   copy to the HR library. Account creation, group membership, and the
   owner-notify email do **not** need it. When you do want it later: add the
   `Sites.Selected` permission (admin consent), then grant the app `write` on the
   one HR site via Graph `POST /sites/{id}/permissions`, and set `SP_SITE_ID`.
   With `SP_SITE_ID` blank, the app cleanly skips filing (no errors).

   **Catching up the backlog:** live filing is *go-forward only*. If you enable
   SharePoint after candidates have already completed forms, run the one-time
   backfill to push the existing PDFs into the library too (history, not just new):
   ```bash
   npm run backfill:sharepoint -- --dry   # preview what would file, file nothing
   npm run backfill:sharepoint            # file every retained PDF to SharePoint
   ```
   It reads the same data layer + adapter as live filing, is safe to re-run
   (re-files overwrite the same path), and skips any submission whose PDF is no
   longer on disk. (Requires `SP_SITE_ID` set + live mode, or it exits early.)

> Result of Part 1 (without SharePoint): **TENANT_ID, CLIENT_ID, CLIENT_SECRET** — three values, one admin-consent pass on three permissions.

---

## Part 2 — Azure App Service

### 2a. Create the Web App
- Azure portal → **App Services → Create**.
- **Publish:** Code · **Runtime stack:** **Node 20 LTS** · **OS:** Linux.
- Pick a name → its URL is `https://<name>.azurewebsites.net` (this is your `APP_BASE_URL`,
  unless you map a custom domain like `https://onboarding.optimaed.com`).
- **Configuration → General settings:** Startup Command `npm start`, **HTTPS Only = On**.
- **Configuration → General settings → ARR affinity = On** (sessions + the JSON
  store are file-based, so keep it to a **single instance** / sticky — see Data note below).

### 2b. Application settings (env vars — NOT a committed .env)
Set these under **Configuration → Application settings** (they map 1:1 to the
`.env` template in this repo). Do **not** deploy a real `.env` to the server:

| Setting | Value |
|---|---|
| `TENANT_ID` | from Part 1 |
| `CLIENT_ID` | from Part 1 |
| `CLIENT_SECRET` | from Part 1 |
| `APP_BASE_URL` | `https://<name>.azurewebsites.net` (your real HTTPS URL) |
| `SESSION_SECRET` | strong random — already generated in your local `.env`, or `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `REFERENCE_WEBHOOK_SECRET` | strong random (already generated locally) |
| `MAIL_DOMAIN` | `optimaed.com` |
| `MAIL_FROM` | `hr@optimaed.com` |
| `SP_SITE_ID` | from Part 1 (optional until PDF filing is needed) |
| `REFERENCE_FORM_URL` | Adobe Sign widget URL (optional) |

> Live mode **refuses to start** if `APP_BASE_URL` is missing/localhost or if
> `SESSION_SECRET` is the default — that's an intentional guard.

### 2c. Point the Entra redirect URI at the real URL
Back in the app registration (Part 1.1), set the Web redirect URI to exactly
`https://<name>.azurewebsites.net/auth/callback`.

### 2d. Deploy the code
From this `app/` directory, the simplest one-shot:
```bash
az webapp up --name <name> --resource-group <rg> --runtime "NODE:20-lts"
```
Or zip-deploy / a GitHub Actions workflow targeting the Web App. `node_modules`
is gitignored; App Service runs `npm install` on deploy (Oryx build).

### 2e. Seed the reference data (once, after first deploy)
The data store ships empty (no demo candidates in live). Load the **real** form
definitions + access catalog (NOT demo candidates) via SSH/console on the app:
```bash
npm run seed:config     # 12 form definitions, 5 access roles — idempotent, never wipes data
```
(`npm run seed` would load demo candidates too — do **not** run that in live.)

### 2f. Smoke test
- Visit `https://<name>.azurewebsites.net` → you should get the **Microsoft sign-in**
  (not the demo role-picker). If you still see the role-picker, the three Entra
  vars aren't all set.
- Sign in → create a candidate → file a Request to Hire → confirm the owner-notify
  email actually arrives.

---

## Data persistence note (important)
Storage today is a JSON file (`data/store.json`) + file-based sessions, under
`/home/site/wwwroot` which **persists** on App Service — but only safely on a
**single instance**. Do **not** scale out to multiple instances without first
moving the data layer (everything is behind `src/db.js`, by design) to a shared
store (Azure SQL / Cosmos / Table). For one-instance HR use this is fine; flag
it before scaling.

## Rollback / mode flip
Removing (or blanking) `TENANT_ID`/`CLIENT_ID`/`CLIENT_SECRET` drops the app back
to DEMO mode on restart — handy for a safe staging slot.
