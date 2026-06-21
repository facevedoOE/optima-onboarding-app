// ---------------------------------------------------------------------------
// Configuration.
//
// The app runs in one of two modes, decided purely by whether Entra/Graph
// credentials are present in the environment:
//
//   demo  — no credentials. Auth is a local role picker; SharePoint/Graph/email
//           are logged to the candidate activity trail. Runs anywhere.
//   live  — TENANT_ID + CLIENT_ID + CLIENT_SECRET set. Real Microsoft sign-in,
//           real Graph calls. This is what you flip on against your tenant.
//
// Nothing else in the app branches on environment — it asks config.live.
// ---------------------------------------------------------------------------
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve .env relative to the app root (one level up from src/), NOT the
// process CWD — so it loads regardless of where the app is started from.
const ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');

// Load .env if present — dependency-free, works on any modern Node (no CLI flag
// needed, so `npm start` runs on Node 18+). Real env vars always win.
try {
  if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch (e) { /* no .env — demo mode */ }

const env = process.env;

export const config = {
  port: env.PORT || 4000,
  baseUrl: env.APP_BASE_URL || `http://localhost:${env.PORT || 4000}`,
  sessionSecret: env.SESSION_SECRET || 'dev-only-not-secret',

  // Entra / Graph
  tenantId: env.TENANT_ID || '',
  clientId: env.CLIENT_ID || '',
  clientSecret: env.CLIENT_SECRET || '',
  redirectPath: '/auth/callback',

  // SharePoint target (where completed PDFs are filed)
  sharepoint: {
    siteId: env.SP_SITE_ID || '',          // e.g. optimaedcom.sharepoint.com,<guid>,<guid>
    driveId: env.SP_DRIVE_ID || '',        // optional; falls back to the site's default drive
    basePath: env.SP_BASE_PATH || 'Onboarding (Automation)/Candidate Folders',
  },

  // Account provisioning
  mailDomain: env.MAIL_DOMAIN || 'optimaed.com',
  mailFrom: env.MAIL_FROM || 'hr@optimaed.com',

  get live() {
    return Boolean(this.tenantId && this.clientId && this.clientSecret);
  },
  get authority() {
    return `https://login.microsoftonline.com/${this.tenantId}`;
  },
};

export const GRAPH = 'https://graph.microsoft.com/v1.0';

if (!config.live) {
  console.log('⚙️  Running in DEMO mode (no Entra credentials). See .env.example to go live.');
} else {
  // Fail fast: live mode must not run on default/missing secrets.
  if (!env.SESSION_SECRET || env.SESSION_SECRET === 'dev-only-not-secret') {
    throw new Error('SESSION_SECRET must be set to a strong, unique value in live mode.');
  }
  if (!env.APP_BASE_URL || env.APP_BASE_URL.startsWith('http://localhost')) {
    throw new Error('APP_BASE_URL must be set to your real https URL in live mode.');
  }
  if (!env.REFERENCE_WEBHOOK_SECRET) {
    console.warn('⚠️  REFERENCE_WEBHOOK_SECRET is not set — the reference webhook will reject all calls in live mode.');
  }
  console.log('🔐 Running in LIVE mode — Entra sign-in and Graph calls are active.');
}
