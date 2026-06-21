import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './src/config.js';
import { setupAuth, requireAuth } from './src/auth.js';
import { api, portalApi, provisionerApi, webhookRouter, runReferenceReminders } from './src/routes/api.js';
import { db } from './src/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// Behind Azure App Service's HTTPS reverse proxy: trust the first proxy so
// secure cookies and req.protocol/req.ip work correctly.
app.set('trust proxy', 1);

// Content Security Policy. We deliberately embed third-party documents
// (Adobe Sign, Microsoft Forms/Bookings) in iframes, so frame-src allows those
// origins; everything else is locked to same-origin.
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self' https://*.adobe.com https://*.documents.adobe.com https://*.microsoft.com https://*.office.com https://*.office365.com https://*.sharepoint.com https://forms.office.com https://outlook.office365.com",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json({ limit: '25mb' })); // allows base64 document uploads
app.use(express.urlencoded({ extended: true }));

// Auth (mounts /api/me, /auth/*) must come before protected routes.
setupAuth(app);

// Webhooks are called by Adobe (no session) — mount before the auth guard.
app.use('/api/webhooks', webhookRouter);

// All /api requires sign-in. Candidate-safe portal routes first (self-scoped),
// then admin-only routes. A candidate hitting an admin route falls through to
// requireAdmin inside the admin router → 403.
app.use('/api', requireAuth, portalApi);
app.use('/api', requireAuth, provisionerApi);
app.use('/api', api);

// Brand assets ship inside the app (public/assets) so it's self-contained.
app.use(express.static(join(__dirname, 'public')));
// Serve bundled blank form templates (e.g. the county CCPS PDF) for embedding.
app.use('/templates', express.static(join(__dirname, 'templates')));
app.get('*', (_req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));

// Seed on first run. In live mode we ONLY seed configuration (form definitions +
// access roles) — never demo candidates. In demo mode we load the full dataset.
if (db.all('formDefinitions').length === 0) {
  console.log('Empty store — seeding…');
  const { seedConfig, seedDemo } = await import('./src/seed.js');
  if (config.live) seedConfig(); else seedDemo();
}

// Step 5: run reference reminders/escalations daily (production scheduler).
setInterval(() => { runReferenceReminders().catch(() => {}); }, 24 * 60 * 60 * 1000);

app.listen(config.port, () => console.log(`Optima Onboarding running at ${config.baseUrl}`));
