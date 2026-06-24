import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, nowISO } from '../db.js';
import { config } from '../config.js';
import { requireAdmin, requireProvisioner, candidatePortalUrl } from '../auth.js';
import { generateSubmissionPdf, fillPdfTemplate, generatePermissionsPdf } from '../pdf.js';
import { sharepoint, graph, notify } from '../adapters/integrations.js';

// Constant-time string compare so secret checks don't leak length/content via timing.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PDF_DIR = join(__dirname, '..', '..', 'data', 'pdfs');
const UPLOAD_DIR = join(__dirname, '..', '..', 'data', 'uploads');
const TEMPLATES_DIR = join(__dirname, '..', '..', 'templates');
if (!existsSync(PDF_DIR)) mkdirSync(PDF_DIR, { recursive: true });
if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

// Save base64 file-field uploads to disk + the candidate's HR folder; replace
// the field value with a readable list of filenames (so it's stored/shown cleanly).
const MAX_FILE_BYTES = 15 * 1024 * 1024;        // 15 MB per file
const MAX_FILES_PER_FIELD = 10;                 // hard ceiling regardless of field config
const MAX_TOTAL_UPLOAD_BYTES = 40 * 1024 * 1024; // 40 MB per submission across all fields
const ALLOWED_UPLOAD_EXT = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'doc', 'docx', 'txt', 'heic']);

async function processUploads(def, data, candidate, submissionId) {
  // Validate EVERY file first (size, type, total) before writing anything, so a
  // bad file late in the batch can't leave half-written files on disk.
  const planned = []; // { key, names:[], writes:[{safe, bytes, name}] }
  let totalBytes = 0;
  for (const f of def.fields) {
    if (f.type !== 'file' || !Array.isArray(data[f.key])) continue;
    const limit = Math.min(f.maxFiles || MAX_FILES_PER_FIELD, MAX_FILES_PER_FIELD);
    const writes = [];
    for (const file of data[f.key].slice(0, limit)) {
      const b64 = String(file.data || '').split(',').pop();
      const bytes = Buffer.from(b64, 'base64');
      if (!bytes.length) continue;
      if (bytes.length > MAX_FILE_BYTES) {
        throw Object.assign(new Error(`"${file.name || 'file'}" exceeds the ${MAX_FILE_BYTES / 1024 / 1024}MB per-file limit.`), { status: 413 });
      }
      totalBytes += bytes.length;
      if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
        throw Object.assign(new Error(`Total upload size exceeds the ${MAX_TOTAL_UPLOAD_BYTES / 1024 / 1024}MB limit.`), { status: 413 });
      }
      const safe = String(file.name || 'upload').replace(/[^\w.\-]+/g, '_');
      const ext = safe.includes('.') ? safe.split('.').pop().toLowerCase() : '';
      if (!ALLOWED_UPLOAD_EXT.has(ext)) {
        throw Object.assign(new Error(`"${file.name || 'file'}" is not an allowed file type.`), { status: 415 });
      }
      writes.push({ safe, bytes, name: file.name });
    }
    planned.push({ key: f.key, writes });
  }

  // All valid — now write.
  const dir = join(UPLOAD_DIR, submissionId);
  for (const p of planned) {
    const names = [];
    for (const w of p.writes) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, w.safe), w.bytes);
      await sharepoint.fileDocument({ candidate, fileName: w.safe, bytes: w.bytes }).catch(() => {});
      names.push(w.name);
    }
    data[p.key] = names.join(', ');
  }
}

// Welcome content for the candidate portal — the merged landing-page material.
const WELCOME = {
  ceoName: 'Adam Mangana, M.Ed.',
  ceoTitle: 'CEO, OptimaEd',
  letter: `Welcome aboard! Joining the Optima team means becoming part of a community that is redefining what's possible in education. Every day, our work touches the lives of students and families across the country, and your unique talents will help us push that mission even further. I can't wait to see the impact you'll make.`,
  signoff: 'Onward and upward!',
  resources: [
    { title: 'Employee Handbook', desc: 'Company policies, expectations, and workplace guidelines.' },
    { title: 'Benefits Overview', desc: 'Health insurance, retirement plans, and additional perks.' },
    { title: 'IT Setup Guide', desc: 'Account access, software tools, and technical resources.' },
  ],
};

// --- shared helpers ---------------------------------------------------------
function appliesToCandidate(def, candidate) {
  if (def.internalOnly || def.appliesTo === 'internal' || def.appliesTo === 'reference') return false;
  const t = candidate.employeeType || '';
  const isOAO = t.startsWith('Optima Academy Online');
  const isFT = t.includes('Full-Time');
  const isContractor = t.includes('Contractor');
  switch (def.appliesTo) {
    case 'all': return true;
    case 'oao': return isOAO;
    case 'oao-fulltime': return isOAO && isFT;
    case 'oao-contractor': return isOAO && isContractor;
    default: return false;
  }
}

function candidateDetail(c) {
  const applicable = db.all('formDefinitions').filter((d) => appliesToCandidate(d, c));
  const subs = db.filter('submissions', (s) => s.candidateId === c.id);
  const checklist = applicable.map((d) => {
    const sub = subs.find((s) => s.formKey === d.key);
    return {
      key: d.key, title: d.title, description: d.description,
      status: sub ? sub.status : 'pending', submissionId: sub?.id,
      group: d.group, badge: d.badge, formType: d.formType, type: d.type,
      comingSoon: d.comingSoon || false,
    };
  });
  const reqs = db.filter('accessRequests', (a) => a.candidateId === c.id);
  const mapReq = (r) => (r ? { id: r.id, status: r.status, roleName: r.roleName } : null);
  const leadershipRth = mapReq(reqs.find((a) => (a.kind || 'leadership') === 'leadership'));
  const permissionsRth = mapReq(reqs.find((a) => a.kind === 'permissions'));
  const references = db.filter('references', (x) => x.candidateId === c.id);
  return { ...c, checklist, submissions: subs, leadershipRth, permissionsRth, references };
}

async function buildAndFilePdf({ definition, submission, candidate }) {
  const bytes = await generateSubmissionPdf({ definition, submission, candidate });
  const fileName = `${definition.key}_${(candidate ? candidate.lastName + '_' + candidate.firstName : 'record')}_${submission.id.slice(0, 8)}.pdf`;
  writeFileSync(join(PDF_DIR, `${submission.id}.pdf`), bytes);
  const filed = await sharepoint.fileDocument({ candidate, fileName, bytes });
  return { fileName, filedPath: filed.path };
}

// ===========================================================================
// PORTAL ROUTER — candidate-safe. Mounted for any signed-in user; candidates
// are always scoped to their OWN record here and can reach nothing else.
// ===========================================================================
export const portalApi = Router();

// A candidate's own onboarding home (welcome + their checklist).
portalApi.get('/portal', (req, res) => {
  const u = req.session.user;
  if (u.role !== 'candidate') return res.status(400).json({ error: 'Portal is for candidates' });
  const c = db.get('candidates', u.candidateId);
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json({ ...candidateDetail(c), welcome: WELCOME });
});

// Read a single form definition (needed to render it). Safe for both roles.
portalApi.get('/forms/:key', (req, res) => {
  const f = db.find('formDefinitions', (d) => d.key === req.params.key);
  if (!f) return res.status(404).json({ error: 'not found' });
  // Candidates may only read forms assigned to them — never internal-only
  // definitions like Request to Hire (which exposes the access catalog,
  // approver chain, and role bundles).
  if (req.session.user?.role === 'candidate') {
    const cand = db.get('candidates', req.session.user.candidateId);
    if (f.internalOnly || f.appliesTo === 'internal' || !cand || !appliesToCandidate(f, cand)) {
      return res.status(403).json({ error: 'This form is not assigned to you' });
    }
  }
  res.json(f);
});

// Submit a form. Candidates may only submit their OWN applicable forms.
portalApi.post('/submissions', async (req, res) => {
  const u = req.session.user;
  const { formKey, data } = req.body;
  const def = db.find('formDefinitions', (d) => d.key === formKey);
  if (!def) return res.status(404).json({ error: 'unknown form' });

  const candidateId = u.role === 'candidate' ? u.candidateId : req.body.candidateId;
  const candidate = candidateId ? db.get('candidates', candidateId) : null;
  if (u.role === 'candidate') {
    if (!candidate || !appliesToCandidate(def, candidate)) return res.status(403).json({ error: 'This form is not assigned to you' });
  }

  const isEmpty = (v) => v == null || (Array.isArray(v) ? v.length === 0 : String(v).trim() === '');
  const missing = def.fields.filter((f) => f.required && isEmpty(data?.[f.key])).map((f) => f.label);
  if (missing.length) return res.status(400).json({ error: 'Missing required fields', missing });

  const submission = db.insert('submissions', { candidateId, formKey, data: {}, status: 'complete', submittedAt: nowISO() });
  // Save uploaded documents to the HR folder, then store the cleaned answers.
  try {
    await processUploads(def, data, candidate, submission.id);
  } catch (e) {
    db.remove('submissions', submission.id);
    return res.status(e.status || 400).json({ error: e.message || 'Upload failed' });
  }
  // Store ONLY the form's declared field keys — drops arbitrary/unknown keys and
  // any prototype-pollution attempt (__proto__, constructor) from the raw body.
  const clean = {};
  for (const f of def.fields) if (data?.[f.key] !== undefined) clean[f.key] = data[f.key];
  db.update('submissions', submission.id, { data: clean });

  let fileName, filedPath;
  if (def.type === 'embed' || def.embedUrl || def.type === 'link' || def.linkUrl) {
    // Completed on an external system (Adobe Sign document or a booking page).
    // The app records completion; no PDF is generated here.
    filedPath = def.type === 'link' || def.linkUrl
      ? 'Scheduled on the external booking page'
      : 'Completed on the official document (Adobe Sign → filed via webhook)';
    if (candidate) {
      const activity = candidate.activity || [];
      const msg = (def.type === 'link' || def.linkUrl) ? `Scheduled “${def.title}”` : `Completed “${def.title}” on the official document`;
      activity.unshift({ at: nowISO(), kind: 'external', message: msg });
      db.update('candidates', candidate.id, { activity });
    }
  } else if (def.pdfTemplate) {
    // Fill the REAL county PDF with the candidate's answers, then file it.
    const templateBytes = readFileSync(join(TEMPLATES_DIR, def.pdfTemplate));
    const bytes = await fillPdfTemplate({ templateBytes, definition: def, data });
    writeFileSync(join(PDF_DIR, `${submission.id}.pdf`), bytes);
    fileName = `${def.key}_${candidate ? candidate.lastName + '_' + candidate.firstName : 'record'}_${submission.id.slice(0, 8)}.pdf`;
    ({ path: filedPath } = await sharepoint.fileDocument({ candidate, fileName, bytes }));
  } else {
    ({ fileName, filedPath } = await buildAndFilePdf({ definition: def, submission, candidate }));
  }
  db.update('submissions', submission.id, { fileName, filedPath });

  // Step 2A: submitting the references form auto-creates each reference and sends a request.
  if (def.referenceIntake && candidate) {
    for (let i = 1; i <= 3; i++) {
      const name = data?.[`ref${i}Name`]; const email = data?.[`ref${i}Email`];
      if (!name || !email) continue;
      if (db.find('references', (r) => r.candidateId === candidate.id && (r.email || '').toLowerCase() === String(email).toLowerCase())) continue;
      const ref = db.insert('references', { candidateId: candidate.id, name, email, status: 'requested', sentAt: nowISO() });
      await sendReferenceRequest(ref);
    }
  }
  res.status(201).json({ ...submission, fileName, filedPath });
});

// View a generated PDF. Candidates may only view their own.
portalApi.get('/submissions/:id/pdf', (req, res) => {
  const u = req.session.user;
  const sub = db.get('submissions', req.params.id);
  if (!sub) return res.status(404).send('not found');
  if (u.role === 'candidate' && sub.candidateId !== u.candidateId) return res.status(403).send('forbidden');
  const file = join(PDF_DIR, `${req.params.id}.pdf`);
  if (!existsSync(file)) return res.status(404).send('not found');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${req.params.id}.pdf"`);
  res.send(readFileSync(file));
});

// ===========================================================================
// ADMIN ROUTER — everything here requires the admin role.
// ===========================================================================
export const api = Router();
api.use(requireAdmin);

// --- Form Builder -----------------------------------------------------------
// Only these hosts may be used as embed/link targets — they're the same trusted
// origins allowed by the CSP frame-src. Relative paths (bundled /templates) are OK.
// Anything else is rejected so an admin can't point an iframe at an arbitrary site.
const ALLOWED_EMBED_HOSTS = [
  'adobe.com', 'documents.adobe.com', 'na4.documents.adobe.com',
  'microsoft.com', 'office.com', 'office365.com', 'sharepoint.com',
  'forms.office.com', 'outlook.office365.com',
];
function embedUrlError(url) {
  if (url == null || url === '') return null;
  const s = String(url);
  if (s.startsWith('/')) return null; // bundled relative asset (e.g. /templates/...)
  let u;
  try { u = new URL(s); } catch { return 'must be a valid URL'; }
  if (u.protocol !== 'https:') return 'must use https';
  const host = u.hostname.toLowerCase();
  const ok = ALLOWED_EMBED_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  return ok ? null : `host "${host}" is not an allowed embed/link target`;
}

api.get('/forms', (_req, res) => res.json(db.all('formDefinitions')));
api.post('/forms', (req, res) => {
  const { key, title, description, appliesTo = 'all', fields = [], type, embedUrl, linkUrl } = req.body;
  if (!key || !title) return res.status(400).json({ error: 'key and title required' });
  if (db.find('formDefinitions', (d) => d.key === key)) return res.status(409).json({ error: 'key exists' });
  for (const url of [embedUrl, linkUrl]) {
    const err = embedUrlError(url);
    if (err) return res.status(400).json({ error: `Embed/link URL ${err}` });
  }
  res.status(201).json(db.insert('formDefinitions', { id: key, key, title, description, appliesTo, fields, type, embedUrl, linkUrl, version: 1 }));
});
api.put('/forms/:key', (req, res) => {
  const f = db.find('formDefinitions', (d) => d.key === req.params.key);
  if (!f) return res.status(404).json({ error: 'not found' });
  const patch = { ...req.body };
  delete patch.id; delete patch.key;
  for (const url of [patch.embedUrl, patch.linkUrl]) {
    const err = embedUrlError(url);
    if (err) return res.status(400).json({ error: `Embed/link URL ${err}` });
  }
  patch.version = (f.version || 1) + 1;
  res.json(db.update('formDefinitions', f.id, patch));
});

api.get('/roles', (_req, res) => res.json(db.all('accessRoles')));

// --- Candidates -------------------------------------------------------------
api.get('/candidates', (_req, res) => {
  res.json(db.all('candidates').map((c) => {
    const subs = db.filter('submissions', (s) => s.candidateId === c.id);
    const applicable = db.all('formDefinitions').filter((d) => appliesToCandidate(d, c));
    const done = applicable.filter((d) => subs.some((s) => s.formKey === d.key && s.status === 'complete')).length;
    return { ...c, progress: { done, total: applicable.length } };
  }));
});

api.post('/candidates', (req, res) => {
  const { firstName, lastName, email, position, startDate, employeeType } = req.body;
  if (!firstName || !lastName) return res.status(400).json({ error: 'name required' });
  res.status(201).json(db.insert('candidates', {
    firstName, lastName, email, position, startDate, employeeType,
    status: 'In Progress', activity: [{ at: nowISO(), kind: 'created', message: 'Candidate created' }],
  }));
});

api.get('/candidates/:id', (req, res) => {
  const c = db.get('candidates', req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(candidateDetail(c));
});

// Admin: compiled log of every submission for a form (one page per form).
api.get('/log/:formKey', (req, res) => {
  const def = db.find('formDefinitions', (d) => d.key === req.params.formKey);
  if (!def) return res.status(404).json({ error: 'unknown form' });
  const rows = db.filter('submissions', (s) => s.formKey === req.params.formKey).map((s) => {
    const c = s.candidateId ? db.get('candidates', s.candidateId) : null;
    return { submissionId: s.id, candidateId: s.candidateId, candidateName: c ? `${c.firstName} ${c.lastName}` : '—', data: s.data, submittedAt: s.submittedAt };
  });
  res.json({ title: def.title, fields: def.fields, rows });
});

// Admin: read a submission's answers (logged on the admin side).
api.get('/submissions/:id', (req, res) => {
  const s = db.get('submissions', req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const def = db.find('formDefinitions', (d) => d.key === s.formKey);
  const cand = s.candidateId ? db.get('candidates', s.candidateId) : null;
  res.json({ ...s, formTitle: def?.title || s.formKey, fields: def?.fields || [], candidateName: cand ? `${cand.firstName} ${cand.lastName}` : null });
});

// Send the candidate their magic-link portal invitation.
api.post('/candidates/:id/send-portal-link', async (req, res) => {
  const c = db.get('candidates', req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const url = candidatePortalUrl(c.id);
  await notify.email({
    to: c.email, candidateId: c.id, subject: 'Your Optima onboarding portal',
    html: `<p>Welcome to Optima! Complete your onboarding here:</p><p><a href="${url}">Open my onboarding portal</a></p>`,
  });
  db.update('candidates', c.id, { portalLinkSentAt: nowISO() });
  // In demo mode we return the link so it's usable without a real inbox.
  res.json({ ok: true, link: config.live ? undefined : url });
});

// --- References (admin) — add / resend / correct / replace ------------------
// In live mode the reference receives the official Adobe reference form to sign;
// Adobe's webhook marks it received (mirrors your Step 2A/2B/2C flows).
const REFERENCE_FORM_URL = process.env.REFERENCE_FORM_URL || 'https://na4.documents.adobe.com/public/esignWidget?wid=CBFCIBAA3AAABLblqZhDpQoRF7MxnMAybLMc-AQOSRttO83kQgrLnNGxhbcCSW5IcP-HX6jpYg-hnJiuotzU*';

function logCandidate(candidateId, message, kind = 'reference') {
  const c = db.get('candidates', candidateId);
  if (!c) return;
  const activity = c.activity || [];
  activity.unshift({ at: nowISO(), kind, message });
  db.update('candidates', candidateId, { activity });
}

async function sendReferenceRequest(ref, reminder = false) {
  await notify.email({
    to: ref.email, candidateId: ref.candidateId,
    subject: reminder ? `Reminder: reference request for an Optima candidate` : `Reference request for an Optima candidate`,
    html: `<p>Hello ${ref.name},</p><p>${reminder ? 'A quick reminder to complete' : 'Please complete'} this professional reference:</p><p><a href="${REFERENCE_FORM_URL}">Complete the reference form</a></p>`,
  });
  logCandidate(ref.candidateId, `${reminder ? 'Reference reminder' : 'Reference request'} sent to ${ref.name} <${ref.email}>`);
}

// Step 5: reminders every 3 days for un-returned references; escalate to HR at day 9.
const REMINDER_EVERY_DAYS = 3;
const ESCALATE_DAY = 9;
function daysSince(iso) { return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000); }

export async function runReferenceReminders(candidateId) {
  const refs = db.filter('references', (r) => r.status !== 'received' && (!candidateId || r.candidateId === candidateId));
  let reminders = 0, escalations = 0;
  for (const r of refs) {
    const d = daysSince(r.createdAt || r.sentAt);
    // Send a reminder once the time SINCE the last contact reaches the interval,
    // rather than only on exact day boundaries (which a missed daily run would skip).
    const sinceLast = daysSince(r.lastReminderAt || r.createdAt || r.sentAt);
    if (d >= REMINDER_EVERY_DAYS && sinceLast >= REMINDER_EVERY_DAYS) {
      await sendReferenceRequest(r, true);
      db.update('references', r.id, { sentAt: nowISO(), lastReminderAt: nowISO(), remindersSent: (r.remindersSent || 0) + 1 });
      reminders++;
    }
    if (d >= ESCALATE_DAY && !r.escalatedAt) {
      await notify.email({ to: config.mailFrom, candidateId: r.candidateId, subject: `Reference overdue (${d} days): ${r.name}` });
      logCandidate(r.candidateId, `Reference overdue (${d} days) — escalated to HR: ${r.name}`);
      db.update('references', r.id, { escalatedAt: nowISO() });
      escalations++;
    }
  }
  return { checked: refs.length, reminders, escalations };
}

// Step 2B: Adobe Sign webhook → auto-mark a reference received. Unauthenticated
// (Adobe calls it); optional shared secret via REFERENCE_WEBHOOK_SECRET.
export const webhookRouter = Router();
webhookRouter.post('/reference-completed', (req, res) => {
  const secret = process.env.REFERENCE_WEBHOOK_SECRET;
  // In live mode the secret is mandatory — an unauthenticated webhook must never
  // be able to mark references received against a real candidate.
  if (config.live && !secret) {
    return res.status(503).json({ error: 'webhook not configured' });
  }
  if (secret) {
    const provided = req.body?.secret || req.headers['x-webhook-secret'] || '';
    if (!safeEqual(String(provided), secret)) {
      return res.status(401).json({ error: 'invalid webhook secret' });
    }
  }
  // Match on EMAIL only — a human name alone is too guessable to flip a
  // reference to "received" (an attacker who knows a name shouldn't be able to
  // satisfy a background check). Adobe always returns the signer's email.
  const email = String(req.body?.referenceEmail || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'referenceEmail required' });
  const ref = db.find('references', (r) => r.status !== 'received'
    && (r.email || '').toLowerCase() === email);
  if (!ref) return res.status(404).json({ error: 'no matching pending reference' });
  db.update('references', ref.id, { status: 'received', receivedAt: nowISO() });
  logCandidate(ref.candidateId, `Reference received from ${ref.name} (auto)`);
  res.json({ ok: true, referenceId: ref.id });
});

api.post('/candidates/:id/references', async (req, res) => {
  const c = db.get('candidates', req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email required' });
  const ref = db.insert('references', { candidateId: c.id, name, email, status: 'requested', sentAt: nowISO() });
  await sendReferenceRequest(ref);
  res.status(201).json(ref);
});

api.post('/references/:id/resend', async (req, res) => {
  const ref = db.get('references', req.params.id);
  if (!ref) return res.status(404).json({ error: 'not found' });
  db.update('references', ref.id, { sentAt: nowISO(), status: 'requested' });
  await sendReferenceRequest(ref);
  res.json(db.get('references', ref.id));
});

api.put('/references/:id', (req, res) => {
  const ref = db.get('references', req.params.id);
  if (!ref) return res.status(404).json({ error: 'not found' });
  const { name, email } = req.body;
  const updated = db.update('references', ref.id, { name: name ?? ref.name, email: email ?? ref.email });
  logCandidate(ref.candidateId, `Reference corrected: ${updated.name} <${updated.email}>`);
  res.json(updated);
});

api.post('/references/:id/received', (req, res) => {
  const ref = db.get('references', req.params.id);
  if (!ref) return res.status(404).json({ error: 'not found' });
  const updated = db.update('references', ref.id, { status: 'received', receivedAt: nowISO() });
  logCandidate(ref.candidateId, `Reference received from ${ref.name}`);
  res.json(updated);
});

api.delete('/references/:id', (req, res) => {
  const ref = db.get('references', req.params.id);
  if (!ref) return res.status(404).json({ error: 'not found' });
  db.remove('references', ref.id);
  logCandidate(ref.candidateId, `Reference removed: ${ref.name}`);
  res.json({ ok: true });
});

// Run reminders (also runs on a daily schedule in server.js). All, or one candidate.
api.post('/references/run-reminders', async (_req, res) => res.json(await runReferenceReminders()));
api.post('/candidates/:id/references/remind', async (req, res) => res.json(await runReferenceReminders(req.params.id)));

// --- Request to Hire --------------------------------------------------------
api.get('/rth', (_req, res) => res.json(db.all('accessRequests')));
api.get('/rth/:id', (req, res) => {
  const r = db.get('accessRequests', req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json(r);
});

api.post('/rth', (req, res) => {
  const { data, roleId, accessItems, candidateId } = req.body;
  const kind = req.body.kind === 'permissions' ? 'permissions' : 'leadership';
  const def = db.find('formDefinitions', (d) => d.isRTH);
  const appliesToKind = (f) => !f.kindOnly || f.kindOnly === kind;
  const isEmpty = (v) => v == null || (Array.isArray(v) ? v.length === 0 : String(v).trim() === '');
  // Only require fields that apply to THIS request kind (salary→leadership, mailing→permissions).
  const missing = def.fields.filter((f) => f.required && appliesToKind(f) && isEmpty(data?.[f.key])).map((f) => f.label);
  if (missing.length) return res.status(400).json({ error: 'Missing required fields', missing });
  // Link to a candidate record by stable ID — the thread that connects the lifecycle.
  const linked = candidateId ? db.get('candidates', candidateId) : null;
  // Store only declared keys that apply to this kind (so salary never lands on a permissions request).
  const finalData = {};
  for (const f of def.fields) if (appliesToKind(f) && data?.[f.key] !== undefined) finalData[f.key] = data[f.key];
  if (linked) finalData.candidateName = `${linked.firstName} ${linked.lastName}`;
  const role = db.get('accessRoles', roleId);

  if (kind === 'permissions') {
    // Access request — NO salary, NO signature chain. Filled in, then sent to the access team.
    const items = (accessItems || [])
      .map((key) => {
        const item = def.accessCatalog.find((a) => a.key === key);
        if (!item) return null;
        return { key, label: item.label, dept: def.departments[item.dept] || item.dept, kind: item.kind || 'software', status: 'requested' };
      })
      .filter(Boolean);
    return res.status(201).json(db.insert('accessRequests', { kind: 'permissions', candidateId: linked?.id || null, data: finalData, roleId, roleName: role?.name, signatures: [], items, status: 'open' }));
  }

  // Leadership request — salary + HR→Finance→CEO signature chain, NO access items.
  const signatures = def.signatureChain.map((s) => ({ ...s, signedAt: null, signedBy: null }));
  const created = db.insert('accessRequests', { kind: 'leadership', candidateId: linked?.id || null, data: finalData, roleId, roleName: role?.name, signatures, items: [], status: 'awaiting-signatures' });
  notifyApproverTurn(created, created.signatures[0]).catch(() => {}); // email the first approver it's their turn
  res.status(201).json(created);
});

// Edit the requested permissions/access BEFORE approval — usable by HR (Gina) or
// the hiring manager, in any order (the RTH isn't filled in a fixed sequence).
api.post('/rth/:id/permissions', (req, res) => {
  const r = db.get('accessRequests', req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  // Permissions requests stay editable while open; leadership requests only before approval.
  if (!(r.kind === 'permissions' ? r.status === 'open' : r.status === 'awaiting-signatures')) {
    return res.status(409).json({ error: 'Permissions can only be edited before the request is approved.' });
  }
  const def = db.find('formDefinitions', (d) => d.isRTH);
  const { accessItems, roleId } = req.body;
  const items = (accessItems || [])
    .map((key) => {
      const item = def.accessCatalog.find((a) => a.key === key);
      if (!item) return null;
      return { key, label: item.label, dept: def.departments[item.dept] || item.dept, kind: item.kind || 'software', status: 'requested' };
    })
    .filter(Boolean);
  const role = roleId ? db.get('accessRoles', roleId) : null;
  res.json(db.update('accessRequests', r.id, { items, roleId: roleId ?? r.roleId, roleName: role ? role.name : r.roleName }));
});

// ── Permissions-email distribution ──────────────────────────────────────────
// Every permissions email goes to this fixed group...
const PERMISSIONS_RECIPIENTS = [
  'smurphy@optimaed.com',  // Stephanie Murphy
  'mbattle@optimaed.com',  // Meghan Battle
  'tgriffin@optimaed.com', // Trae Griffin
  'tgoolsby@optimaed.com', // Tyler Goolsby
  'mcorea@optimaed.com',   // Marvin Corea
  'tshang@optimaed.com',   // Tina Shang
];
// ...plus an item-specific recipient when that item is currently selected OR was
// just removed (so they hear about both the grant and the removal).
const PERMISSIONS_ITEM_RECIPIENTS = {
  ramp: 'lyattaw@optimaed.com', // Ramp Card → Lisa Marie Yattaw
  llm: 'facevedo@optimaed.com', // LLM / AI → Francine
};

function permissionsRecipients(currentKeys, changedKeys = []) {
  const set = new Set(PERMISSIONS_RECIPIENTS);
  for (const [key, email] of Object.entries(PERMISSIONS_ITEM_RECIPIENTS)) {
    if (currentKeys.includes(key) || changedKeys.includes(key)) set.add(email);
  }
  return [...set];
}

// Signature-chain approvers — emailed when it becomes their turn to sign.
const APPROVER_EMAILS = {
  HR: 'gfalcone@optimaed.com',       // Gina Falcone
  Finance: 'lrocafort@optimaed.com', // Lu Rocafort
  CEO: 'amangana@optimaed.com',      // Adam Mangana
};
async function notifyApproverTurn(rth, step) {
  const to = step && APPROVER_EMAILS[step.role];
  if (!to) return;
  const who = rth.data?.candidateName || 'a new hire';
  const link = `${config.baseUrl}/#/rth/${rth.id}`;
  await notify.email({
    to, candidateId: rth.candidateId || undefined,
    subject: `Signature needed: Request to Hire for ${who}`,
    html: `<p>A Request to Hire for <strong>${who}</strong> is awaiting your signature (<strong>${step.label}</strong>).</p>
      <p><a href="${link}">Review &amp; sign</a></p>`,
  }).catch(() => {});
}

function labelForKey(key) {
  const def = db.find('formDefinitions', (d) => d.isRTH);
  return def?.accessCatalog.find((a) => a.key === key)?.label || key;
}

// Email the distribution list the requested permissions. On a resend, the email
// highlights what was Added / Removed since the last send. One mail per recipient
// (keeps the list private). Best-effort.
async function sendPermissionsEmail({ rth, recipients, added = [], removed = [], firstSend = true }) {
  const who = rth.data?.candidateName || 'a new hire';
  const rthLink = `${config.baseUrl}/#/rth/${rth.id}`;
  const currentList = (rth.items || []).map((i) => `<li>${i.label}</li>`).join('') || '<li><em>none</em></li>';
  const deltaHtml = firstSend ? '' :
    `${added.length ? `<p><strong>Added:</strong> ${added.map(labelForKey).join(', ')}</p>` : ''}` +
    `${removed.length ? `<p><strong>Removed:</strong> ${removed.map(labelForKey).join(', ')}</p>` : ''}`;
  const subject = firstSend ? `Permissions requested for ${who}` : `Permissions updated for ${who}`;
  const html = `<p>${firstSend ? 'A Request to Hire lists the following access for' : 'The requested access was updated for'} <strong>${who}</strong>:</p>
    ${deltaHtml}
    <p>Current access:</p>
    <ul>${currentList}</ul>
    <p>The attached access summary ${firstSend ? 'lists the requested permissions' : 'is marked UPDATED and reflects the revised permissions'} (no salary info).</p>
    <p><a href="${rthLink}">Open the Request to Hire</a></p>`;
  // Attach the access-summary PDF — clearly banner-marked "UPDATED" on a resend.
  let attachments;
  try {
    const bytes = await generatePermissionsPdf({ rth, updated: !firstSend });
    writeFileSync(join(PDF_DIR, `${rth.id}-permissions.pdf`), bytes);
    attachments = [{ name: `Permissions_${who.replace(/[^a-z0-9]+/gi, '_')}.pdf`, bytes }];
  } catch { /* PDF optional — send the email without it rather than fail */ }
  for (const to of recipients) {
    await notify.email({ to, candidateId: rth.candidateId || undefined, subject, html, attachments }).catch(() => {});
  }
}

// On approval, tell the distribution list the access is approved to provision.
async function notifyAccessOwners(rth) {
  const who = rth.data?.candidateName || 'a new hire';
  const rthLink = `${config.baseUrl}/#/rth/${rth.id}`;
  const pdfLink = `${config.baseUrl}/api/provisioner/rth/${rth.id}/pdf`;
  const html = `<p>An approved Request to Hire is ready to provision for <strong>${who}</strong>:</p>
    <ul>${(rth.items || []).map((i) => `<li>${i.label}</li>`).join('') || '<li><em>none</em></li>'}</ul>
    <p><a href="${pdfLink}">View the access summary (PDF — no salary info)</a> · <a href="${rthLink}">mark items provisioned</a></p>`;
  for (const to of permissionsRecipients((rth.items || []).map((i) => i.key))) {
    await notify.email({ to, candidateId: rth.candidateId || undefined, subject: `Approved — provision access for ${who}`, html }).catch(() => {});
  }
}

// Submit the permissions and email the distribution list. A resend only notifies
// people if items were added or removed since the last send (no-op otherwise).
// Usable by HR (Gina) or the hiring manager, any number of times, before approval.
api.post('/rth/:id/permissions/submit', async (req, res) => {
  const r = db.get('accessRequests', req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  if (!(r.kind === 'permissions' ? r.status === 'open' : r.status === 'awaiting-signatures')) {
    return res.status(409).json({ error: 'Permissions can only be sent before the request is approved.' });
  }
  const def = db.find('formDefinitions', (d) => d.isRTH);
  const { accessItems, roleId } = req.body;
  const items = (accessItems || [])
    .map((key) => {
      const item = def.accessCatalog.find((a) => a.key === key);
      if (!item) return null;
      return { key, label: item.label, dept: def.departments[item.dept] || item.dept, kind: item.kind || 'software', status: 'requested' };
    })
    .filter(Boolean);
  const role = roleId ? db.get('accessRoles', roleId) : null;
  const updated = db.update('accessRequests', r.id, { items, roleId: roleId ?? r.roleId, roleName: role ? role.name : r.roleName });

  const currentKeys = items.map((i) => i.key);
  const firstSend = r.lastNotifiedItemKeys === undefined || r.lastNotifiedItemKeys === null;
  const prev = r.lastNotifiedItemKeys || [];
  const added = currentKeys.filter((k) => !prev.includes(k));
  const removed = prev.filter((k) => !currentKeys.includes(k));

  // Resend with no change → notify nobody.
  if (!firstSend && added.length === 0 && removed.length === 0) {
    return res.json({ sent: false, message: 'No changes since the last send — nobody was emailed.', ...db.get('accessRequests', r.id) });
  }

  const recipients = permissionsRecipients(currentKeys, [...added, ...removed]);
  await sendPermissionsEmail({ rth: updated, recipients, added, removed, firstSend });
  db.update('accessRequests', r.id, { lastNotifiedItemKeys: currentKeys, lastNotifiedAt: nowISO() });
  res.json({ sent: true, recipientCount: recipients.length, added: added.length, removed: removed.length, firstSend, ...db.get('accessRequests', r.id) });
});

api.post('/rth/:id/sign', async (req, res) => {
  const { stepKey } = req.body;
  const user = req.session.user;
  const r = db.get('accessRequests', req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });

  const idx = r.signatures.findIndex((s) => s.key === stepKey);
  if (idx === -1) return res.status(404).json({ error: 'unknown step' });
  const step = r.signatures[idx];

  // Terminal-state guard: once the chain is fully signed, the only reason to be
  // here is to retry a finalize that previously failed (signatures complete but
  // status never advanced past awaiting-signatures). Re-signing an already
  // approved/provisioning/complete/terminated request would re-run account
  // creation and regress its status — reject it.
  if (r.signatures.every((s) => s.signedAt) && r.status !== 'awaiting-signatures') {
    return res.status(409).json({ error: 'This request is already finalized.' });
  }

  // Approver designation: the admin must hold the step's approver role.
  // (live: from Entra groups; demo: the admin holds all three.)
  if (!(user.approverRoles || []).includes(step.role)) {
    return res.status(403).json({ error: `This step requires the ${step.role} approver group, which you don't hold.` });
  }
  if (r.signatures.slice(0, idx).some((s) => !s.signedAt)) {
    return res.status(409).json({ error: 'Earlier signatures are still pending' });
  }

  step.signedAt = nowISO();
  step.signedBy = user.name;
  const allSigned = r.signatures.every((s) => s.signedAt);

  // Record the signature first. Only flip to "approved" AFTER the PDFs and
  // provisioning side-effects succeed — so a PDF failure can't leave an RTH
  // marked approved with no generated document.
  db.update('accessRequests', r.id, { signatures: r.signatures });

  if (allSigned) {
    try {
      const def = db.find('formDefinitions', (d) => d.isRTH);
      const submission = { id: r.id, data: r.data, submittedAt: nowISO() };
      // Leadership PDF — includes pay rate; for HR/Finance/CEO only.
      const bytes = await generateSubmissionPdf({ definition: def, submission, candidate: null, signatures: r.signatures });
      writeFileSync(join(PDF_DIR, `${r.id}.pdf`), bytes);
      // Permissions PDF — salary-free; this is what provisioners receive.
      const permBytes = await generatePermissionsPdf({ rth: r });
      writeFileSync(join(PDF_DIR, `${r.id}-permissions.pdf`), permBytes);

      // If linked to a candidate, everything ties back to their record.
      const linked = r.candidateId ? db.get('candidates', r.candidateId) : null;
      if (linked) {
        await sharepoint.fileDocument({ candidate: linked, fileName: `Request to Hire_${linked.lastName}_${linked.firstName}.pdf`, bytes }).catch(() => {});
        await graph.createAccount({ candidate: linked }).catch(() => {});
        db.update('candidates', linked.id, { rthId: r.id, accessStatus: 'approved' });
      } else {
        const [firstName, ...rest] = (r.data.candidateName || '').split(' ');
        await graph.createAccount({ candidate: { firstName, lastName: rest.join(' ') || '', email: r.data.email } }).catch(() => {});
      }
      await notify.email({ to: config.mailFrom, subject: `Request to Hire approved: ${r.data.candidateName}`, candidateId: linked?.id }).catch(() => {});
      // Auto-route: email each selected item's owner to provision + mark it done.
      await notifyAccessOwners(r).catch(() => {});
      db.update('accessRequests', r.id, { status: 'approved' });
    } catch (e) {
      // Signature is saved; approval did not complete. Surface it so it can be retried.
      return res.status(500).json({ error: 'Signature recorded, but finalizing the approval failed: ' + e.message, ...db.get('accessRequests', r.id) });
    }
  } else {
    db.update('accessRequests', r.id, { status: 'awaiting-signatures' });
    notifyApproverTurn(r, r.signatures.find((s) => !s.signedAt)).catch(() => {}); // email the next approver it's their turn
  }
  res.json(db.get('accessRequests', r.id));
});

api.get('/rth/:id/pdf', (req, res) => {
  const file = join(PDF_DIR, `${req.params.id}.pdf`);
  if (!existsSync(file)) return res.status(404).send('PDF is generated once all signatures are complete.');
  res.setHeader('Content-Type', 'application/pdf');
  res.send(readFileSync(file));
});

api.post('/rth/:id/provision', async (req, res) => {
  const { itemKey } = req.body;
  const r = db.get('accessRequests', req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  // Permissions requests have no approval step — they're provisionable once open.
  if (r.kind !== 'permissions' && r.status !== 'approved' && r.status !== 'provisioning') {
    return res.status(409).json({ error: 'Request to Hire must be fully approved before provisioning' });
  }
  const item = r.items.find((i) => i.key === itemKey);
  if (!item) return res.status(404).json({ error: 'item not found' });
  const linked = r.candidateId ? db.get('candidates', r.candidateId) : null;
  await graph.provisionAccess({ candidate: linked, item: { label: item.label, dept: item.dept } });
  item.status = 'provisioned';
  if (r.status !== 'terminated') r.status = r.items.every((i) => i.status === 'provisioned') ? 'complete' : 'provisioning';
  db.update('accessRequests', r.id, { items: r.items, status: r.status });
  res.json(db.get('accessRequests', r.id));
});

// Resolve software vs hardware for an item (old records may lack `kind`).
function kindOf(item) {
  if (item.kind) return item.kind;
  const def = db.find('formDefinitions', (d) => d.isRTH);
  return def?.accessCatalog?.find((a) => a.key === item.key)?.kind || 'software';
}
// Offboard a single item: software is revoked; equipment is return-requested.
async function offboardItem(linked, item) {
  if (kindOf(item) === 'hardware') {
    item.status = 'return-requested'; item.returnRequestedAt = nowISO();
    logCandidate(linked?.id, `Equipment return requested: ${item.label}`, 'revoke');
  } else {
    await graph.revokeAccess({ candidate: linked, item: { label: item.label, dept: item.dept } }).catch(() => {});
    item.status = 'revoked'; item.revokedAt = nowISO();
  }
}

// Offboarding — revoke a single access item (or request equipment return).
api.post('/rth/:id/revoke', async (req, res) => {
  const r = db.get('accessRequests', req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  const item = r.items.find((i) => i.key === req.body.itemKey);
  if (!item) return res.status(404).json({ error: 'item not found' });
  const linked = r.candidateId ? db.get('candidates', r.candidateId) : null;
  await offboardItem(linked, item);
  db.update('accessRequests', r.id, { items: r.items });
  res.json(db.get('accessRequests', r.id));
});

// Offboarding — mark returned equipment as received.
api.post('/rth/:id/return-received', (req, res) => {
  const r = db.get('accessRequests', req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  const item = r.items.find((i) => i.key === req.body.itemKey);
  if (!item) return res.status(404).json({ error: 'item not found' });
  item.status = 'returned'; item.returnedAt = nowISO();
  if (r.candidateId) logCandidate(r.candidateId, `Equipment received back: ${item.label}`, 'revoke');
  db.update('accessRequests', r.id, { items: r.items });
  res.json(db.get('accessRequests', r.id));
});

// Offboarding — set a termination date, revoke software + request equipment return.
api.post('/rth/:id/terminate', async (req, res) => {
  const r = db.get('accessRequests', req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  const linked = r.candidateId ? db.get('candidates', r.candidateId) : null;
  for (const item of r.items) {
    if (['revoked', 'return-requested', 'returned'].includes(item.status)) continue;
    await offboardItem(linked, item);
  }
  r.terminationDate = req.body.terminationDate || nowISO().slice(0, 10);
  r.status = 'terminated';
  if (linked) db.update('candidates', linked.id, { status: 'Terminated', terminationDate: r.terminationDate });
  db.update('accessRequests', r.id, { items: r.items, terminationDate: r.terminationDate, status: r.status });
  res.json(db.get('accessRequests', r.id));
});

// ===========================================================================
// PROVISIONER ROUTER — for whoever grants software/equipment access.
// Salary and approval details are NEVER exposed here.
// ===========================================================================
export const provisionerApi = Router();
provisionerApi.use(requireProvisioner);

const READY = ['approved', 'provisioning', 'complete'];
function permView(r) {
  return {
    id: r.id, status: r.status,
    candidateName: r.data?.candidateName, position: r.data?.position,
    startDate: r.data?.startDate, roleName: r.roleName, items: r.items, terminationDate: r.terminationDate,
    notes: { softwareOther: r.data?.softwareOther, hardwareOther: r.data?.hardwareOther, llmDetails: r.data?.llmDetails, adminPermissions: r.data?.adminPermissions },
    // NOTE: payRate / signatures deliberately omitted.
  };
}

provisionerApi.get('/provisioner/rth', (_req, res) => {
  res.json(db.filter('accessRequests', (r) => READY.includes(r.status)).map(permView));
});
provisionerApi.get('/provisioner/rth/:id', (req, res) => {
  const r = db.get('accessRequests', req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  if (!READY.includes(r.status)) return res.status(403).json({ error: 'Not yet approved' });
  res.json(permView(r));
});
provisionerApi.post('/provisioner/rth/:id/provision', async (req, res) => {
  const r = db.get('accessRequests', req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  if (r.kind !== 'permissions' && r.status !== 'approved' && r.status !== 'provisioning') return res.status(409).json({ error: 'Request to Hire must be approved first' });
  const item = r.items.find((i) => i.key === req.body.itemKey);
  if (!item) return res.status(404).json({ error: 'item not found' });
  const linked = r.candidateId ? db.get('candidates', r.candidateId) : null;
  await graph.provisionAccess({ candidate: linked, item: { label: item.label, dept: item.dept } });
  item.status = 'provisioned';
  r.status = r.items.every((i) => i.status === 'provisioned') ? 'complete' : 'provisioning';
  db.update('accessRequests', r.id, { items: r.items, status: r.status });
  res.json(permView(db.get('accessRequests', r.id)));
});
provisionerApi.get('/provisioner/rth/:id/pdf', (req, res) => {
  const file = join(PDF_DIR, `${req.params.id}-permissions.pdf`);
  if (!existsSync(file)) return res.status(404).send('not found');
  res.setHeader('Content-Type', 'application/pdf');
  res.send(readFileSync(file));
});
