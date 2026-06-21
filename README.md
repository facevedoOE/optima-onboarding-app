# Optima Onboarding — Web App (working prototype)

A web-app replacement for the Adobe-forms + SharePoint-lists + Power-Automate
onboarding stack. Built to fix the three pains that triggered this project:

| Old pain | How this fixes it |
|---|---|
| SharePoint lists weren't a great home for the data | One candidate-centric data model with **stable IDs** (no more name-matching) |
| Changing an Adobe form = delete/recreate forms, re-link, edit Word→PDF, fix the flow | **Forms are data.** Add a field or a whole new form in the Form Builder — it appears instantly in the live form *and* the generated PDF |
| The Request-to-Hire Excel has too many columns to make sense | RTH is now **role-based**: pick a role → sensible default access bundle → adjust. Items route to their owning department automatically |

## Run it

```bash
cd app
npm install
npm start          # http://localhost:4000  (auto-seeds on first run)
npm run seed       # optional: reset to clean demo data
```

## What's inside

```
app/
  server.js                    Express server + SPA host
  src/
    config.js                  Demo-vs-live switch (driven by env credentials)
    auth.js                    Admin Entra SSO + candidate magic-link tokens; admin/candidate guards
    db.js                      Data layer (JSON file today; swap for SQL/Dataverse later)
    seed.js                    Form definitions translated from the 13 live flows + access catalog/roles
    pdf.js                     Completed-PDF generation from form schema + data
    routes/api.js              REST API (candidates, forms, submissions, RTH) — auth-protected
    adapters/graph-client.js   App-only Microsoft Graph token + REST helpers
    adapters/integrations.js   THE M365 SEAM — SharePoint / Graph / email (real in live, logged in demo)
  public/                      Branded single-page front end (vanilla JS, no build step)
  .env.example                 Copy to .env to go live
  data/                        Generated store + PDFs (gitignored)
```

## Two audiences, two sign-ins, one wall

- **Admin / staff** — the dashboard, form builder, RTH and provisioning.
  Sign-in: Microsoft (Entra) SSO in live; one-click in demo. Approver rights
  (HR / Finance / CEO, used to gate RTH signature steps) come from Entra group
  membership in live.
- **Candidate** (new hire) — their own **portal** only: the welcome page, their
  personalized checklist, and inline forms. Sign-in: a **signed magic link**
  emailed to them (no Optima account needed — accounts don't exist yet at hire
  time). In demo, pick a candidate to enter as.

The wall is enforced server-side: candidate sessions are scoped to their own
record, and every admin route requires the admin role (a candidate gets `403`).
The candidate portal *is* the old landing page — now authenticated, personalized,
and feeding submissions straight into the candidate record.

## Two modes

The app decides its mode from the environment — no code change:

- **demo** (default, no credentials): the sign-ins above are simulated; SharePoint/Graph/email
  calls are recorded on the candidate activity trail. Runs anywhere.
- **live** (`TENANT_ID` + `CLIENT_ID` + `CLIENT_SECRET` set): real Microsoft (Entra) sign-in
  and real Microsoft Graph calls.

Everything that touches the tenant is implemented for real in `src/adapters/integrations.js`
and `src/auth.js` — going live is configuration, not a rewrite.

## The key idea: schema-driven forms

A form is just a definition like:

```js
{ key: 'clearinghouse', title: 'Clearinghouse Background Screening', appliesTo: 'oao',
  fields: [ { key: 'legalFirstName', label: 'Legal First Name', type: 'text', required: true }, … ] }
```

One renderer draws any form from its fields. One PDF generator turns any submission
into a branded, completed PDF. So **the document always follows the form** — you never
edit a Word doc and re-export a PDF again. The new CCPS revision is a definition edit.

`appliesTo` drives the per-candidate checklist automatically:
`all` · `oao` · `oao-fulltime` · `oao-contractor`.

## Request to Hire

- **Signature chain** (HR → Finance → CEO) replaces the sequential Adobe Sign
  "RTH_Leadership" agreement. Sequential gating is enforced server-side.
- On full approval the signed PDF is generated automatically.
- **Access** is a role → default bundle, with each item tagged to an owning
  department (IT / Finance / Marketing / Academic). This is the readable
  replacement for the 30-column spreadsheet, and it means routing lives in
  **data**, not hardcoded in a flow's filter expressions.
- Provisioning is locked until all signatures are in.

## Going live against your tenant

The real Graph + Entra code is already written. To turn it on:

1. **Register an app** in Entra (Azure AD):
   - Add a **Web** redirect URI: `{APP_BASE_URL}/auth/callback`.
   - Create a **client secret**.
   - Grant these **application** Graph permissions + admin-consent (least privilege):
     - `Sites.Selected` (scoped to ONLY the HR site) — file PDFs
     - `User.ReadWrite.All` — create accounts
     - `Group.ReadWrite.All` — group membership
     - `Mail.Send` — notifications
2. **`cp .env.example .env`** and fill in `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`,
   `SP_SITE_ID`, `APP_BASE_URL`, `SESSION_SECRET`.
3. `npm start` — it logs `🔐 LIVE mode`. Sign-in is now Microsoft; PDFs file to the
   real HR site; provisioning calls Graph.

What each adapter does in live mode (`src/adapters/integrations.js`):

- `sharepoint.fileDocument` → `PUT /sites/{id}/drive/root:/{path}:/content`
- `graph.createAccount` → `POST /users` (temp password, force reset)
- `graph.provisionAccess` → group membership / license assignment (per-item `groupId`/`skuId`)
- `notify.email` → `POST /users/{from}/sendMail`

**Provisioning guardrails** (Marvin): the signature chain is the approval gate —
`provisionAccess` is unreachable until the RTH is fully approved. Use a dedicated
least-privilege service principal, and note every action is written to the candidate
activity trail as the audit record. The app→Entra-group/license mapping is the one
org-specific thing left to wire (each access item takes a `groupId` and/or `skuId`).

The data layer (`src/db.js`) is the other swap point: reimplement the same handful
of functions against SQL or Dataverse and nothing else in the app changes.

## Deploying to Azure App Service

This runs as a standard Linux/Node App Service (Oryx auto-detects Node and runs
`npm start`; confirm the plan is **Linux, Node 18+**, not Windows/iisnode).

Set configuration as **App Settings** (environment variables) — do **not** ship a
`.env` file: `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`, `SESSION_SECRET` (long
random), `APP_BASE_URL` (your real `https://…` URL), `REFERENCE_WEBHOOK_SECRET`,
`SP_SITE_ID`, plus the Entra redirect URI `{APP_BASE_URL}/auth/callback`. In live
mode the app **refuses to start** on a default `SESSION_SECRET` or a localhost
`APP_BASE_URL`, so these are enforced, not optional.

> **Run it as a single instance.** ⚠️ All durable state is on the App Service
> local disk: the JSON store (`data/store.json`), file-backed sessions
> (`data/sessions`), uploaded documents (`data/uploads`), and generated PDFs
> (`data/pdfs`). That disk is **wiped on every redeploy/restart** and is **not
> shared across scaled-out instances**. Consequences to accept (or fix) before
> real use:
> - A redeploy/restart loses candidate records, sessions (everyone re-logs-in),
>   uploaded files, and generated PDFs. (Completed PDFs are also mirrored to
>   SharePoint via the integrations adapter, so SharePoint is the real system of
>   record for filed documents.)
> - Scaling beyond one instance would diverge the JSON store and fire the daily
>   reference-reminder scheduler **once per instance** (duplicate emails). Keep
>   `WEBSITE_INSTANCES=1` until the production datastore is in.
>
> **Production path** (each is an isolated swap point already): candidate/RTH data
> → Azure SQL or Dataverse (reimplement `src/db.js`); sessions → Redis
> (`connect-redis`); the reminder scheduler → an external timer (Azure Function /
> WebJob, or cron hitting `POST /api/references/run-reminders`) with a single
> owner instead of in-process `setInterval`.

> Still a prototype. Remaining production work: the durability swaps above, the
> group/license mapping for provisioning, secret storage in Key Vault, replacing
> the placeholder I-9 Bookings link + handbook/AI/IT policy documents, and the
> IT-policy two-party "send to candidate" flow.
