const cfg = window.MC_CONFIG || {};
const root = document.getElementById('app');
const state = {
  session: readSession(), view: 'board', filter: 'all', loading: false, error: '',
  agents: [], objectives: [], tasks: [], approvals: [], reviews: [], runs: [], events: [],
  drawer: null, detailId: null
};
const groups = [
  ['queued', 'Queued', ['queued', 'revision_queued']],
  ['working', 'Working', ['working']],
  ['review', 'Review', ['review_queued', 'reviewing']],
  ['approval', 'Needs Ryan', ['approval_pending']],
  ['done', 'Done', ['done']]
];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date = v => v ? new Date(v).toLocaleString([], {dateStyle:'medium',timeStyle:'short'}) : '—';
const byId = (items, id) => items.find(x => x.id === id);
const agent = id => byId(state.agents, id)?.display_name || 'Unassigned';
const configReady = /^https:\/\/[^/]+\.supabase\.co\/?$/.test(cfg.supabaseUrl || '') && Boolean(cfg.publishableKey) && !cfg.publishableKey.includes('YOUR_');
const url = (path) => `${(cfg.supabaseUrl || '').replace(/\/$/,'')}${path}`;

function readSession() { try { return JSON.parse(sessionStorage.getItem('mc_session') || 'null'); } catch { return null; } }
function saveSession(value) { state.session=value; if(value) sessionStorage.setItem('mc_session',JSON.stringify(value)); else sessionStorage.removeItem('mc_session'); }
async function api(path, {method='GET', body, auth=true, prefer}={}) {
  const headers = {'apikey':cfg.publishableKey,'Content-Type':'application/json'};
  if (auth && state.session?.access_token) headers.Authorization=`Bearer ${state.session.access_token}`;
  if (prefer) headers.Prefer=prefer;
  const res = await fetch(url(path), {method, headers, body:body===undefined?undefined:JSON.stringify(body)});
  if (!res.ok) {
    let msg; try { const data=await res.json(); msg=data.message || data.msg || data.error_description || data.error; } catch {}
    throw new Error(msg || `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return null;
  const text=await res.text(); return text ? JSON.parse(text) : null;
}
async function ensureSession() {
  if (!state.session) return false;
  if (Date.now() < (state.session.expires_at || 0) - 60000) return true;
  if (!state.session.refresh_token) { saveSession(null); return false; }
  try {
    const next=await api('/auth/v1/token?grant_type=refresh_token',{method:'POST',body:{refresh_token:state.session.refresh_token},auth:false});
    saveSession({...next,expires_at:Date.now()+next.expires_in*1000}); return true;
  } catch { saveSession(null); return false; }
}
async function load() {
  if (!await ensureSession()) { render(); return; }
  state.loading=true; state.error=''; render();
  try {
    const tables=['mc_agents','mc_objectives','mc_tasks','mc_approvals','mc_reviews','mc_runs','mc_events'];
    const suffix={mc_tasks:'?select=*&order=created_at.desc&limit=500',mc_events:'?select=*&order=created_at.desc&limit=300',mc_runs:'?select=*&order=started_at.desc&limit=300',mc_reviews:'?select=*&order=created_at.desc&limit=300'};
    const data=await Promise.all(tables.map(t=>api(`/rest/v1/${t}${suffix[t] || '?select=*'}`)));
    [state.agents,state.objectives,state.tasks,state.approvals,state.reviews,state.runs,state.events]=data;
    const member=await api('/rest/v1/mc_members?select=role&limit=1');
    if (!member.length) throw new Error('Your Supabase user has not been added to mc_members. See README setup step 3.');
  } catch(e) { state.error=e.message; }
  state.loading=false; render();
}
function shell(content, title, eyebrow='MISSION CONTROL') {
  const nav=[['board','Task board'],['objectives','Objectives'],['agents','Agent team'],['approvals','Approvals']];
  return `<div class="shell"><aside class="sidebar"><div class="brand"><span class="brandmark">M</span><span>MISSION CONTROL</span></div><nav class="nav" aria-label="Main navigation">${nav.map(([key,label])=>`<button data-view="${key}" class="${state.view===key?'active':''}">${label}</button>`).join('')}</nav><div class="sidebar-foot">Signed in as<br>${esc(state.session?.user?.email || '')}<br><button data-action="signout">Sign out</button></div></aside><main class="main"><header class="top"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1></div><div class="actions"><button class="btn ghost" data-action="refresh">${state.loading?'Refreshing…':'Refresh'}</button>${state.view==='board'?'<button class="btn primary" data-action="new-task">+ New task</button>':''}${state.view==='agents'?'<button class="btn primary" data-action="new-agent">+ Add agent</button>':''}${state.view==='objectives'?'<button class="btn primary" data-action="new-objective">+ New objective</button>':''}</div></header>${state.error?`<div class="notice" role="alert">${esc(state.error)}</div>`:''}${content}</main></div>${state.drawer?drawer():''}`;
}
function board() {
  const tasks=state.filter==='all'?state.tasks:state.tasks.filter(t=>t.business_unit===state.filter);
  const blocked=tasks.filter(t=>t.status==='blocked');
  const pending=tasks.filter(t=>t.status==='approval_pending');
  const overdue=tasks.filter(t=>t.due_at && new Date(t.due_at)<new Date() && !['done','cancelled'].includes(t.status));
  const units=[...new Set(state.tasks.map(t=>t.business_unit))].sort();
  const stats=`<section class="stats" aria-label="Work summary"><div class="stat"><span>Active work</span><strong>${tasks.filter(t=>!['done','cancelled','blocked'].includes(t.status)).length}</strong></div><div class="stat alert"><span>Needs a decision</span><strong>${pending.length}</strong></div><div class="stat alert"><span>Blocked or overdue</span><strong>${blocked.length+overdue.filter(t=>t.status!=='blocked').length}</strong></div><div class="stat good"><span>Completed</span><strong>${tasks.filter(t=>t.status==='done').length}</strong></div></section>`;
  const columns=groups.map(([key,label,statuses])=>{const list=tasks.filter(t=>statuses.includes(t.status));return `<section class="column"><div class="column-head"><span>${label}</span><span class="count">${list.length}</span></div>${list.length?list.map(card).join(''):'<div class="empty">No tasks</div>'}</section>`}).join('');
  return shell(`${stats}<div class="toolbar"><div><h2>Team workflow</h2><span class="muted small">Assignments move through work, independent review, and approval.</span></div><label class="small">Business <select id="unit-filter"><option value="all">All businesses</option>${units.map(u=>`<option value="${esc(u)}" ${state.filter===u?'selected':''}>${esc(u)}</option>`).join('')}</select></label></div><div class="board">${columns}</div>${blocked.length?`<section class="panel"><h2>Blocked tasks</h2><div class="list">${blocked.map(t=>`<div class="row"><div><strong>${esc(t.title)}</strong><span class="sub">${esc(t.last_error || 'Attempt limit reached')}</span></div><button class="btn" data-task="${t.id}">Inspect</button></div>`).join('')}</div></section>`:''}`,'Task board');
}
function card(t) {return `<article class="card" data-task="${t.id}" tabindex="0" role="button" aria-label="Open ${esc(t.title)}"><span class="chip ${t.status==='approval_pending'?'approval':t.status==='blocked'?'blocked':'cpc'}">${esc(t.business_unit)}</span><h3>${esc(t.title)}</h3><p>${esc(agent(t.worker_id))}</p><div class="meta"><span>${esc(t.status.replaceAll('_',' '))}</span><span>${t.due_at?esc(date(t.due_at)):'No due date'}</span></div></article>`}
function objectives() {return shell(`<section class="panel"><h2>Company objectives</h2><div class="list">${state.objectives.length?state.objectives.map(o=>{const linked=state.tasks.filter(t=>t.objective_id===o.id);return `<div class="row"><div><span class="chip">${esc(o.business_unit)}</span><strong style="margin-top:8px">${esc(o.title)}</strong><span class="sub">${esc(o.description||'')} · ${linked.length} tasks · ${esc(o.status)}</span></div><span class="muted small">${o.due_at?'Due '+esc(date(o.due_at)):'No due date'}</span></div>`}).join(''):'<div class="empty">Add an objective to group the team’s work.</div>'}</div></section>`,'Objectives','DIRECTION');}
function agents() {const deps=[...new Set(state.agents.map(a=>a.department))].sort();return shell(`${deps.length?deps.map(dep=>`<section class="panel"><h2>${esc(dep)}</h2><div class="grid-two">${state.agents.filter(a=>a.department===dep).map(a=>`<div class="row"><div class="agent-title"><div class="avatar">${esc(a.display_name.slice(0,1).toUpperCase())}</div><div><strong>${esc(a.display_name)}</strong><span class="sub">${esc(a.role)} · ${esc(a.workflow_key)}</span></div></div><button class="btn ${a.enabled?'':'ghost'}" data-agent-toggle="${a.id}" aria-label="${a.enabled?'Pause':'Enable'} ${esc(a.display_name)}">${a.enabled?'Active':'Paused'}</button></div>`).join('')}</div></section>`).join(''):'<section class="panel empty">Add a worker and a separate reviewer to start assigning tasks.</section>'}`,'Agent team','ROSTER');}
function approvals() {const waiting=state.tasks.filter(t=>t.status==='approval_pending');return shell(`<section class="panel"><h2>Waiting for your decision</h2><div class="list">${waiting.length?waiting.map(t=>`<div class="row"><div><span class="chip approval">${esc(t.business_unit)}</span><strong style="margin-top:8px">${esc(t.title)}</strong><span class="sub">Review passed · ${esc(agent(t.reviewer_id))}</span></div><button class="btn" data-task="${t.id}">Review output</button></div>`).join(''):'<div class="empty">Nothing is waiting for approval.</div>'}</div></section>`,'Approvals','DECISIONS');}
function drawer() {
  if(state.drawer==='task-detail') {
    const t=byId(state.tasks,state.detailId); if(!t)return '';
    const reviews=state.reviews.filter(r=>r.task_id===t.id); const events=state.events.filter(e=>e.task_id===t.id);
    return `<div class="overlay" data-action="close"><aside class="drawer" role="dialog" aria-modal="true" aria-label="Task details"><div class="drawer-head"><div><p class="eyebrow">${esc(t.business_unit)} · ${esc(t.status.replaceAll('_',' '))}</p><h1>${esc(t.title)}</h1></div><button class="close" data-action="close" aria-label="Close">×</button></div><p class="muted">${esc(t.brief)}</p><div class="detail"><strong>Assignment</strong><p class="small">Worker: ${esc(agent(t.worker_id))}<br>Reviewer: ${esc(agent(t.reviewer_id))}<br>Source: ${esc(t.source_table||'—')}${t.source_id?' / '+esc(t.source_id):''}<br>Due: ${esc(date(t.due_at))}</p></div><div class="detail"><strong>Acceptance criteria</strong><pre>${esc(JSON.stringify(t.acceptance_criteria,null,2))}</pre></div><div class="detail"><strong>Latest output</strong><pre>${esc(t.output?JSON.stringify(t.output,null,2):'No output yet')}</pre></div>${reviews.length?`<div class="detail"><strong>Reviews</strong>${reviews.map(r=>`<p class="small"><span class="chip ${r.verdict==='revise'?'blocked':''}">${esc(r.verdict)}</span> ${esc(date(r.created_at))}<br>${esc(JSON.stringify(r.findings))}</p>`).join('')}</div>`:''}${t.status==='approval_pending'?`<div class="detail"><strong>Decision</strong><p class="muted small">Approving closes the task. Trigger any external publishing only from an n8n workflow that verifies approval.</p><div class="field"><label for="decision-note">Decision note</label><textarea id="decision-note" placeholder="Optional note"></textarea></div><div class="actions"><button class="btn primary" data-decision="approved">Approve</button><button class="btn danger" data-decision="rejected">Reject</button></div></div>`:''}<div class="detail"><strong>Activity</strong><div class="timeline">${events.length?events.map(e=>`<div class="event"><strong>${esc(e.event_type.replaceAll('_',' '))}</strong><span>${esc(date(e.created_at))}</span></div>`).join(''):'<span class="muted small">No activity recorded.</span>'}</div></div></aside></div>`;
  }
  const type=state.drawer;
  const fields=type==='new-task'?`<div class="field"><label>Title<input name="title" required maxlength="160"></label></div><div class="field"><label>Business<input name="business_unit" required placeholder="CPC or Muster Group"></label></div><div class="field"><label>Brief<textarea name="brief" required></textarea></label></div><div class="field"><label>Objective<select name="objective_id"><option value="">None</option>${state.objectives.map(o=>`<option value="${o.id}">${esc(o.business_unit)} · ${esc(o.title)}</option>`).join('')}</select></label></div><div class="field"><label>Worker<select name="worker_id" required><option value="">Select worker</option>${state.agents.filter(a=>a.enabled&&['worker','manager'].includes(a.role)).map(a=>`<option value="${a.id}">${esc(a.display_name)}</option>`).join('')}</select></label></div><div class="field"><label>Reviewer<select name="reviewer_id" required><option value="">Select reviewer</option>${state.agents.filter(a=>a.enabled&&a.role==='reviewer').map(a=>`<option value="${a.id}">${esc(a.display_name)}</option>`).join('')}</select></label></div><div class="field"><label>Acceptance criteria (one per line)<textarea name="criteria" required placeholder="Check factual claims against sources&#10;Check CTA and compliance flags"></textarea></label></div><div class="field"><label>Source table (optional)<input name="source_table" placeholder="cpc_content_queue"></label></div><div class="field"><label>Source record ID (optional)<input name="source_id"></label></div><div class="field"><label>Due date<input name="due_at" type="datetime-local"></label></div><div class="field"><label><input name="requires_approval" type="checkbox" checked> Require my approval</label></div>`:type==='new-agent'?`<div class="field"><label>Display name<input name="display_name" required></label></div><div class="field"><label>Agent key<input name="agent_key" required placeholder="cpc-marketing-writer" pattern="[a-z0-9-]+"></label></div><div class="field"><label>Department<input name="department" required placeholder="Marketing"></label></div><div class="field"><label>Role<select name="role"><option value="worker">Worker</option><option value="manager">Manager</option><option value="reviewer">Reviewer</option></select></label></div><div class="field"><label>n8n workflow key<input name="workflow_key" required placeholder="cpc-content-draft"></label></div>`:`<div class="field"><label>Business<input name="business_unit" required placeholder="CPC or Muster Group"></label></div><div class="field"><label>Objective title<input name="title" required></label></div><div class="field"><label>Description<textarea name="description"></textarea></label></div><div class="field"><label>Due date<input name="due_at" type="datetime-local"></label></div>`;
  const title={'new-task':'New task','new-agent':'Add agent','new-objective':'New objective'}[type];
  return `<div class="overlay" data-action="close"><aside class="drawer" role="dialog" aria-modal="true" aria-label="${title}"><div class="drawer-head"><h1>${title}</h1><button class="close" data-action="close" aria-label="Close">×</button></div>${state.error?`<p class="error" role="alert">${esc(state.error)}</p>`:''}<form id="create-form" data-type="${type}">${fields}<button class="btn primary" type="submit">Create ${type.slice(4)}</button></form></aside></div>`;
}
function render() {
  if(!configReady) {root.innerHTML=`<div class="login-wrap"><div class="login-card"><div class="brand"><span class="brandmark">M</span> MISSION CONTROL</div><h1>Connect Supabase</h1><p class="muted">Copy <code>config.example.js</code> to <code>config.js</code> and add your project URL and publishable key. Then reload this page.</p><div class="notice">Never place a Supabase secret or service-role key in config.js.</div></div></div>`;return;}
  if(!state.session) {root.innerHTML=`<div class="login-wrap"><form class="login-card" id="login-form"><div class="brand"><span class="brandmark">M</span> MISSION CONTROL</div><p class="eyebrow" style="margin-top:30px">TEAM ACCESS</p><h1>Sign in</h1><p class="muted">Use your Supabase Auth account.</p><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button class="btn primary">Sign in</button>${state.error?`<p class="error" role="alert">${esc(state.error)}</p>`:''}</form></div>`;return;}
  root.innerHTML=({board,objectives,agents,approvals}[state.view]||board)();
}
root.addEventListener('submit',async e=>{
  e.preventDefault(); const form=e.target;
  if(form.id==='login-form') {const d=Object.fromEntries(new FormData(form));try{state.error='';const s=await api('/auth/v1/token?grant_type=password',{method:'POST',body:d,auth:false});saveSession({...s,expires_at:Date.now()+s.expires_in*1000});await load();}catch(err){state.error=err.message;render();}return;}
  if(form.id!=='create-form')return;
  const d=Object.fromEntries(new FormData(form));const type=form.dataset.type;
  try {
    if(type==='new-task') {
      if(d.worker_id===d.reviewer_id)throw new Error('Choose a different agent to review the work.');
      if(Boolean(d.source_table)!==Boolean(d.source_id))throw new Error('Enter both source table and record ID, or leave both blank.');
      const body={title:d.title,business_unit:d.business_unit,brief:d.brief,worker_id:d.worker_id,reviewer_id:d.reviewer_id,objective_id:d.objective_id||null,acceptance_criteria:d.criteria.split('\n').map(s=>s.trim()).filter(Boolean),source_table:d.source_table||null,source_id:d.source_id||null,due_at:d.due_at?new Date(d.due_at).toISOString():null,requires_approval:d.requires_approval==='on'};
      await api('/rest/v1/mc_tasks',{method:'POST',body,prefer:'return=minimal'});
    } else if(type==='new-agent') {
      await api('/rest/v1/mc_agents',{method:'POST',body:{agent_key:d.agent_key,display_name:d.display_name,department:d.department,role:d.role,workflow_key:d.workflow_key},prefer:'return=minimal'});
    } else {
      await api('/rest/v1/mc_objectives',{method:'POST',body:{business_unit:d.business_unit,title:d.title,description:d.description||null,due_at:d.due_at?new Date(d.due_at).toISOString():null},prefer:'return=minimal'});
    }
    state.drawer=null;await load();
  } catch(err){state.error=err.message;render();}
});
root.addEventListener('change',e=>{if(e.target.id==='unit-filter'){state.filter=e.target.value;render();}});
root.addEventListener('click',async e=>{
  const view=e.target.closest('[data-view]');if(view){state.view=view.dataset.view;state.drawer=null;render();return;}
  const task=e.target.closest('[data-task]');if(task){state.detailId=task.dataset.task;state.drawer='task-detail';render();return;}
  const decision=e.target.closest('[data-decision]');if(decision){
    try{decision.disabled=true;await api('/rest/v1/rpc/mc_decide_approval',{method:'POST',body:{p_task_id:state.detailId,p_decision:decision.dataset.decision,p_decided_by:'dashboard',p_note:document.getElementById('decision-note')?.value||null}});state.drawer=null;await load();}catch(err){state.error=err.message;render();}return;
  }
  const toggle=e.target.closest('[data-agent-toggle]');if(toggle){const a=byId(state.agents,toggle.dataset.agentToggle);try{await api(`/rest/v1/mc_agents?id=eq.${encodeURIComponent(a.id)}`,{method:'PATCH',body:{enabled:!a.enabled},prefer:'return=minimal'});await load();}catch(err){state.error=err.message;render();}return;}
  const action=e.target.closest('[data-action]');if(!action)return;
  if(action.dataset.action==='close' && e.target!==action && !e.target.classList.contains('close'))return;
  switch(action.dataset.action){case 'close':state.drawer=null;render();break;case 'refresh':await load();break;case 'signout':saveSession(null);state.error='';render();break;default:state.drawer=action.dataset.action;render();}
});
root.addEventListener('keydown',e=>{if(e.key==='Escape'&&state.drawer){state.drawer=null;render();}if((e.key==='Enter'||e.key===' ')&&e.target.matches('[data-task]')){e.preventDefault();e.target.click();}});
setInterval(()=>{if(state.session&&!state.drawer&&!state.loading)load();},20000);
render();if(configReady&&state.session)load();
