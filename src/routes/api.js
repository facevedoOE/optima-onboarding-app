import { Router } from 'express';
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, nowISO } from '../db.js';
import { config } from '../config.js';
import { requireAdmin, requireProvisioner, candidatePortalUrl } from '../auth.js';
import { generateSubmissionPdf, fillPdfTemplate, generatePermissionsPdf } from '../pdf.js';
import { sharepoint, graph, notify } from '../adapters/integrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PDF_DIR = join(__dirname, '..', '..', 'data', 'pdfs');
const UPLOAD_DIR = join(__dirname, '..', '..', 'data', 'uploads');
const TEMPLATES_DIR = join(__dirname, '..', '..', 'templates');
if (!existsSync(PDF_DIR)) mkdirSync(PDF_DIR, { recursive: true });
if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });

// Save base64 file-field uploads to disk + the candidate's HR folder; replace
// the field value with a readable list of filenames (so it's stored/shown cleanly).
async function processUploads(def, data, candidate, submissionId) {
  for (const f of def.fields) {
    if (f.type !== 'file' || !Array.isArray(data[f.key])) continue;
    const names = [];
    const dir = join(UPLOAD_DIR, submissionId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    for (const file of data[f.key]) {
      const b64 = String(file.data || '').split(',').pop();
      const bytes = Buffer.from(b64, 'base64');
      const safe = String(file.name || 'upload').replace(/[^\w.\-]+/g, '_');
      writeFileSync(join(dir, safe), bytes);
      await sharepoint.fileDocument({ candidate, fileName: safe, bytes }).catch(() => {});
      names.push(file.name);
    }
    data[f.key] = names.join(', ');
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
    };
  });
  const r = db.find('accessRequests', (a) => a.candidateId === c.id);
  const rth = r ? { id: r.id, status: r.status, roleName: r.roleName } : null;
  const references = db.filter('references', (x) => x.candidateId === c.id);
  return { ...c, checklist, submissions: subs, rth, references };
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

  const missing = def.fields.filter((f) => f.required && !data?.[f.key]).map((f) => f.label);
  if (missing.length) return res.status(400).json({ error: 'Missing required fields', missing });

  const submission = db.insert('submissions', { candidateId, formKey, data: {}, status: 'complete', submittedAt: nowISO() });
  // Save uploaded documents to the HR folder, then store the cleaned answers.
  await processUploads(def, data, candidate, submission.id);
  db.update('submissions', submission.id, { data });

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
api.get('/forms', (_req, res) => res.json(db.all('formDefinitions')));
api.post('/forms', (req, res) => {
  const { key, title, description, appliesTo = 'all', fields = [] } = req.body;
  if (!key || !title) return res.status(400).json({ error: 'key and title required' });
  if (db.find('formDefinitions', (d) => d.key === key)) return res.status(409).json({ error: 'key exists' });
  res.status(201).json(db.insert('formDefinitions', { id: key, key, title, description, appliesTo, fields, version: 1 }));
});
api.put('/forms/:key', (req, res) => {
  const f = db.find('formDefinitions', (d) => d.key === req.params.key);
  if (!f) return res.status(404).json({ error: 'not found' });
  const patch = { ...req.body };
  delete patch.id; delete patch.key;
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
    const remindedToday = r.lastReminderAt && daysSince(r.lastReminderAt) < 1;
    if (d > 0 && d % REMINDER_EVERY_DAYS === 0 && !remindedToday) {
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
  if (secret && req.body?.secret !== secret && req.headers['x-webhook-secret'] !== secret) {
    return res.status(401).json({ error: 'invalid webhook secret' });
  }
  const email = String(req.body?.referenceEmail || '').trim().toLowerCase();
  const name = String(req.body?.referenceName || '').trim().toLowerCase();
  const ref = db.find('references', (r) => r.status !== 'received'
    && ((email && (r.email || '').toLowerCase() === email) || (name && (r.name || '').toLowerCase() === name)));
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
  const def = db.find('formDefinitions', (d) => d.isRTH);
  const missing = def.fields.filter((f) => f.required && !data?.[f.key]).map((f) => f.label);
  if (missing.length) return res.status(400).json({ error: 'Missing required fields', missing });
  // Link to a candidate record by stable ID — the thread that connects the lifecycle.
  const linked = candidateId ? db.get('candidates', candidateId) : null;
  const finalData = { ...data };
  if (linked) finalData.candidateName = `${linked.firstName} ${linked.lastName}`;
  const role = db.get('accessRoles', roleId);
  const signatures = def.signatureChain.map((s) => ({ ...s, signedAt: null, signedBy: null }));
  const items = (accessItems || []).map((key) => {
    const item = def.accessCatalog.find((a) => a.key === key);
    return { key, label: item?.label, dept: def.departments[item?.dept] || item?.dept, status: 'requested' };
  });
  res.status(201).json(db.insert('accessRequests', { candidateId: linked?.id || null, data: finalData, roleId, roleName: role?.name, signatures, items, status: 'awaiting-signatures' }));
});

api.post('/rth/:id/sign', async (req, res) => {
  const { stepKey } = req.body;
  const user = req.session.user;
  const r = db.get('accessRequests', req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });

  const idx = r.signatures.findIndex((s) => s.key === stepKey);
  if (idx === -1) return res.status(404).json({ error: 'unknown step' });
  const step = r.signatures[idx];

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
  r.status = allSigned ? 'approved' : 'awaiting-signatures';
  db.update('accessRequests', r.id, { signatures: r.signatures, status: r.status });

  if (allSigned) {
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
    await notify.email({ to: config.mailFrom, subject: `RTH approved: ${r.data.candidateName}`, candidateId: linked?.id }).catch(() => {});
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
  if (r.status !== 'approved' && r.status !== 'provisioning') {
    return res.status(409).json({ error: 'RTH must be fully approved before provisioning' });
  }
  const item = r.items.find((i) => i.key === itemKey);
  if (!item) return res.status(404).json({ error: 'item not found' });
  const linked = r.candidateId ? db.get('candidates', r.candidateId) : null;
  await graph.provisionAccess({ candidate: linked, item: { label: item.label, dept: item.dept } });
  item.status = 'provisioned';
  r.status = r.items.every((i) => i.status === 'provisioned') ? 'complete' : 'provisioning';
  db.update('accessRequests', r.id, { items: r.items, status: r.status });
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
    startDate: r.data?.startDate, roleName: r.roleName, items: r.items,
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
  if (r.status !== 'approved' && r.status !== 'provisioning') return res.status(409).json({ error: 'RTH must be approved first' });
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
