import { Router } from 'express';
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, nowISO } from '../db.js';
import { config } from '../config.js';
import { requireAdmin, candidatePortalUrl } from '../auth.js';
import { generateSubmissionPdf } from '../pdf.js';
import { sharepoint, graph, notify } from '../adapters/integrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PDF_DIR = join(__dirname, '..', '..', 'data', 'pdfs');
if (!existsSync(PDF_DIR)) mkdirSync(PDF_DIR, { recursive: true });

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
    return { key: d.key, title: d.title, description: d.description, status: sub ? sub.status : 'pending', submissionId: sub?.id };
  });
  const r = db.find('accessRequests', (a) => a.candidateId === c.id);
  const rth = r ? { id: r.id, status: r.status, roleName: r.roleName } : null;
  return { ...c, checklist, submissions: subs, rth };
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

  const submission = db.insert('submissions', { candidateId, formKey, data, status: 'complete', submittedAt: nowISO() });
  const { fileName, filedPath } = await buildAndFilePdf({ definition: def, submission, candidate });
  db.update('submissions', submission.id, { fileName, filedPath });
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
    const bytes = await generateSubmissionPdf({ definition: def, submission, candidate: null, signatures: r.signatures });
    writeFileSync(join(PDF_DIR, `${r.id}.pdf`), bytes);

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
