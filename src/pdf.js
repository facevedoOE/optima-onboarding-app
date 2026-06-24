// ---------------------------------------------------------------------------
// PDF generation.
//
// Generates a completed PDF from a submission + its form definition. Because
// the PDF is rendered from the schema + data, changing a form NEVER means
// editing a Word doc and re-exporting a PDF. The document follows the form.
// ---------------------------------------------------------------------------
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// Fill an OFFICIAL fillable PDF (e.g. the county CCPS packet) with the candidate's
// answers, so the output IS the real form. Each form field maps to one or more PDF
// field names via `field.pdf`. Unknown/locked fields are skipped, never fatal.
export async function fillPdfTemplate({ templateBytes, definition, data }) {
  const pdf = await PDFDocument.load(templateBytes);
  const form = pdf.getForm();
  const setText = (n, v) => { try { form.getTextField(n).setText(String(v ?? '')); } catch (e) {} };
  const setCheck = (n, v) => { try { const c = form.getCheckBox(n); v ? c.check() : c.uncheck(); } catch (e) {} };
  const setChoice = (n, v) => { try { form.getDropdown(n).select(String(v)); } catch (e) { setText(n, v); } };

  for (const f of definition.fields) {
    const v = data?.[f.key];
    if (v === undefined || v === '' || v === false) continue;
    for (const n of (f.pdf || [])) {
      if (f.type === 'checkbox') setCheck(n, !!v);
      else if (f.type === 'select') setChoice(n, v);
      else setText(n, v);
    }
  }
  // Some PDFs repeat the applicant's full name across pages.
  if (definition.fullNameFields && (data.firstName || data.lastName)) {
    const full = `${data.firstName || ''} ${data.lastName || ''}`.trim();
    for (const n of definition.fullNameFields) setText(n, full);
  }
  try { form.updateFieldAppearances(); } catch (e) {}
  return await pdf.save();
}

const BLUE = rgb(0.055, 0.11, 0.259); // #0E1C42
const BIT = rgb(0.333, 0.784, 0.91); // #55C8E8
const GREY = rgb(0.42, 0.45, 0.5);
const LINE = rgb(0.89, 0.91, 0.94);
const ORANGE = rgb(0.969, 0.561, 0.118); // #F78F1E — used for the "updated" banner
const WHITE = rgb(1, 1, 1);

function pretty(value) {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  if (Array.isArray(value)) return value.join(', ');
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

// Permissions-only document for whoever provisions access. Deliberately omits
// salary and approval details so permission-granters never see pay.
export async function generatePermissionsPdf({ rth, updated = false }) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([612, 792]);
  const M = 54; let y = 792 - M;
  const ensure = (n) => { if (y - n < M) { page = pdf.addPage([612, 792]); y = 792 - M; } };
  const clip = (s) => String(s).length > 88 ? String(s).slice(0, 85) + '…' : String(s);

  page.drawRectangle({ x: 0, y: 792 - 8, width: 612, height: 8, color: BIT });
  page.drawText('OPTIMA', { x: M, y, size: 20, font: bold, color: BLUE }); y -= 28;
  page.drawText('Access Provisioning — Request to Hire', { x: M, y, size: 15, font: bold, color: BLUE }); y -= 16;
  page.drawText(`${rth.data?.candidateName || ''} · ${rth.data?.position || ''} · starts ${rth.data?.startDate || ''}`, { x: M, y, size: 10, font, color: GREY }); y -= 13;
  page.drawText(`Role: ${rth.roleName || 'Custom access'}`, { x: M, y, size: 9, font, color: GREY }); y -= 10;
  page.drawLine({ start: { x: M, y }, end: { x: M + (612 - M * 2), y }, thickness: 1, color: LINE }); y -= 22;

  // Obvious banner so recipients can tell at a glance this is a revised form.
  if (updated) {
    ensure(34);
    page.drawRectangle({ x: M, y: y - 22, width: 612 - M * 2, height: 26, color: ORANGE });
    page.drawText('UPDATED FORM — PERMISSIONS REVISED, PLEASE REVIEW', { x: M + 10, y: y - 14, size: 11, font: bold, color: WHITE });
    y -= 40;
  }

  const byDept = {};
  for (const it of (rth.items || [])) (byDept[it.dept] = byDept[it.dept] || []).push(it);
  for (const [dept, items] of Object.entries(byDept)) {
    ensure(30);
    page.drawText(String(dept).toUpperCase(), { x: M, y, size: 9, font: bold, color: BIT }); y -= 16;
    for (const it of items) { ensure(16); page.drawText(`•  ${it.label}  (${it.status})`, { x: M + 8, y, size: 10, font, color: BLUE }); y -= 14; }
    y -= 6;
  }
  const notes = [['Mailing address', rth.data?.mailingAddress], ['Other software', rth.data?.softwareOther], ['Other hardware', rth.data?.hardwareOther], ['LLM / AI', rth.data?.llmDetails], ['Admin permissions', rth.data?.adminPermissions]].filter(([, v]) => v);
  if (notes.length) {
    ensure(24); page.drawText('NOTES', { x: M, y, size: 9, font: bold, color: BIT }); y -= 16;
    for (const [k, v] of notes) { ensure(16); page.drawText(`${k}: ${clip(v)}`, { x: M, y, size: 10, font, color: BLUE }); y -= 14; }
  }
  page.drawText('Salary and approval details are intentionally omitted from this permissions document.', { x: M, y: M - 18, size: 7, font, color: GREY });
  return await pdf.save();
}

export async function generateSubmissionPdf({ definition, submission, candidate, signatures }) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page = pdf.addPage([612, 792]); // US Letter
  const M = 54;
  const W = 612 - M * 2;
  let y = 792 - M;

  const ensureSpace = (need) => {
    if (y - need < M) {
      page = pdf.addPage([612, 792]);
      y = 792 - M;
    }
  };

  // Header band
  page.drawRectangle({ x: 0, y: 792 - 8, width: 612, height: 8, color: BIT });
  page.drawText('OPTIMA', { x: M, y, size: 20, font: bold, color: BLUE });
  page.drawText('Education Experience Company', { x: M + 86, y: y + 3, size: 8, font, color: GREY });
  y -= 30;
  page.drawText(definition.title, { x: M, y, size: 16, font: bold, color: BLUE });
  y -= 16;
  if (candidate) {
    page.drawText(`${candidate.firstName} ${candidate.lastName}  ·  ${candidate.position || ''}`,
      { x: M, y, size: 10, font, color: GREY });
    y -= 14;
  }
  page.drawText(`Submitted ${new Date(submission.submittedAt || Date.now()).toLocaleString('en-US')}`,
    { x: M, y, size: 8, font, color: GREY });
  y -= 10;
  page.drawLine({ start: { x: M, y }, end: { x: M + W, y }, thickness: 1, color: LINE });
  y -= 24;

  // Fields
  for (const f of definition.fields) {
    if (f.type === 'section') {
      ensureSpace(36);
      page.drawText(String(f.label).toUpperCase(), { x: M, y, size: 9, font: bold, color: BIT });
      y -= 18;
      continue;
    }
    const valRaw = submission.data?.[f.key];
    const val = f.type === 'attestation'
      ? (valRaw ? 'Acknowledged & accepted' : 'Not accepted')
      : pretty(valRaw);

    // wrap value text
    const maxChars = 70;
    const words = val.split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > maxChars) { lines.push(cur.trim()); cur = w; }
      else cur += ' ' + w;
    }
    if (cur.trim()) lines.push(cur.trim());
    if (lines.length === 0) lines.push('—');

    ensureSpace(16 + lines.length * 13);
    page.drawText(f.label, { x: M, y, size: 8, font: bold, color: GREY });
    y -= 13;
    for (const ln of lines) {
      page.drawText(ln, { x: M, y, size: 11, font, color: BLUE });
      y -= 13;
    }
    y -= 6;
  }

  // Signature chain (RTH)
  if (signatures && signatures.length) {
    ensureSpace(40);
    y -= 6;
    page.drawLine({ start: { x: M, y }, end: { x: M + W, y }, thickness: 1, color: LINE });
    y -= 18;
    page.drawText('SIGNATURE CHAIN', { x: M, y, size: 9, font: bold, color: BIT });
    y -= 18;
    for (const s of signatures) {
      ensureSpace(16);
      const status = s.signedAt
        ? `Signed by ${s.signedBy} on ${new Date(s.signedAt).toLocaleString('en-US')}`
        : 'Pending';
      page.drawText(`${s.label} (${s.role})`, { x: M, y, size: 10, font: bold, color: BLUE });
      page.drawText(status, { x: M + 200, y, size: 9, font, color: s.signedAt ? rgb(0.2, 0.55, 0.2) : GREY });
      y -= 16;
    }
  }

  // Footer
  page.drawText('Generated by the Optima Onboarding system — completed record of submission.',
    { x: M, y: M - 18, size: 7, font, color: GREY });

  return await pdf.save();
}
