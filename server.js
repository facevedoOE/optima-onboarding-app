import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './src/config.js';
import { setupAuth, requireAuth } from './src/auth.js';
import { api, portalApi, webhookRouter, runReferenceReminders } from './src/routes/api.js';
import { db } from './src/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Auth (mounts /api/me, /auth/*) must come before protected routes.
setupAuth(app);

// Webhooks are called by Adobe (no session) — mount before the auth guard.
app.use('/api/webhooks', webhookRouter);

// All /api requires sign-in. Candidate-safe portal routes first (self-scoped),
// then admin-only routes. A candidate hitting an admin route falls through to
// requireAdmin inside the admin router → 403.
app.use('/api', requireAuth, portalApi);
app.use('/api', api);

// Brand assets ship inside the app (public/assets) so it's self-contained.
app.use(express.static(join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));

if (db.all('formDefinitions').length === 0) {
  console.log('Empty store — seeding…');
  await import('./src/seed.js');
}

// Step 5: run reference reminders/escalations daily (production scheduler).
setInterval(() => { runReferenceReminders().catch(() => {}); }, 24 * 60 * 60 * 1000);

app.listen(config.port, () => console.log(`Optima Onboarding running at ${config.baseUrl}`));
