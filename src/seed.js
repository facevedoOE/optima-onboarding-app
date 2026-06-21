// ---------------------------------------------------------------------------
// Seed data.
//
// Form definitions are translated from the 13 Power Automate flows that run the
// onboarding today. The point: every form below is just DATA. Adding the new
// CCPS form, or two fields to Request to Hire, means editing a definition here
// (or in the in-app Form Builder) — no recreating PDFs, no re-linking, no flow
// surgery.
// ---------------------------------------------------------------------------
import { db } from './db.js';

// Reusable field-type reference (what the renderer understands):
//   text | email | tel | date | number | textarea | select | multiselect
//   | checkbox | attestation | signature | section
// Each field: { key, label, type, required?, options?, help?, placeholder? }

const EMPLOYEE_TYPES = [
  'OptimaEd (Corporate)',
  'Optima Academy Online — Full-Time',
  'Optima Academy Online — Contractor',
];

const formDefinitions = [
  {
    id: 'intake',
    key: 'intake',
    title: 'New Hire Intake',
    description: 'Kicks off onboarding. Creates the candidate record everything else hangs off of.',
    appliesTo: 'all',
    internalOnly: true, // HR fills this, not the new hire
    version: 3,
    fields: [
      { key: 'firstName', label: 'First Name', type: 'text', required: true },
      { key: 'lastName', label: 'Last Name', type: 'text', required: true },
      { key: 'email', label: 'Personal Email', type: 'email', required: true },
      { key: 'position', label: 'Position', type: 'text', required: true },
      { key: 'startDate', label: 'Start Date', type: 'date', required: true },
      { key: 'employeeType', label: 'Employee Type', type: 'select', required: true, options: EMPLOYEE_TYPES },
    ],
  },
  {
    id: 'references',
    key: 'references',
    title: 'Professional References',
    description: 'Three references who directly supervised your work in a leadership capacity.',
    appliesTo: 'all',
    version: 1,
    fields: [
      { key: 'ref1Name', label: 'Reference 1 — Name', type: 'text', required: true },
      { key: 'ref1Email', label: 'Reference 1 — Email', type: 'email', required: true },
      { key: 'ref1Relationship', label: 'Reference 1 — Relationship', type: 'text' },
      { key: 'ref2Name', label: 'Reference 2 — Name', type: 'text', required: true },
      { key: 'ref2Email', label: 'Reference 2 — Email', type: 'email', required: true },
      { key: 'ref2Relationship', label: 'Reference 2 — Relationship', type: 'text' },
      { key: 'ref3Name', label: 'Reference 3 — Name', type: 'text', required: true },
      { key: 'ref3Email', label: 'Reference 3 — Email', type: 'email', required: true },
      { key: 'ref3Relationship', label: 'Reference 3 — Relationship', type: 'text' },
    ],
  },
  {
    id: 'clearinghouse',
    key: 'clearinghouse',
    title: 'Clearinghouse Background Screening',
    description: 'Complete and sign the official Clearinghouse form exactly as-is on the embedded Adobe document below.',
    appliesTo: 'oao',
    version: 2,
    // EMBED: the real Adobe Sign Clearinghouse document (must be completed as-is).
    type: 'embed',
    embedUrl: 'https://na4.documents.adobe.com/public/esignWidget?wid=CBFCIBAA3AAABLblqZhA2h_5lYWkTp1QPBeLkCn9ypNhkOyHoYnJ-UYmAdRJK9EZugYwGztdSwgXYe-XvZ4o*',
    fields: [],
  },
  {
    id: 'ccps-charter',
    key: 'ccps-charter',
    title: 'CCPS — Charter School Employee (Full-Time)',
    description: 'Complete your part of the official Collier County packet here. Your answers fill the real county PDF, which is saved to your HR folder for signature and submission.',
    appliesTo: 'oao-fulltime',
    version: 3,
    // PDF-TEMPLATE form: fields fill the actual county PDF (templates/ccps-fulltime.pdf).
    // `pdf` lists the real PDF field name(s) each answer fills.
    type: 'pdfTemplate',
    pdfTemplate: 'ccps-fulltime.pdf',
    fullNameFields: ['Applicant Name', 'Name Please Print'],
    fields: [
      { key: 'certifiedType', label: 'Employee Type', type: 'select', required: true,
        options: ['Select One', 'Administrator', 'Board Member', 'Certified Instructional', 'Certified Staff', 'Certified Daily Sub', 'Certified Long Term Substitute', 'Certified Athletic Coach', 'Non-Certified Staff'],
        pdf: ['Certified/Non-Certified'] },
      { key: 'school', label: 'Charter School', type: 'select', required: true,
        options: ['9040 - Optima Classical Academy (OCA)', '9041 - Autism Collier Charter School (ACS)', '9037 - BridgePrep Academy (BPA)', '9034 - Gulf Coast Charter Academy South (GCA)', '9021 - Immokalee Community Academy (ICS)', '9036 - Innovation Preparatory Academy of Naples (IPA)', '9032 - Marco Island Academy (MIA)', '9018 - Marco Island Charter Middle (MCM)', '9035 - Mason Classical Academy (MCA)', '9039 - Naples Classical Academy (NCA)'],
        pdf: ['School List'] },
      { key: 'firstName', label: 'Legal First Name', type: 'text', required: true, pdf: ['First Name'] },
      { key: 'lastName', label: 'Legal Last Name', type: 'text', required: true, pdf: ['Last Name'] },
      { key: 'ssn', label: 'Social Security Number', type: 'text', required: true, pdf: ['Social Security Number', 'Social Security'] },
      { key: 'birthDate', label: 'Date of Birth', type: 'date', required: true, pdf: ['Birth Date'] },
      { key: 'gender', label: 'Gender', type: 'select', options: ['Select one', 'Male', 'Female'], pdf: ['Gender'] },
      { key: 'address', label: 'Street Address', type: 'text', required: true, pdf: ['Address'] },
      { key: 'city', label: 'City', type: 'text', required: true, pdf: ['City'] },
      { key: 'state', label: 'State', type: 'text', required: true, pdf: ['State'] },
      { key: 'zip', label: 'Zip Code', type: 'text', required: true, pdf: ['Zip Code'] },
      { key: 'phone', label: 'Phone Number', type: 'tel', required: true, pdf: ['Phone Number', 'Phone'] },
      { key: 'email', label: 'Email', type: 'email', required: true, pdf: ['Email', 'Email Address'] },
      { key: 'position', label: 'Position', type: 'text', required: true, pdf: ['Position', 'Position Title'] },
      { key: 'subject', label: 'Subject Being Taught (required if Certified)', type: 'text', pdf: ['Subject Being Taught (Required for Certified)'] },
      { key: 'startDate', label: 'Start Date', type: 'date', required: true, pdf: ['Start Date'] },
      { key: 'newTeacher', label: 'New Teacher?', type: 'select', options: ['Select One', 'Yes', 'No', 'N/A - Non-certified/Non-licensed employee'], pdf: ['New Teacher'] },
      { key: 'employeeId', label: 'Employee ID Number (if known)', type: 'text', pdf: ['Employee ID Number'] },
      { key: 'jobTitleDept', label: 'Job Title & School/Department', type: 'text', pdf: ['Job Title and SchoolDepartment'] },
      { key: 'networkUsername', label: 'Network Username (if assigned)', type: 'text', pdf: ['Network Username'] },
      { key: 'accNetwork', label: 'Requesting: Network access', type: 'checkbox', pdf: ['network'] },
      { key: 'accEmail', label: 'Requesting: Email access', type: 'checkbox', pdf: ['email'] },
      { key: 'accTerms', label: 'Requesting: TERMS access', type: 'checkbox', pdf: ['TERMS'] },
      { key: 'accFocus', label: 'Requesting: Focus access', type: 'checkbox', pdf: ['Focus'] },
      { key: 'attest', label: 'I certify the information above is accurate and complete.', type: 'attestation', required: true },
    ],
  },
  {
    id: 'ccps-contractor',
    key: 'ccps-contractor',
    title: 'CCPS — Charter School Contractor (Part-Time)',
    description: 'Official Collier County charter contractor form — complete it exactly as-is on the embedded Adobe document below.',
    appliesTo: 'oao-contractor',
    version: 3,
    // EMBED form: rendered as the real Adobe Sign document in an iframe (not rebuilt as fields),
    // because it must be completed exactly as-is. Adobe's webhook → your existing flow files the signed PDF.
    type: 'embed',
    embedUrl: 'https://na4.documents.adobe.com/public/esignWidget?wid=CBFCIBAA3AAABLblqZhDOLvmoMkWYhuOIEpwucoxOHgt0XhsdtJaHKfqt7XqLja9Rjyiy1EVJsZKFS84P5v8*',
    fields: [],
  },
  {
    id: 'teacher-cert',
    key: 'teacher-cert',
    title: 'Teacher Certification Information',
    description: 'Certification details for instructional staff.',
    appliesTo: 'oao',
    version: 1,
    fields: [
      { key: 'certState', label: 'Certification State', type: 'text' },
      { key: 'certNumber', label: 'Certificate Number', type: 'text' },
      { key: 'certAreas', label: 'Certification Area(s)', type: 'textarea' },
      { key: 'expiration', label: 'Expiration Date', type: 'date' },
    ],
  },
];

// The reference attestation a reference fills out (replaces the Adobe Sign web form).
formDefinitions.push({
  id: 'reference-response',
  key: 'reference-response',
  title: 'Reference Response',
  description: 'Completed by a candidate’s professional reference.',
  appliesTo: 'reference',
  version: 1,
  fields: [
    { key: 'referenceName', label: 'Your Name', type: 'text', required: true },
    { key: 'relationship', label: 'Your Relationship to the Candidate', type: 'text', required: true },
    { key: 'capacity', label: 'In what capacity did you supervise them?', type: 'textarea', required: true },
    { key: 'rating', label: 'Overall Recommendation', type: 'select', required: true,
      options: ['Strongly Recommend', 'Recommend', 'Recommend with Reservations', 'Do Not Recommend'] },
    { key: 'comments', label: 'Comments', type: 'textarea' },
    { key: 'attest', label: 'The information I have provided is true and accurate.', type: 'attestation', required: true },
  ],
});

// --- Request to Hire base fields (the readable replacement for the wide Excel) -
const requestToHire = {
  id: 'request-to-hire',
  key: 'request-to-hire',
  title: 'Request to Hire',
  description: 'Approval + access request for a new hire. Routes through a signature chain, then provisions access by role.',
  appliesTo: 'internal',
  internalOnly: true,
  isRTH: true, // signals the special role-based access + signature chain UI
  version: 2,
  // Signature chain — replaces the Adobe Sign "RTH_Leadership" sequential agreement.
  signatureChain: [
    { key: 'hr', role: 'HR', label: 'HR Manager' },
    { key: 'finance', role: 'Finance', label: 'Finance' },
    { key: 'ceo', role: 'CEO', label: 'CEO' },
  ],
  fields: [
    { key: 'candidateName', label: 'Candidate Name', type: 'text', required: true },
    { key: 'position', label: 'Position', type: 'text', required: true },
    { key: 'employeeType', label: 'Employee Type', type: 'select', required: true, options: EMPLOYEE_TYPES },
    { key: 'startDate', label: 'Start Date', type: 'date', required: true },
    { key: 'reportsTo', label: 'Reports To', type: 'text', required: true },
    { key: 'payRate', label: 'Pay Rate', type: 'text', required: true },
    { key: 'email', label: 'Work Email (proposed)', type: 'email' },
    { key: 'phone', label: 'Phone', type: 'tel' },
  ],
};
formDefinitions.push(requestToHire);

// ---------------------------------------------------------------------------
// Access catalog + roles. THIS is what kills the 30-column Excel.
//
// Each item has an owning department, so provisioning tasks route automatically
// to the right owner instead of being hardcoded into a flow's filter logic.
// Pick a role -> sensible default bundle -> adjust -> done.
// ---------------------------------------------------------------------------
const DEPARTMENTS = {
  IT: 'IT / Accounts',
  FIN: 'Finance',
  MKT: 'Marketing',
  ACA: 'Academic / Curriculum',
};

const accessCatalog = [
  // System / software
  { key: 'microsoft', label: 'Microsoft Suite', dept: 'IT', kind: 'software' },
  { key: 'google', label: 'Google Docs', dept: 'IT', kind: 'software' },
  { key: 'llm', label: 'LLM / AI Tools', dept: 'IT', kind: 'software' },
  { key: 'jira', label: 'Jira', dept: 'IT', kind: 'software' },
  { key: 'ramp', label: 'Ramp Card', dept: 'FIN', kind: 'software' },
  { key: 'quickbooks', label: 'Quickbooks', dept: 'FIN', kind: 'software' },
  { key: 'paychex', label: 'Paychex', dept: 'FIN', kind: 'software' },
  { key: 'adobe', label: 'Adobe Creative Suite', dept: 'MKT', kind: 'software' },
  { key: 'canva', label: 'Canva', dept: 'MKT', kind: 'software' },
  { key: 'hubspot', label: 'HubSpot', dept: 'MKT', kind: 'software' },
  { key: 'wordpress', label: 'Wordpress', dept: 'MKT', kind: 'software' },
  { key: 'envato', label: 'Envato', dept: 'MKT', kind: 'software' },
  { key: 'istock', label: 'iStockPhoto', dept: 'MKT', kind: 'software' },
  { key: 'pictory', label: 'Pictory', dept: 'MKT', kind: 'software' },
  { key: 'endorsal', label: 'Endorsal', dept: 'MKT', kind: 'software' },
  { key: 'meta', label: 'Meta Accounts', dept: 'MKT', kind: 'software' },
  { key: 'canvas', label: 'Canvas (LMS)', dept: 'ACA', kind: 'software' },
  { key: 'nearpod', label: 'Nearpod', dept: 'ACA', kind: 'software' },
  { key: 'formative', label: 'Formative', dept: 'ACA', kind: 'software' },
  { key: 'iready', label: 'iReady', dept: 'ACA', kind: 'software' },
  { key: 'focus', label: 'Focus (SIS)', dept: 'ACA', kind: 'software' },
  { key: 'terms', label: 'TERMS', dept: 'ACA', kind: 'software' },
  { key: 'wiris', label: 'Wiris', dept: 'ACA', kind: 'software' },
  { key: 'genius', label: 'Genius', dept: 'ACA', kind: 'software' },
  { key: 'arthur', label: 'Arthur', dept: 'ACA', kind: 'software' },
  { key: 'jstor', label: 'JSTOR', dept: 'ACA', kind: 'software' },
  { key: 'optimaxr', label: 'OptimaXR', dept: 'ACA', kind: 'software' },
  // Hardware
  { key: 'laptop', label: 'Laptop', dept: 'IT', kind: 'hardware' },
  { key: 'monitor', label: 'Monitor', dept: 'IT', kind: 'hardware' },
  { key: 'mouse', label: 'Mouse', dept: 'IT', kind: 'hardware' },
  { key: 'pen', label: 'Logitech Pen', dept: 'IT', kind: 'hardware' },
  { key: 'vr', label: 'VR Headset', dept: 'ACA', kind: 'hardware' },
  { key: 'doccam', label: 'Doc Cam', dept: 'ACA', kind: 'hardware' },
];

const accessRoles = [
  {
    id: 'role-teacher', name: 'OAO Teacher',
    defaults: ['microsoft', 'google', 'canvas', 'nearpod', 'formative', 'iready', 'focus', 'terms', 'wiris', 'genius', 'optimaxr', 'laptop', 'monitor', 'mouse', 'pen', 'vr', 'doccam'],
  },
  {
    id: 'role-marketing', name: 'Marketing',
    defaults: ['microsoft', 'google', 'adobe', 'canva', 'hubspot', 'wordpress', 'envato', 'istock', 'pictory', 'endorsal', 'meta', 'laptop', 'monitor', 'mouse'],
  },
  {
    id: 'role-finance', name: 'Finance / Operations',
    defaults: ['microsoft', 'google', 'quickbooks', 'paychex', 'ramp', 'jira', 'laptop', 'monitor', 'mouse'],
  },
  {
    id: 'role-it', name: 'Engineering / IT',
    defaults: ['microsoft', 'google', 'jira', 'llm', 'laptop', 'monitor', 'mouse'],
  },
  {
    id: 'role-leadership', name: 'Leadership / Admin',
    defaults: ['microsoft', 'google', 'ramp', 'hubspot', 'quickbooks', 'laptop', 'monitor', 'mouse'],
  },
];

// Attach the catalog + departments onto the RTH definition so the UI can read it.
requestToHire.accessCatalog = accessCatalog;
requestToHire.departments = DEPARTMENTS;

// --- A couple of demo candidates so the dashboard isn't empty ----------------
const demoCandidates = [
  {
    id: 'cand-demo-1', firstName: 'Jordan', lastName: 'Rivera',
    email: 'jordan.rivera@example.com', position: 'Math Teacher',
    startDate: '2026-08-10', employeeType: 'Optima Academy Online — Full-Time',
    status: 'In Progress',
  },
  {
    id: 'cand-demo-2', firstName: 'Priya', lastName: 'Anand',
    email: 'priya.anand@example.com', position: 'Marketing Coordinator',
    startDate: '2026-07-01', employeeType: 'OptimaEd (Corporate)',
    status: 'In Progress',
  },
  {
    id: 'cand-demo-3', firstName: 'Marcus', lastName: 'Bell',
    email: 'marcus.bell@example.com', position: 'Contract Tutor',
    startDate: '2026-09-02', employeeType: 'Optima Academy Online — Contractor',
    status: 'In Progress',
  },
];

// --- Run ---------------------------------------------------------------------
db.reset();
db.replace('formDefinitions', formDefinitions);
db.replace('accessRoles', accessRoles);
db.replace('candidates', demoCandidates.map((c) => ({ ...c, createdAt: new Date().toISOString() })));

console.log(`Seeded: ${formDefinitions.length} form definitions, ${accessRoles.length} access roles, ${accessCatalog.length} access items, ${demoCandidates.length} demo candidates.`);
