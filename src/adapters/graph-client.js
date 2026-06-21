// ---------------------------------------------------------------------------
// Microsoft Graph client (app-only / client-credentials).
//
// Used by integrations.js only in LIVE mode. Acquires an app-only token with
// MSAL and exposes thin fetch helpers. No Graph SDK needed — Node has fetch.
//
// Least-privilege application permissions to grant + admin-consent for live:
//   Sites.Selected (preferred) or Files.ReadWrite.All   — file PDFs to SharePoint
//   User.ReadWrite.All                                   — create accounts
//   Group.ReadWrite.All                                  — group membership
//   Mail.Send                                            — notifications
// Grant Sites.Selected access to ONLY the HR site, not the whole tenant.
// ---------------------------------------------------------------------------
import { ConfidentialClientApplication } from '@azure/msal-node';
import { config, GRAPH } from '../config.js';

let cca = null;
function client() {
  if (!cca) {
    cca = new ConfidentialClientApplication({
      auth: { clientId: config.clientId, authority: config.authority, clientSecret: config.clientSecret },
    });
  }
  return cca;
}

async function appToken() {
  const res = await client().acquireTokenByClientCredential({ scopes: ['https://graph.microsoft.com/.default'] });
  return res.accessToken;
}

async function call(method, path, { json, body, contentType } = {}) {
  const token = await appToken();
  const res = await fetch(path.startsWith('http') ? path : GRAPH + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(contentType ? { 'Content-Type': contentType } : {}),
    },
    body: json ? JSON.stringify(json) : body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

export const graphApi = {
  get: (p) => call('GET', p),
  post: (p, json) => call('POST', p, { json }),
  patch: (p, json) => call('PATCH', p, { json }),
  // upload raw bytes (PDF) to a drive path
  putBytes: (p, bytes, contentType = 'application/pdf') =>
    call('PUT', p, { body: Buffer.from(bytes), contentType }),
};
