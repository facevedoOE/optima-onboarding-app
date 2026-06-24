// ---------------------------------------------------------------------------
// One-time SharePoint backfill.
//
// Live filing is go-forward only — it happens when a PDF is created. If you
// enable SharePoint AFTER candidates have already completed forms, run this
// once to push the existing backlog (every retained PDF in data/pdfs) into the
// HR library, so the history is there too — not just new documents.
//
//   npm run backfill:sharepoint          # file everything to SharePoint
//   npm run backfill:sharepoint -- --dry # list what WOULD be filed, file nothing
//
// Safe to re-run: re-filing simply overwrites the same path. Reads the same
// data layer + adapter the app uses, so behaviour matches live filing exactly.
// ---------------------------------------------------------------------------
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { db } from './db.js';
import { sharepoint } from './adapters/integrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PDF_DIR = join(__dirname, '..', 'data', 'pdfs');
const DRY = process.argv.includes('--dry');

function fileNameFor(sub, candidate) {
  if (sub.fileName) return sub.fileName;
  const who = candidate ? `${candidate.lastName}_${candidate.firstName}` : 'record';
  return `${sub.formKey || 'document'}_${who}_${String(sub.id).slice(0, 8)}.pdf`;
}

async function main() {
  await db.init(); // load the store (Postgres or file) before reading it
  // Pre-flight: warn loudly if this run won't actually reach SharePoint.
  if (!config.live) {
    console.warn('⚠️  DEMO mode (no Entra creds) — filing is stubbed/logged, nothing reaches SharePoint. Set TENANT_ID/CLIENT_ID/CLIENT_SECRET to file for real.');
  } else if (!config.sharepoint.siteId) {
    console.error('✋ Live mode but SP_SITE_ID is blank — SharePoint isn\'t configured, so there is nothing to back-fill into. Set SP_SITE_ID first.');
    process.exit(1);
  }

  const submissions = db.all('submissions') || [];
  if (!submissions.length) {
    console.log('No submissions in the store — nothing to back-fill.');
    return;
  }

  const counts = { filed: 0, missingPdf: 0, failed: 0 };
  console.log(`${DRY ? '[DRY RUN] ' : ''}Backfilling ${submissions.length} submission(s) to SharePoint…\n`);

  for (const sub of submissions) {
    const candidate = sub.candidateId ? db.get('candidates', sub.candidateId) : null;
    const pdfPath = join(PDF_DIR, `${sub.id}.pdf`);
    const fileName = fileNameFor(sub, candidate);
    const who = candidate ? `${candidate.lastName}, ${candidate.firstName}` : 'Unassigned';

    if (!existsSync(pdfPath)) {
      counts.missingPdf++;
      console.warn(`  – skip (no PDF on disk): ${fileName}  [${who}]`);
      continue;
    }
    if (DRY) {
      console.log(`  • would file: ${fileName}  [${who}]`);
      counts.filed++;
      continue;
    }
    try {
      const bytes = readFileSync(pdfPath);
      const { path, skipped } = await sharepoint.fileDocument({ candidate, fileName, bytes });
      if (skipped) { counts.failed++; console.warn(`  ! not filed (SharePoint skipped): ${fileName}`); }
      else { counts.filed++; console.log(`  ✓ filed: ${fileName}  ->  ${path || '(library)'}`); }
    } catch (err) {
      counts.failed++;
      console.error(`  ✗ FAILED: ${fileName}  [${who}] — ${err.message}`);
    }
  }

  console.log(`\nDone. ${DRY ? 'Would file' : 'Filed'}: ${counts.filed}` +
    (counts.missingPdf ? ` · missing PDF: ${counts.missingPdf}` : '') +
    (counts.failed ? ` · failed: ${counts.failed}` : ''));
  await db.flush(); // ensure any activity-log writes land before exit
  if (counts.failed) process.exitCode = 1;
}

main().catch((e) => { console.error('Backfill crashed:', e); process.exit(1); });
