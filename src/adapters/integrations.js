// ---------------------------------------------------------------------------
// Integration adapters — the seam to your Microsoft 365 tenant.
//
// Every function works in two modes:
//   demo — logs what WOULD happen to the candidate activity trail.
//   live — performs the real Microsoft Graph call (config.live === true).
//
// Real calls are wrapped so a failure is recorded on the activity trail rather
// than silently lost, and never crashes the request mid-flow.
// ---------------------------------------------------------------------------
import { db, nowISO } from '../db.js';
import { config } from '../config.js';
import { graphApi } from './graph-client.js';

function logActivity(candidateId, entry) {
  if (!candidateId) return;
  const cand = db.get('candidates', candidateId);
  if (!cand) return;
  const activity = cand.activity || [];
  activity.unshift({ at: nowISO(), ...entry });
  db.update('candidates', candidateId, { activity });
}

const enc = (s) => encodeURIComponent(s);
// Graph drive path addressing: /sites/{id}/drive/root:/a/b/c:/content
function sitePath(segments) {
  return segments.map(enc).join('/');
}

export const sharepoint = {
  async fileDocument({ candidate, fileName, bytes }) {
    const folder = candidate ? `${candidate.lastName}, ${candidate.firstName}` : 'Unassigned';
    const relPath = `${config.sharepoint.basePath}/${folder}/${fileName}`;

    // SharePoint filing is OPTIONAL. With no site configured, the PDF still lives
    // in the app (data/pdfs) and is downloadable per candidate — we just skip the
    // extra copy to the HR library rather than erroring. Lets live mode run
    // without granting Sites.Selected.
    if (config.live && !config.sharepoint.siteId) {
      logActivity(candidate?.id, { kind: 'filed', message: `“${fileName}” kept in the app (SharePoint not configured)` });
      return { path: null, skipped: true };
    }

    if (!config.live) {
      logActivity(candidate?.id, { kind: 'filed', message: `Filed “${fileName}” to ${config.sharepoint.basePath}/${folder}` });
      console.log(`[demo][sharepoint] would file ${bytes?.length ?? 0} bytes -> [HR site]/${relPath}`);
      return { path: `[HR SharePoint]/${relPath}` };
    }

    try {
      const drive = config.sharepoint.driveId
        ? `/drives/${config.sharepoint.driveId}`
        : `/sites/${config.sharepoint.siteId}/drive`;
      const graphPath = `${drive}/root:/${sitePath(relPath.split('/'))}:/content`;
      const result = await graphApi.putBytes(graphPath, bytes);
      logActivity(candidate?.id, { kind: 'filed', message: `Filed “${fileName}” to SharePoint (${folder})` });
      return { path: result?.webUrl || relPath };
    } catch (err) {
      logActivity(candidate?.id, { kind: 'error', message: `SharePoint filing failed for “${fileName}”: ${err.message}` });
      throw err;
    }
  },
};

export const graph = {
  // GUARDRAILS: only reached after the RTH signature chain is fully approved,
  // and should run under a least-privilege service principal with an audit
  // record for every action (the candidate activity trail is that record).
  async provisionAccess({ candidate, item }) {
    if (!config.live) {
      logActivity(candidate?.id, { kind: 'provision', message: `Provisioned ${item.label} (${item.dept})` });
      console.log(`[demo][graph] would provision ${item.label}`);
      return { ok: true };
    }
    try {
      // Provisioning is org-specific. The clean model: each access item carries
      // an Entra groupId (membership) and/or license skuId (assignment).
      if (item.groupId && item.userId) {
        await graphApi.post(`/groups/${item.groupId}/members/$ref`, {
          '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${item.userId}`,
        });
      } else if (item.skuId && item.userId) {
        await graphApi.post(`/users/${item.userId}/assignLicense`, {
          addLicenses: [{ skuId: item.skuId, disabledPlans: [] }], removeLicenses: [],
        });
      } else {
        // No mapping configured yet — record it as a manual task for the owning dept.
        logActivity(candidate?.id, { kind: 'provision', message: `${item.label}: no Entra group/license mapping — routed to ${item.dept} as a manual task` });
        return { ok: true, manual: true };
      }
      logActivity(candidate?.id, { kind: 'provision', message: `Provisioned ${item.label} via Graph (${item.dept})` });
      return { ok: true };
    } catch (err) {
      logActivity(candidate?.id, { kind: 'error', message: `Provisioning ${item.label} failed: ${err.message}` });
      throw err;
    }
  },

  // Offboarding — remove access (group membership / license). Demo logs it.
  async revokeAccess({ candidate, item }) {
    if (!config.live) {
      logActivity(candidate?.id, { kind: 'revoke', message: `Revoked ${item.label} (${item.dept})` });
      console.log(`[demo][graph] would revoke ${item.label}`);
      return { ok: true };
    }
    try {
      if (item.groupId && item.userId) {
        await graphApi.del?.(`/groups/${item.groupId}/members/${item.userId}/$ref`);
      } else if (item.skuId && item.userId) {
        await graphApi.post(`/users/${item.userId}/assignLicense`, { addLicenses: [], removeLicenses: [item.skuId] });
      }
      logActivity(candidate?.id, { kind: 'revoke', message: `Revoked ${item.label} via Graph (${item.dept})` });
      return { ok: true };
    } catch (err) {
      logActivity(candidate?.id, { kind: 'error', message: `Revoking ${item.label} failed: ${err.message}` });
      throw err;
    }
  },

  async createAccount({ candidate }) {
    const upn = `${candidate.firstName}.${candidate.lastName}@${config.mailDomain}`.toLowerCase().replace(/\s+/g, '');
    if (!config.live) {
      logActivity(candidate?.id, { kind: 'account', message: `Created account ${upn}` });
      console.log(`[demo][graph] would create account ${upn}`);
      return { ok: true, upn };
    }
    try {
      const user = await graphApi.post('/users', {
        accountEnabled: true,
        displayName: `${candidate.firstName} ${candidate.lastName}`,
        mailNickname: `${candidate.firstName}.${candidate.lastName}`.toLowerCase().replace(/\s+/g, ''),
        userPrincipalName: upn,
        passwordProfile: { forceChangePasswordNextSignIn: true, password: cryptoTempPassword() },
      });
      logActivity(candidate?.id, { kind: 'account', message: `Created account ${upn}` });
      return { ok: true, upn, id: user?.id };
    } catch (err) {
      logActivity(candidate?.id, { kind: 'error', message: `Account creation failed: ${err.message}` });
      throw err;
    }
  },
};

export const notify = {
  async email({ to, subject, candidateId, html, attachments }) {
    // attachments: optional [{ name, bytes }] — e.g. the permissions PDF.
    if (!config.live) {
      const att = attachments?.length ? ` (with ${attachments.length} attachment: ${attachments.map((a) => a.name).join(', ')})` : '';
      logActivity(candidateId, { kind: 'email', message: `Emailed ${to}: ${subject}${att}` });
      console.log(`[demo][notify] would email ${to} — ${subject}${att}`);
      return { ok: true };
    }
    try {
      const message = {
        subject,
        body: { contentType: 'HTML', content: html || subject },
        toRecipients: [{ emailAddress: { address: to } }],
      };
      if (attachments?.length) {
        message.attachments = attachments.map((a) => ({
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: a.name,
          contentType: 'application/pdf',
          contentBytes: Buffer.from(a.bytes).toString('base64'),
        }));
      }
      await graphApi.post(`/users/${enc(config.mailFrom)}/sendMail`, { message, saveToSentItems: true });
      logActivity(candidateId, { kind: 'email', message: `Emailed ${to}: ${subject}` });
      return { ok: true };
    } catch (err) {
      logActivity(candidateId, { kind: 'error', message: `Email to ${to} failed: ${err.message}` });
      throw err;
    }
  },
};

function cryptoTempPassword() {
  // 16-char temporary password; user is forced to reset on first sign-in.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}
