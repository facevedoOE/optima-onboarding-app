// ---------------------------------------------------------------------------
// Authentication & authorization.
//
// Two login tiers, a hard wall between them:
//   admin     — internal staff. live: Microsoft (Entra) SSO. demo: one click.
//               Approver rights (HR / Finance / CEO) come from Entra groups
//               (live) and gate which RTH signature steps they may sign.
//   candidate — new hire. live + demo: a signed magic-link/email-code token
//               (no Optima account needed). Scoped to their OWN record only.
//
// Result either way: req.session.user = { role, name, email, candidateId?, approverRoles? }
// ---------------------------------------------------------------------------
import session from 'express-session';
import FileStoreFactory from 'session-file-store';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfidentialClientApplication } from '@azure/msal-node';
import { config } from './config.js';
import { db } from './db.js';

const FileStore = FileStoreFactory(session);
const SESSIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'sessions');

const APPROVER_ROLES = ['HR', 'Finance', 'CEO'];

let cca = null;
function msal() {
  if (!cca) {
    cca = new ConfidentialClientApplication({
      auth: { clientId: config.clientId, authority: config.authority, clientSecret: config.clientSecret },
    });
  }
  return cca;
}

// --- candidate magic-link tokens (stateless, signed) ------------------------
function sign(payload) {
  return createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}
export function createCandidateToken(candidateId, days = 14) {
  const payload = `${candidateId}.${Date.now() + days * 864e5}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}
export function verifyCandidateToken(token) {
  const [b64, sig] = String(token || '').split('.');
  if (!b64 || !sig) return null;
  const payload = Buffer.from(b64, 'base64url').toString();
  const expected = sign(payload);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const [candidateId, exp] = payload.split('.');
  if (Date.now() > Number(exp)) return null;
  return candidateId;
}
export function candidatePortalUrl(candidateId) {
  return `${config.baseUrl}/auth/candidate?token=${createCandidateToken(candidateId)}`;
}

export function setupAuth(app) {
  app.use(session({
    // Persist sessions to disk so they survive restarts (the default MemoryStore
    // drops every session on restart and leaks memory). On Azure's ephemeral
    // filesystem this still resets on redeploy — a SQL/Redis store is the next
    // step for multi-instance scale, but this is correct for a single instance.
    store: new FileStore({ path: SESSIONS_DIR, retries: 1, logFn: () => {} }),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.live },
  }));

  app.get('/api/me', (req, res) => {
    res.json({
      authenticated: Boolean(req.session.user),
      user: req.session.user || null,
      mode: config.live ? 'live' : 'demo',
      pendingCandidate: Boolean(req.session.pendingCandidateId),
    });
  });

  // --- candidate sign-in via magic link (both modes) ------------------------
  // Step 1: the link identifies the candidate, but does NOT sign them in yet.
  app.get('/auth/candidate', (req, res) => {
    const candidateId = verifyCandidateToken(req.query.token);
    const cand = candidateId && db.get('candidates', candidateId);
    if (!cand) return res.status(401).send('This onboarding link is invalid or has expired. Please contact HR.');
    req.session.pendingCandidateId = cand.id;
    delete req.session.user; // force email confirmation on every link click
    res.redirect('/');
  });

  // Step 2: candidate must confirm the email HR entered for them. Only that email works.
  app.post('/auth/candidate/verify', (req, res) => {
    const cand = req.session.pendingCandidateId && db.get('candidates', req.session.pendingCandidateId);
    if (!cand) return res.status(401).json({ error: 'Your sign-in link has expired. Please use the link HR emailed you.' });
    const entered = String(req.body?.email || '').trim().toLowerCase();
    if (!entered || entered !== String(cand.email || '').trim().toLowerCase()) {
      return res.status(401).json({ error: 'That email doesn’t match our records. Please enter the email address you used to apply.' });
    }
    req.session.user = { role: 'candidate', candidateId: cand.id, name: `${cand.firstName} ${cand.lastName}`, email: cand.email };
    delete req.session.pendingCandidateId;
    res.json({ ok: true });
  });

  if (config.live) {
    // --- admin: Microsoft sign-in -------------------------------------------
    app.get('/auth/login', async (req, res, next) => {
      try {
        res.redirect(await msal().getAuthCodeUrl({ scopes: ['openid', 'profile', 'email'], redirectUri: config.baseUrl + config.redirectPath }));
      } catch (e) { next(e); }
    });
    app.get(config.redirectPath, async (req, res, next) => {
      try {
        const result = await msal().acquireTokenByCode({ code: req.query.code, scopes: ['openid', 'profile', 'email'], redirectUri: config.baseUrl + config.redirectPath });
        const c = result.idTokenClaims || {};
        req.session.user = { role: 'admin', name: c.name || c.preferred_username, email: c.preferred_username || c.email, approverRoles: mapApproverRoles(c.roles || c.groups) };
        res.redirect('/');
      } catch (e) { next(e); }
    });
    app.get('/auth/logout', (req, res) => req.session.destroy(() => res.redirect(`${config.authority}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(config.baseUrl)}`)));
  } else {
    // --- demo: one-click admin + candidate picker ---------------------------
    app.post('/auth/dev-admin', (req, res) => {
      req.session.user = { role: 'admin', name: 'Admin User', email: 'admin@optimaed.com', approverRoles: APPROVER_ROLES };
      res.json(req.session.user);
    });
    app.get('/auth/demo-candidates', (req, res) => {
      res.json(db.all('candidates').map((c) => ({ id: c.id, name: `${c.firstName} ${c.lastName}` })));
    });
    app.post('/auth/dev-candidate', (req, res) => {
      const c = db.get('candidates', req.body?.candidateId);
      if (!c) return res.status(404).json({ error: 'no such candidate' });
      req.session.user = { role: 'candidate', candidateId: c.id, name: `${c.firstName} ${c.lastName}`, email: c.email };
      res.json(req.session.user);
    });
    app.post('/auth/dev-provisioner', (req, res) => {
      req.session.user = { role: 'provisioner', name: 'Provisioner', email: 'it@optimaed.com' };
      res.json(req.session.user);
    });
    app.get('/auth/logout', (req, res) => req.session.destroy(() => res.redirect('/')));
  }
}

// Entra app-role / group values -> approver roles. Map to your app registration.
function mapApproverRoles(claims = []) {
  return APPROVER_ROLES.filter((r) => claims.includes(r) || claims.includes(`Approver.${r}`));
}

export function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  res.status(401).json({ error: 'Not authenticated' });
}
export function requireAdmin(req, res, next) {
  if (req.session?.user?.role === 'admin') return next();
  res.status(403).json({ error: 'Admin access required' });
}
// Permission-granters: provisioners (salary-free view) or admins.
export function requireProvisioner(req, res, next) {
  const r = req.session?.user?.role;
  if (r === 'provisioner' || r === 'admin') return next();
  res.status(403).json({ error: 'Provisioner access required' });
}
