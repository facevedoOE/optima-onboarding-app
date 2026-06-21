'use strict';

// --- tiny helpers -----------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (res.status === 401) { boot(); throw new Error('Not authenticated'); }
  if (!res.ok) throw new Error((data?.error || 'Request failed') + (data?.missing ? ': ' + data.missing.join(', ') : ''));
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}

function go(path) { location.hash = '#' + path; }

// --- auth -------------------------------------------------------------------
let ME = null;

function renderUserChip() {
  let chip = document.querySelector('#userchip');
  if (ME) {
    if (!chip) {
      chip = document.createElement('div');
      chip.id = 'userchip';
      chip.style.cssText = 'margin-left:auto;display:flex;align-items:center;gap:12px;color:#cdd6e6;font-size:.85rem';
      document.querySelector('.topbar').appendChild(chip);
    }
    chip.innerHTML = `<span class="uc-name">${esc(ME.name)}</span><span class="uc-role"> · <strong style="color:#fff">${esc(ME.role)}</strong></span><a href="/auth/logout" style="color:#fff;font-weight:600">Sign out</a>`;
  } else if (chip) { chip.remove(); }
}

async function renderLoginUI(me) {
  document.querySelector('#nav').style.display = 'none';

  // Candidate arrived via their magic link — confirm the email HR has on file.
  if (me.pendingCandidate) {
    view.innerHTML = `<div class="card" style="max-width:440px;margin:48px auto">
      <div class="brandmark" style="font-size:1.3rem;text-align:center;margin-bottom:6px">OPTIMA · Onboarding</div>
      <p class="sub" style="text-align:center;margin-bottom:6px">Confirm it's you</p>
      <p class="help" style="text-align:center;margin-bottom:18px">Please enter the email address you used to apply. For your security, only that email will open your portal.</p>
      <form id="cv">
        <div class="field"><input type="email" id="cvEmail" placeholder="you@example.com" required></div>
        <button class="btn" style="width:100%" type="submit">Continue to my portal</button>
        <div class="help" id="cvErr" style="color:var(--orange);margin-top:10px;min-height:1em"></div>
      </form></div>`;
    $('#cv').onsubmit = async (e) => {
      e.preventDefault();
      const r = await fetch('/auth/candidate/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('#cvEmail').value }) });
      if (r.ok) { location.hash = '#/portal'; boot(); }
      else { const d = await r.json().catch(() => ({})); $('#cvErr').textContent = d.error || 'Could not verify. Please try again.'; }
    };
    return;
  }

  let adminBlock, candBlock;
  if (me.mode === 'live') {
    adminBlock = `<a class="btn" href="/auth/login">Sign in with Microsoft</a>`;
    candBlock = `<p class="help">New hires receive a secure magic link by email to open their portal — no password needed.</p>`;
  } else {
    adminBlock = `<button class="btn" id="loginAdmin">Continue as Admin</button>`;
    const cands = await (await fetch('/auth/demo-candidates')).json();
    candBlock = `<p class="help" style="margin-bottom:8px">In live mode candidates arrive via an emailed magic link. For the demo, enter as:</p>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${cands.map((c) => `<button class="btn ghost" data-cand="${c.id}">${esc(c.name)}</button>`).join('')}</div>`;
  }
  view.innerHTML = `<div class="card" style="max-width:480px;margin:48px auto">
    <div style="color:var(--blue);font-weight:800;font-size:1.3rem;text-align:center;margin-bottom:6px">OPTIMA · Onboarding</div>
    <p class="sub" style="text-align:center;margin-bottom:22px">${me.mode === 'live' ? 'Sign in to continue.' : 'Demo mode — choose how to sign in.'}</p>
    <div class="dept-group"><h4>Admin / Staff</h4>${adminBlock}</div>
    <div class="dept-group" style="margin-top:20px"><h4>Candidate (new hire)</h4>${candBlock}</div>
  </div>`;
  const a = $('#loginAdmin');
  if (a) a.onclick = async () => { await fetch('/auth/dev-admin', { method: 'POST' }); boot(); };
  view.querySelectorAll('[data-cand]').forEach((b) => b.onclick = async () => {
    await fetch('/auth/dev-candidate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidateId: b.dataset.cand }) });
    location.hash = '#/portal'; boot();
  });
}

async function boot() {
  const me = await (await fetch('/api/me')).json();
  ME = me.authenticated ? me.user : null;
  renderUserChip();
  if (!me.authenticated) { renderLoginUI(me); return; }
  const nav = document.querySelector('#nav');
  if (ME.role === 'candidate') {
    nav.style.display = 'none';
    if (!location.hash.startsWith('#/portal') && !location.hash.startsWith('#/myform/')) { location.hash = '#/portal'; }
    router();
  } else {
    nav.style.display = '';
    router();
  }
}

// --- schema-driven field renderer ------------------------------------------
function renderField(f, value = '') {
  const req = f.required ? ' <span class="req">*</span>' : ' <span class="optional-tag">Optional</span>';
  const oc = f.required ? '' : ' optional'; // grays out fields that aren't required
  const v = esc(value);
  let input = '';
  switch (f.type) {
    case 'textarea':
      input = `<textarea name="${f.key}" ${f.required ? 'required' : ''}>${v}</textarea>`; break;
    case 'select':
      input = `<select name="${f.key}" ${f.required ? 'required' : ''}><option value="">Select…</option>` +
        (f.options || []).map((o) => `<option ${value === o ? 'selected' : ''}>${esc(o)}</option>`).join('') + `</select>`; break;
    case 'attestation':
      return `<div class="field${oc}"><div class="attest"><input type="checkbox" name="${f.key}" id="f_${f.key}" ${value ? 'checked' : ''} ${f.required ? 'required' : ''}>
        <label for="f_${f.key}" style="margin:0">${esc(f.label)}${req}</label></div></div>`;
    case 'date': input = `<input type="date" name="${f.key}" value="${v}" ${f.required ? 'required' : ''}>`; break;
    case 'email': input = `<input type="email" name="${f.key}" value="${v}" ${f.required ? 'required' : ''}>`; break;
    case 'tel': input = `<input type="tel" name="${f.key}" value="${v}" ${f.required ? 'required' : ''}>`; break;
    case 'number': input = `<input type="number" name="${f.key}" value="${v}" ${f.required ? 'required' : ''}>`; break;
    default: input = `<input type="text" name="${f.key}" value="${v}" placeholder="${esc(f.placeholder || '')}" ${f.required ? 'required' : ''}>`;
  }
  return `<div class="field${oc}"><label>${esc(f.label)}${req}</label>${input}${f.help ? `<div class="help">${esc(f.help)}</div>` : ''}</div>`;
}

function collectForm(formEl, fields) {
  const data = {};
  for (const f of fields) {
    const node = formEl.elements[f.key];
    if (!node) continue;
    data[f.key] = f.type === 'attestation' ? node.checked : node.value;
  }
  return data;
}

// --- views ------------------------------------------------------------------
const views = {};

views['/'] = async () => {
  const cands = await api('/candidates');
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Candidates</h1><p class="sub">Everyone currently moving through onboarding.</p></div>
      <button class="btn gold" id="newCand">+ New Candidate</button>
    </div>
    <div class="grid g3">
      ${cands.length ? cands.map((c) => {
        const pct = c.progress.total ? Math.round((c.progress.done / c.progress.total) * 100) : 0;
        return `<div class="card click" data-id="${c.id}">
          <div class="cand-name">${esc(c.firstName)} ${esc(c.lastName)}</div>
          <div class="cand-meta">${esc(c.position || '—')} · ${esc(c.employeeType || '')}</div>
          <div class="bar-label"><span>Onboarding progress</span><span>${c.progress.done}/${c.progress.total}</span></div>
          <div class="bar"><div style="width:${pct}%"></div></div>
        </div>`;
      }).join('') : `<div class="empty">No candidates yet. Add your first one.</div>`}
    </div>`;
  $('#newCand').onclick = () => go('/candidate/new');
  view.querySelectorAll('.card.click').forEach((el) => el.onclick = () => go('/candidate/' + el.dataset.id));
};

views['/candidate/new'] = async () => {
  const def = await api('/forms/intake');
  view.innerHTML = `
    <div class="crumb"><a href="#/">Candidates</a> › New</div>
    <h1>New Candidate</h1>
    <p class="sub">${esc(def.description)}</p>
    <div class="card" style="max-width:640px;margin-top:16px">
      <form id="f">${def.fields.map((f) => renderField(f)).join('')}
        <button class="btn" type="submit">Create candidate</button></form>
    </div>`;
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const d = collectForm(e.target, def.fields);
    try {
      const c = await api('/candidates', { method: 'POST', body: d });
      toast('Candidate created');
      go('/candidate/' + c.id);
    } catch (err) { toast(err.message); }
  };
};

views['/candidate/:id'] = async (id) => {
  const c = await api('/candidates/' + id);
  const statusPill = (s) => `<span class="pill ${s}">${s === 'complete' ? 'Complete' : 'Pending'}</span>`;
  view.innerHTML = `
    <div class="crumb"><a href="#/">Candidates</a> › ${esc(c.firstName)} ${esc(c.lastName)}</div>
    <div class="page-head">
      <div><h1>${esc(c.firstName)} ${esc(c.lastName)}</h1>
      <p class="sub">${esc(c.position || '—')} · ${esc(c.employeeType || '')} · starts ${esc(c.startDate || '—')}</p></div>
      <button class="btn ghost" id="sendLink">${c.portalLinkSentAt ? 'Resend' : 'Send'} portal link</button>
    </div>
    <h2>Onboarding checklist</h2>
    ${c.checklist.map((item) => `
      <div class="row ${item.status === 'complete' ? 'done' : ''}">
        <div><div class="t">${esc(item.title)}</div><div class="d">${esc(item.description || '')}</div></div>
        <div style="display:flex;gap:10px;align-items:center">
          ${statusPill(item.status)}
          ${item.status === 'complete'
            ? `<a class="btn ghost sm" href="/api/submissions/${item.submissionId}/pdf" target="_blank">View PDF</a>`
            : `<button class="btn sm" data-fill="${item.key}">Complete</button>`}
        </div>
      </div>`).join('')}
    <h2 style="margin-top:24px">Access &amp; Hiring</h2>
    ${c.rth
      ? `<div class="row"><div><div class="t">Request to Hire</div><div class="d">${esc(c.rth.roleName || 'Custom access')}</div></div>
          <div style="display:flex;gap:10px;align-items:center"><span class="pill ${c.rth.status}">${esc(c.rth.status.replace(/-/g, ' '))}</span>
          <a class="btn ghost sm" href="#/rth/${c.rth.id}">Open</a></div></div>`
      : `<div class="row"><div><div class="t">Request to Hire</div><div class="d">No request yet for this candidate.</div></div>
          <button class="btn sm" id="newRth">Create Request to Hire</button></div>`}
    <h2 style="margin-top:24px">References</h2>
    ${(c.references || []).length
      ? c.references.map((r) => `<div class="row">
          <div><div class="t">${esc(r.name)}</div><div class="d">${esc(r.email)}${r.sentAt ? ` · sent ${new Date(r.sentAt).toLocaleDateString('en-US')}` : ''}</div></div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <span class="pill ${r.status === 'received' ? 'complete' : 'requested'}">${r.status === 'received' ? 'Received' : 'Requested'}</span>
            <button class="btn ghost sm" data-ref-resend="${r.id}">Resend</button>
            <button class="btn ghost sm" data-ref-edit="${r.id}" data-name="${esc(r.name)}" data-email="${esc(r.email)}">Correct</button>
            ${r.status !== 'received' ? `<button class="btn ghost sm" data-ref-recv="${r.id}">Mark received</button>` : ''}
            <button class="btn ghost sm" data-ref-del="${r.id}">Remove</button>
          </div></div>`).join('')
      : `<div class="row"><div class="d">No references requested yet.</div></div>`}
    <div class="card" style="margin-top:6px">
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
        <div style="flex:1;min-width:150px"><label class="help" style="display:block;margin-bottom:4px">Reference name</label><input id="refName"></div>
        <div style="flex:1;min-width:180px"><label class="help" style="display:block;margin-bottom:4px">Reference email</label><input id="refEmail" type="email"></div>
        <button class="btn sm" id="refAdd">Add &amp; send request</button>
      </div>
    </div>
    <div class="grid g2" style="margin-top:24px">
      <div><h2>Activity</h2><div class="card"><ul class="activity">
        ${(c.activity || []).map((a) => `<li><span class="when">${new Date(a.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span><span>${esc(a.message)}</span></li>`).join('') || '<li>No activity yet.</li>'}
      </ul></div></div>
    </div>`;
  view.querySelectorAll('[data-fill]').forEach((b) => b.onclick = () => go(`/fill/${id}/${b.dataset.fill}`));
  const newRth = $('#newRth');
  if (newRth) newRth.onclick = () => go('/rth/new/' + id);

  // References panel
  let editingRef = null;
  const refAdd = $('#refAdd');
  refAdd.onclick = async () => {
    const name = $('#refName').value.trim(), email = $('#refEmail').value.trim();
    if (!name || !email) return toast('Name and email required');
    try {
      if (editingRef) await api('/references/' + editingRef, { method: 'PUT', body: { name, email } });
      else await api('/candidates/' + id + '/references', { method: 'POST', body: { name, email } });
      toast(editingRef ? 'Reference corrected' : 'Reference request sent');
      views['/candidate/:id'](id);
    } catch (err) { toast(err.message); }
  };
  view.querySelectorAll('[data-ref-edit]').forEach((b) => b.onclick = () => {
    editingRef = b.dataset.refEdit;
    $('#refName').value = b.dataset.name; $('#refEmail').value = b.dataset.email;
    refAdd.textContent = 'Save correction'; $('#refName').focus();
  });
  view.querySelectorAll('[data-ref-resend]').forEach((b) => b.onclick = async () => {
    try { await api('/references/' + b.dataset.refResend + '/resend', { method: 'POST' }); toast('Reference request resent'); views['/candidate/:id'](id); }
    catch (err) { toast(err.message); }
  });
  view.querySelectorAll('[data-ref-recv]').forEach((b) => b.onclick = async () => {
    try { await api('/references/' + b.dataset.refRecv + '/received', { method: 'POST' }); toast('Marked received'); views['/candidate/:id'](id); }
    catch (err) { toast(err.message); }
  });
  view.querySelectorAll('[data-ref-del]').forEach((b) => b.onclick = async () => {
    try { await api('/references/' + b.dataset.refDel, { method: 'DELETE' }); toast('Reference removed'); views['/candidate/:id'](id); }
    catch (err) { toast(err.message); }
  });
  $('#sendLink').onclick = async () => {
    try {
      const r = await api('/candidates/' + id + '/send-portal-link', { method: 'POST' });
      toast(r.link ? 'Portal link ready (demo)' : 'Portal link emailed');
      if (r.link) {
        view.insertAdjacentHTML('afterbegin',
          `<div class="note">Demo magic link (opens the candidate's portal — try it in a private window): <a href="${esc(r.link)}" target="_blank">${esc(r.link)}</a></div>`);
      }
    } catch (err) { toast(err.message); }
  };
};

// Embedded external form (e.g. Adobe Sign) — the real document, completed exactly as-is, in an iframe.
function embedFormHTML(def) {
  return `<div class="note">Complete and sign the official document below — it's the real form, submitted exactly as required. Your signed copy is filed automatically once you finish, then mark it complete.</div>
    <iframe src="${esc(def.embedUrl)}" title="${esc(def.title)}" style="width:100%;height:78vh;border:1px solid var(--line);border-radius:10px;background:#fff"></iframe>
    <div style="margin-top:14px"><button class="btn green" id="embedDone">I've completed this form</button></div>`;
}

views['/fill/:cid/:key'] = async (cid, key) => {
  const [def, cand] = await Promise.all([api('/forms/' + key), api('/candidates/' + cid)]);
  if (def.embedUrl) {
    view.innerHTML = `<div class="crumb"><a href="#/">Candidates</a> › <a href="#/candidate/${cid}">${esc(cand.firstName)} ${esc(cand.lastName)}</a> › ${esc(def.title)}</div>
      <h1>${esc(def.title)}</h1><p class="sub">${esc(def.description || '')}</p>${embedFormHTML(def)}`;
    $('#embedDone').onclick = async () => {
      try { await api('/submissions', { method: 'POST', body: { candidateId: cid, formKey: key, data: {} } }); toast('Marked complete'); go('/candidate/' + cid); }
      catch (err) { toast(err.message); }
    };
    return;
  }
  view.innerHTML = `
    <div class="crumb"><a href="#/">Candidates</a> › <a href="#/candidate/${cid}">${esc(cand.firstName)} ${esc(cand.lastName)}</a> › ${esc(def.title)}</div>
    <h1>${esc(def.title)}</h1><p class="sub">${esc(def.description || '')}</p>
    <div class="note">This form is rendered live from its definition (v${def.version}). On submit it generates a completed PDF and files it to the candidate's HR folder.</div>
    <div class="card" style="max-width:680px">
      <form id="f">${def.fields.map((f) => renderField(f)).join('')}
        <button class="btn green" type="submit">Submit &amp; generate PDF</button></form>
    </div>`;
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/submissions', { method: 'POST', body: { candidateId: cid, formKey: key, data: collectForm(e.target, def.fields) } });
      toast('Submitted — PDF filed');
      go('/candidate/' + cid);
    } catch (err) { toast(err.message); }
  };
};

// --- Form Builder -----------------------------------------------------------
views['/forms'] = async () => {
  const forms = await api('/forms');
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Form Builder</h1><p class="sub">Every onboarding form is data. Add a field or a whole new form here — no code, no Adobe, no flow changes.</p></div>
      <button class="btn gold" id="new">+ New Form</button>
    </div>
    <div class="grid g2">
      ${forms.map((f) => `<div class="card click" data-key="${f.key}">
        <div class="cand-name">${esc(f.title)} <span class="tag-soft">v${f.version}</span></div>
        <div class="cand-meta">${esc(f.description || '')}</div>
        <div class="d" style="color:var(--muted);font-size:.82rem">${f.fields.length} fields · applies to: ${esc(f.appliesTo)}</div>
      </div>`).join('')}
    </div>`;
  $('#new').onclick = () => go('/forms/new');
  view.querySelectorAll('.card.click').forEach((el) => el.onclick = () => go('/forms/' + el.dataset.key));
};

views['/forms/new'] = async () => {
  view.innerHTML = `
    <div class="crumb"><a href="#/forms">Form Builder</a> › New</div>
    <h1>New Form</h1>
    <div class="card" style="max-width:620px">
      <div class="field"><label>Title <span class="req">*</span></label><input id="title"></div>
      <div class="field"><label>Key (url-safe) <span class="req">*</span></label><input id="key" placeholder="e.g. ccps-2026"></div>
      <div class="field"><label>Description</label><input id="desc"></div>
      <div class="field"><label>Applies to</label><select id="applies">
        <option value="all">All new hires</option><option value="oao">OAO (all)</option>
        <option value="oao-fulltime">OAO full-time</option><option value="oao-contractor">OAO contractor</option>
      </select></div>
      <button class="btn" id="create">Create form</button>
      <p class="help" style="margin-top:10px">You'll add fields on the next screen.</p>
    </div>`;
  $('#create').onclick = async () => {
    try {
      const f = await api('/forms', { method: 'POST', body: {
        title: $('#title').value, key: $('#key').value.trim(), description: $('#desc').value, appliesTo: $('#applies').value } });
      toast('Form created'); go('/forms/' + f.key);
    } catch (err) { toast(err.message); }
  };
};

views['/forms/:key'] = async (key) => {
  const f = await api('/forms/' + key);
  const TYPES = ['text', 'email', 'tel', 'date', 'number', 'textarea', 'select', 'attestation'];
  view.innerHTML = `
    <div class="crumb"><a href="#/forms">Form Builder</a> › ${esc(f.title)}</div>
    <div class="page-head"><div><h1>${esc(f.title)} <span class="tag-soft">v${f.version}</span></h1>
      <p class="sub">${esc(f.description || '')}</p></div></div>
    <div class="note">This is exactly the scenario you described: a new CCPS revision, or two new fields on Request to Hire. Add them below — they appear instantly in the live form and on the generated PDF.</div>
    <div class="grid g2">
      <div><h2>Fields</h2><div id="fields">
        ${f.fields.map((fl, i) => `<div class="row"><div><div class="t">${esc(fl.label)}</div>
          <div class="d">${esc(fl.key)} · ${esc(fl.type)}${fl.required ? ' · required' : ''}</div></div>
          <button class="btn ghost sm" data-del="${i}">Remove</button></div>`).join('') || '<div class="empty">No fields yet.</div>'}
      </div></div>
      <div><h2>Add a field</h2><div class="card">
        <div class="field"><label>Label</label><input id="nl"></div>
        <div class="field"><label>Key</label><input id="nk" placeholder="camelCase"></div>
        <div class="field"><label>Type</label><select id="nt">${TYPES.map((t) => `<option>${t}</option>`).join('')}</select></div>
        <div class="field" id="optWrap" style="display:none"><label>Options (comma-separated)</label><input id="no"></div>
        <div class="field"><label class="chk" style="border:none;padding:0"><input type="checkbox" id="nr"> Required</label></div>
        <button class="btn" id="add">Add field</button>
      </div></div>
    </div>`;
  $('#nt').onchange = (e) => { $('#optWrap').style.display = e.target.value === 'select' ? '' : 'none'; };
  $('#add').onclick = async () => {
    const field = { label: $('#nl').value, key: $('#nk').value.trim(), type: $('#nt').value, required: $('#nr').checked };
    if (field.type === 'select') field.options = $('#no').value.split(',').map((s) => s.trim()).filter(Boolean);
    if (!field.label || !field.key) return toast('Label and key required');
    const fields = [...f.fields, field];
    try { await api('/forms/' + key, { method: 'PUT', body: { fields } }); toast('Field added'); views['/forms/:key'](key); }
    catch (err) { toast(err.message); }
  };
  view.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    const fields = f.fields.filter((_, i) => i !== Number(b.dataset.del));
    await api('/forms/' + key, { method: 'PUT', body: { fields } }); toast('Field removed'); views['/forms/:key'](key);
  });
};

// --- Request to Hire --------------------------------------------------------
views['/rth'] = async () => {
  const list = await api('/rth');
  view.innerHTML = `
    <div class="page-head"><div><h1>Request to Hire</h1>
      <p class="sub">Signature chain + access provisioning. The readable replacement for the wide spreadsheet.</p></div>
      <button class="btn gold" id="new">+ New Request</button></div>
    ${list.length ? list.map((r) => `<div class="row click" data-id="${r.id}">
      <div><div class="t">${esc(r.data.candidateName)}</div><div class="d">${esc(r.data.position)} · ${esc(r.roleName || '')}</div></div>
      <span class="pill ${r.status}">${esc(r.status.replace(/-/g, ' '))}</span></div>`).join('')
      : '<div class="empty">No requests yet.</div>'}`;
  $('#new').onclick = () => go('/rth/new');
  view.querySelectorAll('.row.click').forEach((el) => { el.style.cursor = 'pointer'; el.onclick = () => go('/rth/' + el.dataset.id); });
};

async function rthNew(prefillId) {
  const [def, roles, cands] = await Promise.all([api('/forms/request-to-hire'), api('/roles'), api('/candidates')]);
  const candsById = Object.fromEntries(cands.map((c) => [c.id, c]));
  const byDept = {};
  for (const item of def.accessCatalog) (byDept[item.dept] = byDept[item.dept] || []).push(item);
  view.innerHTML = `
    <div class="crumb"><a href="#/rth">Request to Hire</a> › New</div>
    <h1>New Request to Hire</h1>
    <div class="card" style="max-width:760px">
      <form id="f">
        <div class="field"><label>Link to candidate</label>
          <select id="candidate"><option value="">— not linked (standalone) —</option>
            ${cands.map((c) => `<option value="${c.id}" ${c.id === prefillId ? 'selected' : ''}>${esc(c.firstName)} ${esc(c.lastName)} · ${esc(c.position || '')}</option>`).join('')}</select>
          <div class="help">Linking ties the approval, account, and access back to this candidate's record.</div></div>
        ${def.fields.map((fl) => renderField(fl)).join('')}
        <h2>Access — pick a role to pre-fill</h2>
        <div class="note">Instead of 30 yes/no columns, choose a role and the sensible default bundle is selected. Adjust as needed. Each item routes to its owning department automatically.</div>
        <div class="field"><label>Role</label><select id="role"><option value="">Custom…</option>
          ${roles.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></div>
        ${Object.entries(byDept).map(([d, items]) => `<div class="dept-group"><h4>${esc(def.departments[d] || d)}</h4>
          <div class="check-grid">${items.map((it) => `<label class="chk"><input type="checkbox" name="acc" value="${it.key}" data-key="${it.key}"> ${esc(it.label)}</label>`).join('')}</div></div>`).join('')}
        <button class="btn green" type="submit">Submit for signatures</button>
      </form>
    </div>`;
  const setField = (key, val) => { const el = view.querySelector(`[name="${key}"]`); if (el && val != null) el.value = val; };
  const applyCandidate = (c) => {
    if (!c) return;
    setField('candidateName', `${c.firstName} ${c.lastName}`);
    setField('position', c.position); setField('employeeType', c.employeeType);
    setField('startDate', c.startDate); setField('email', c.email);
  };
  $('#candidate').onchange = (e) => applyCandidate(candsById[e.target.value]);
  if (prefillId) applyCandidate(candsById[prefillId]);
  const rolesById = Object.fromEntries(roles.map((r) => [r.id, r]));
  $('#role').onchange = (e) => {
    const r = rolesById[e.target.value];
    view.querySelectorAll('input[name="acc"]').forEach((cb) => { cb.checked = r ? r.defaults.includes(cb.value) : false; });
  };
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const accessItems = [...view.querySelectorAll('input[name="acc"]:checked')].map((cb) => cb.value);
    try {
      const r = await api('/rth', { method: 'POST', body: { candidateId: $('#candidate').value || null, data: collectForm(e.target, def.fields), roleId: $('#role').value || null, accessItems } });
      toast('Request submitted'); go('/rth/' + r.id);
    } catch (err) { toast(err.message); }
  };
}
views['/rth/new'] = () => rthNew(null);
views['/rth/new/:cid'] = (cid) => rthNew(cid);

views['/rth/:id'] = async (id) => {
  const r = await api('/rth/' + id);
  const firstPending = r.signatures.findIndex((s) => !s.signedAt);
  const itemsByDept = {};
  for (const it of r.items) (itemsByDept[it.dept] = itemsByDept[it.dept] || []).push(it);
  view.innerHTML = `
    <div class="crumb"><a href="#/rth">Request to Hire</a> › ${esc(r.data.candidateName)}</div>
    <div class="page-head"><div><h1>${esc(r.data.candidateName)}</h1>
      <p class="sub">${esc(r.data.position)} · ${esc(r.roleName || 'Custom access')} · starts ${esc(r.data.startDate)}
      ${r.candidateId ? ` · <a href="#/candidate/${r.candidateId}">linked candidate ↗</a>` : ' · <em>not linked</em>'}</p></div>
      <span class="pill ${r.status}">${esc(r.status.replace(/-/g, ' '))}</span></div>
    <div class="grid g2">
      <div><h2>Signature chain</h2><div class="card"><div class="sigchain">
        ${r.signatures.map((s, i) => `<div class="sigstep ${s.signedAt ? 'signed' : (i === firstPending ? 'current' : '')}">
          <div class="sigdot">${s.signedAt ? '✓' : i + 1}</div>
          <div class="siginfo"><div class="who">${esc(s.label)} <span class="tag-soft">${esc(s.role)}</span></div>
            <div class="when">${s.signedAt ? 'Signed by ' + esc(s.signedBy) + ' · ' + new Date(s.signedAt).toLocaleString('en-US') : 'Awaiting signature'}</div></div>
          ${!s.signedAt && i === firstPending ? `<button class="btn sm" data-sign="${s.key}">Sign</button>` : ''}
        </div>`).join('')}
      </div></div>
      ${r.status === 'approved' || r.status === 'provisioning' || r.status === 'complete'
        ? `<a class="btn ghost sm" style="margin-top:12px" href="/api/rth/${id}/pdf" target="_blank">View signed PDF</a>` : ''}
      </div>
      <div><h2>Access provisioning</h2><div class="card">
        ${r.status === 'awaiting-signatures' ? '<div class="note">Provisioning unlocks once all signatures are complete.</div>' : ''}
        ${Object.entries(itemsByDept).map(([d, items]) => `<div class="dept-group"><h4>${esc(d)}</h4>
          ${items.map((it) => `<div class="row" style="margin-bottom:6px"><div class="t" style="font-size:.9rem">${esc(it.label)}</div>
            ${it.status === 'provisioned' ? '<span class="pill provisioned">Provisioned</span>'
              : `<button class="btn sm" data-prov="${it.key}" ${r.status === 'awaiting-signatures' ? 'disabled' : ''}>Provision</button>`}</div>`).join('')}
        </div>`).join('') || '<div class="empty">No access items requested.</div>'}
      </div></div>
    </div>`;
  view.querySelectorAll('[data-sign]').forEach((b) => b.onclick = async () => {
    // The server records the signed-in user as the approver (and enforces role).
    try { await api('/rth/' + id + '/sign', { method: 'POST', body: { stepKey: b.dataset.sign } }); toast('Signed'); views['/rth/:id'](id); }
    catch (err) { toast(err.message); }
  });
  view.querySelectorAll('[data-prov]').forEach((b) => b.onclick = async () => {
    try { await api('/rth/' + id + '/provision', { method: 'POST', body: { itemKey: b.dataset.prov } }); toast('Provisioned'); views['/rth/:id'](id); }
    catch (err) { toast(err.message); }
  });
};

// --- Candidate portal (the merged landing page) -----------------------------
views['/portal'] = async () => {
  const p = await api('/portal');
  const w = p.welcome;
  const done = p.checklist.filter((i) => i.status === 'complete').length;
  const pct = p.checklist.length ? Math.round((done / p.checklist.length) * 100) : 0;
  view.innerHTML = `
    <div class="portal-hero">
      <img class="portal-hero-logo" src="/assets/optima-logo.png" alt="Optima">
      <h1>Welcome to Team Optima</h1>
      <p class="hero-sub">Hi ${esc(p.firstName)} — here's everything for your start${p.startDate ? ` on ${esc(p.startDate)}` : ''}.</p>
      <div class="ceo-card">
        <div class="ceo-header">
          <img class="ceo-headshot" src="/assets/ceo-headshot.jpg" alt="${esc(w.ceoName)}">
          <div><div class="ceo-name">${esc(w.ceoName)}</div><div class="ceo-title">${esc(w.ceoTitle)}</div></div>
        </div>
        <div class="ceo-letter">
          <p>${esc(w.letter)}</p>
          <p class="ceo-signoff">${esc(w.signoff)}</p>
          <p class="ceo-signature">— ${esc(w.ceoName)}, ${esc(w.ceoTitle)}</p>
        </div>
      </div>
    </div>
    <h2>Your onboarding checklist</h2>
    <div class="checklist-progress" style="margin-bottom:14px">
      <div class="bar-label"><span>Progress</span><span>${done} of ${p.checklist.length} complete</span></div>
      <div class="bar"><div style="width:${pct}%"></div></div>
    </div>
    ${p.checklist.map((item) => `
      <div class="row ${item.status === 'complete' ? 'done' : ''}">
        <div><div class="t">${esc(item.title)}</div><div class="d">${esc(item.description || '')}</div></div>
        <div style="display:flex;gap:10px;align-items:center">
          <span class="pill ${item.status}">${item.status === 'complete' ? 'Complete' : 'To do'}</span>
          ${item.status === 'complete'
            ? `<a class="btn ghost sm" href="/api/submissions/${item.submissionId}/pdf" target="_blank">View PDF</a>`
            : `<button class="btn sm" data-fill="${item.key}">Complete</button>`}
        </div>
      </div>`).join('')}
    <h2>Resources</h2>
    <div class="grid g3">${w.resources.map((r) => `<div class="card resource-card"><div class="cand-name" style="font-size:1rem">${esc(r.title)}</div><div class="cand-meta" style="margin:0">${esc(r.desc)}</div></div>`).join('')}</div>`;
  view.querySelectorAll('[data-fill]').forEach((b) => b.onclick = () => go('/myform/' + b.dataset.fill));
};

views['/myform/:key'] = async (key) => {
  const def = await api('/forms/' + key);
  if (def.embedUrl) {
    view.innerHTML = `<div class="crumb"><a href="#/portal">My Portal</a> › ${esc(def.title)}</div>
      <h1>${esc(def.title)}</h1><p class="sub">${esc(def.description || '')}</p>${embedFormHTML(def)}`;
    $('#embedDone').onclick = async () => {
      try { await api('/submissions', { method: 'POST', body: { formKey: key, data: {} } }); toast('Marked complete'); go('/portal'); }
      catch (err) { toast(err.message); }
    };
    return;
  }
  view.innerHTML = `
    <div class="crumb"><a href="#/portal">My Portal</a> › ${esc(def.title)}</div>
    <h1>${esc(def.title)}</h1><p class="sub">${esc(def.description || '')}</p>
    <div class="card" style="max-width:680px">
      <form id="f">${def.fields.map((f) => renderField(f)).join('')}
        <button class="btn green" type="submit">Submit</button></form></div>`;
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/submissions', { method: 'POST', body: { formKey: key, data: collectForm(e.target, def.fields) } }); toast('Submitted'); go('/portal'); }
    catch (err) { toast(err.message); }
  };
};

// --- router -----------------------------------------------------------------
const routes = [
  ['/', views['/']],
  ['/portal', views['/portal']],
  ['/myform/:key', views['/myform/:key']],
  ['/candidate/new', views['/candidate/new']],
  ['/candidate/:id', views['/candidate/:id']],
  ['/fill/:cid/:key', views['/fill/:cid/:key']],
  ['/forms', views['/forms']],
  ['/forms/new', views['/forms/new']],
  ['/forms/:key', views['/forms/:key']],
  ['/rth', views['/rth']],
  ['/rth/new', views['/rth/new']],
  ['/rth/new/:cid', views['/rth/new/:cid']],
  ['/rth/:id', views['/rth/:id']],
];

function match(path) {
  for (const [pattern, handler] of routes) {
    const pp = pattern.split('/'), ap = path.split('/');
    if (pp.length !== ap.length) continue;
    const params = []; let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params.push(decodeURIComponent(ap[i]));
      else if (pp[i] !== ap[i]) { ok = false; break; }
    }
    if (ok) return { handler, params };
  }
  return null;
}

async function router() {
  const path = (location.hash.slice(1) || '/');
  document.querySelectorAll('#nav a').forEach((a) => {
    const r = a.dataset.route;
    a.classList.toggle('active', path === r || (r !== '/' && path.startsWith(r)));
  });
  const m = match(path);
  view.innerHTML = '<div class="empty">Loading…</div>';
  try {
    if (m) await m.handler(...m.params);
    else view.innerHTML = '<div class="empty">Page not found.</div>';
  } catch (err) {
    view.innerHTML = `<div class="empty">Something went wrong: ${esc(err.message)}</div>`;
  }
}

window.addEventListener('hashchange', () => { if (ME) router(); else boot(); });
window.addEventListener('load', boot);
