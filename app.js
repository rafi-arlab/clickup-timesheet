// Currently pointed at the app registered in a personal test Workspace.
// For the company rollout an admin must register a second app whose redirect URL
// is the production page URL, then swap clientId here and the two Worker secrets.
// Blank clientId hides the login button and says so on screen.
const OAUTH = {
  clientId: 'XFU7D3EJGKD0NT7TUVNPKE8RVM6PBEME',
  worker: 'https://clickup-oauth.rafiharake4.workers.dev'   // see worker/
};
const oauthReady = () => !!(OAUTH.clientId && OAUTH.worker);

// Calls go through the Worker, not straight to ClickUp: ClickUp returns CORS
// headers on the preflight but not on the actual response to an OAuth Bearer
// request, so the browser discards an otherwise-fine 200.
const API = OAUTH.worker + '/api/v2';
const redirectUri = () => location.origin + location.pathname;
const MIN = 60000, HOUR = 3600000, DAY = 86400000, PXM = 1;
// SNAP is the drag grid in minutes; MIN_DUR is the smallest block you can resize to.
// At PXM=1 one pixel is one minute, so SNAP=1 gives pixel-accurate times.
const SNAP = 1, MIN_DUR = 15;

const $ = s => document.querySelector(s);

const THEMES = ['dark', 'light', 'ocean', 'forest', 'sunset'];
const applyTheme = t =>
  document.documentElement.dataset.theme = THEMES.includes(t) ? t : 'dark';

// localStorage works in both an extension page and a plain website, so one build serves both
const store = {
  get: k => { try { return JSON.parse(localStorage.getItem('cu_' + k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem('cu_' + k, JSON.stringify(v)),
  clear: () => Object.keys(localStorage).filter(k => k.startsWith('cu_'))
    .forEach(k => localStorage.removeItem(k))
};

let cfg = { token: '', teamId: '', days: 1 };
let day;                 // start of the first visible day
let days = 1;            // 1 = day view, 7 = week view
let entries = [];        // entry: {id,tid,name,start,dur,desc,dirty,del}

/* ---------- pure helpers (covered by selftest: open app.html#test) ---------- */
const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return +d; };
// setDate() rather than ±DAY arithmetic, so DST changeovers don't drift the grid
const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return +d; };
const startOfWeek = t => addDays(startOfDay(t), -((new Date(t).getDay() + 6) % 7)); // Monday
const snap = m => Math.round(m / SNAP) * SNAP;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmtDur = ms => { const m = Math.round(ms / MIN); return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0'); };
const fmtTime = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// mirrors what ClickUp's include_closed=false used to filter out for us
const isClosed = t => !!(t.status && t.status.type === 'closed');

// Request body for creating/updating a time entry.
// ClickUp's create endpoint names the stop time `stop`, update names it `end` —
// send both, or a create lands with no stop time and shows up as a running timer.
// `billable` must be explicit: the API does not inherit the Space's default, and
// omitting it on an update would clear a flag the entry already had.
function entryBody(e) {
  const b = {
    tid: e.tid,
    description: e.desc || '',
    start: e.start,
    duration: e.dur,
    stop: e.start + e.dur,
    end: e.start + e.dur,
    billable: !!e.billable
  };
  // only on updates, and only when there are tags to preserve — a bare
  // tag_action with no tags would wipe them
  if (e.id && e.tags && e.tags.length) { b.tags = e.tags; b.tag_action = 'replace'; }
  return b;
}

// side-by-side placement for overlapping blocks
function layout(list) {
  const sorted = [...list].sort((a, b) => a.start - b.start || a.dur - b.dur);
  const out = []; let cluster = [], end = -Infinity;
  const flush = () => {
    const n = Math.max(...cluster.map(c => c.lane)) + 1;
    cluster.forEach(c => c.lanes = n);
    out.push(...cluster); cluster = []; end = -Infinity;
  };
  for (const it of sorted) {
    if (cluster.length && it.start >= end) flush();
    const used = new Set(cluster.filter(c => c.item.start + c.item.dur > it.start).map(c => c.lane));
    let lane = 0; while (used.has(lane)) lane++;
    cluster.push({ item: it, lane, lanes: 1 });
    end = Math.max(end, it.start + it.dur);
  }
  if (cluster.length) flush();
  return out;
}

day = startOfDay(Date.now());

// column i spans [dayAt(i), dayAt(i+1))
const dayAt = i => addDays(day, i);
const colOf = t => { for (let i = 0; i < days; i++) if (t >= dayAt(i) && t < dayAt(i + 1)) return i; return -1; };
const colWidth = () => $('#blocks').clientWidth / days;

/* ---------- api ---------- */
async function api(path, opts = {}, retries = 2) {
  let r;
  try {
    r = await fetch(API + path, {
      ...opts,
      headers: {
        Authorization: 'Bearer ' + cfg.token,   // OAuth tokens are always Bearer
        'Content-Type': 'application/json'
      }
    });
  } catch (e) {
    // ClickUp omits CORS headers on error responses, so any 4xx/5xx arrives as
    // an opaque "Failed to fetch". Name the request so it is at least findable.
    throw new Error('Request to ' + (opts.method || 'GET') + ' ' + path +
      ' was blocked or failed (' + e.message + '). ClickUp hides the status on ' +
      'error responses — check the Network tab for the real code.');
  }
  // 429 means ClickUp never processed it, so retrying is safe even for POST.
  if (r.status === 429 && retries) {
    const reset = +r.headers.get('x-ratelimit-reset') * 1000 - Date.now();
    const wait = clamp(isFinite(reset) && reset > 0 ? reset + 500 : 5000, 1000, 60000);
    say('Rate limited by ClickUp — retrying in ' + Math.ceil(wait / 1000) + 's…');
    await new Promise(done => setTimeout(done, wait));
    return api(path, opts, retries - 1);
  }
  const body = await r.text();
  if (!r.ok) throw new Error(r.status + ': ' + body.slice(0, 200));
  return body ? JSON.parse(body) : {};
}
const say = (msg, isErr) => { $('#status').textContent = msg || ''; $('#status').className = isErr ? 'err' : ''; };
const guard = fn => (...a) => fn(...a).catch(e => { say(e.message, true); console.error(e); });

/* ---------- sidebar tree ---------- */
// `path` is the lowercased Space > Folder > List > Task trail; the filter matches on it.
const low = s => (s || '').toLowerCase();

function branch(label, path, load) {
  const d = document.createElement('details');
  d.innerHTML = '<summary></summary><div class="kids"></div>';
  d.querySelector('summary').textContent = label;
  d.dataset.path = path;
  const kids = d.querySelector('.kids');
  if (!load) return d;                       // children already attached
  d.addEventListener('toggle', () => {
    if (!d.open || kids.dataset.loaded) return;
    kids.dataset.loaded = '1'; kids.textContent = '…';
    load(kids).then(
      () => {
        if (!kids.children.length) kids.textContent = '(empty)';
        applyFilter($('#q').value);      // newly arrived tasks still have to be filtered
      },
      e => { kids.textContent = e.message; kids.className = 'kids err'; }
    );
  });
  return d;
}

function taskEl(t, path) {
  const el = document.createElement('div');
  el.className = 'task'; el.draggable = true;
  el.dataset.path = path + ' ' + low(t.name);
  el.innerHTML = '<b></b><small></small>';
  el.querySelector('b').textContent = t.name;
  el.querySelector('small').textContent =
    [t.list && t.list.name, t.status && t.status.status].filter(Boolean).join(' · ');
  el.addEventListener('dragstart', e =>
    e.dataTransfer.setData('text/plain', JSON.stringify({ id: t.id, name: t.name })));
  el.addEventListener('dblclick', () => addEntry(t.id, t.name, nextFreeStart()));
  return el;
}

// open tasks inline, closed ones tucked into their own sub-branch so search still finds them
function renderTasks(box, tasks, path) {
  box.textContent = '';
  const open = [], closed = [];
  (tasks || []).forEach(t => (isClosed(t) ? closed : open).push(t));
  open.forEach(t => box.append(taskEl(t, path)));
  if (!closed.length) return;
  const cPath = path + ' closed';
  const cEl = branch('✓ Closed (' + closed.length + ')', cPath, null);
  const cBox = cEl.querySelector(':scope > .kids');
  closed.forEach(t => cBox.append(taskEl(t, cPath)));
  box.append(cEl);
}

const listBranch = (l, parent) => {
  const path = parent + ' ' + low(l.name);
  return branch('▤ ' + l.name, path, async box => {
    const r = await api('/list/' + l.id + '/task?archived=false&subtasks=true&include_closed=true');
    renderTasks(box, r.tasks, path);
  });
};

const folderBranch = (f, parent) => {
  const path = parent + ' ' + low(f.name);
  const el = branch('📁 ' + f.name, path, null);
  const box = el.querySelector(':scope > .kids');
  (f.lists || []).forEach(l => box.append(listBranch(l, path)));
  return el;
};

const errLine = (msg, path) => {
  const e = document.createElement('div');
  e.className = 'err'; e.dataset.path = path; e.textContent = msg;
  return e;
};

// Most people log to the same handful of tasks all week, so surface those first.
// Derived from time entries we can fetch in one call rather than any extra state.
function recentTasks(data, limit = 15) {
  const seen = new Map();
  for (const t of (data || []).slice().sort((a, b) => +b.start - +a.start)) {
    const task = t.task;
    if (!task || !task.id || seen.has(task.id)) continue;
    seen.set(task.id, task);
    if (seen.size >= limit) break;
  }
  return [...seen.values()];
}

// Two phases: My tasks renders as soon as it arrives, then the rest of the
// workspace fills in underneath. Nothing waits for the slowest call.
async function loadTree() {
  const tree = $('#tree'); tree.textContent = '';

  const mine = branch('★ My tasks', 'my tasks', async box => {
    const me = await api('/user');
    const r = await api('/team/' + cfg.teamId + '/task?assignees[]=' + me.user.id +
      '&include_closed=true&subtasks=true&order_by=updated');
    renderTasks(box, r.tasks, 'my tasks');
  });
  tree.append(mine); mine.open = true;      // opening it starts its own fetch

  const pending = document.createElement('div');
  pending.className = 'kids';
  pending.textContent = 'Loading the rest of the workspace…';
  tree.append(pending);

  const now = Date.now();
  const [{ spaces }, shared, recent] = await Promise.all([
    api('/team/' + cfg.teamId + '/space?archived=false'),
    api('/team/' + cfg.teamId + '/shared').catch(e => ({ err: e.message })),
    api('/team/' + cfg.teamId + '/time_entries?start_date=' + (now - 30 * DAY) +
      '&end_date=' + now).catch(() => ({}))
  ]);

  // Load every Space's folders + folderless lists up front so search can see them.
  // One bad Space shouldn't blank the whole tree.
  const loaded = await Promise.all((spaces || []).map(async sp => {
    const grab = p => api(p).catch(e => ({ err: e.message }));
    const [f, l] = await Promise.all([
      grab('/space/' + sp.id + '/folder?archived=false'),
      grab('/space/' + sp.id + '/list?archived=false')
    ]);
    return { sp, folders: f.folders || [], lists: l.lists || [], err: f.err || l.err };
  }));

  pending.remove();

  const recents = recentTasks(recent.data);
  if (recents.length) {
    const rPath = 'recent';
    const rEl = branch('🕘 Recent (' + recents.length + ')', rPath, null);
    const rBox = rEl.querySelector(':scope > .kids');
    recents.forEach(t => rBox.append(taskEl(t, rPath)));
    tree.append(rEl); rEl.open = true;      // below My tasks, which leads
  }

  // Things shared directly with you live outside the space→folder→list walk above,
  // because you don't have access to their parent. Separate endpoint.
  const sh = shared.shared || {};
  const shCount = (sh.folders || []).length + (sh.lists || []).length + (sh.tasks || []).length;
  if (shared.err || shCount) {
    const path = 'shared with me';
    const el = branch('🔗 Shared with me', path, null);
    const box = el.querySelector(':scope > .kids');
    if (shared.err) box.append(errLine(shared.err + ' — reload to retry', path));
    (sh.folders || []).forEach(f => box.append(folderBranch(f, path)));
    (sh.lists || []).forEach(l => box.append(listBranch(l, path)));
    (sh.tasks || []).forEach(t => box.append(taskEl(t, path)));
    tree.append(el); el.open = true;
  }

  const failed = loaded.filter(s => s.err).length;
  for (const { sp, folders, lists, err } of loaded) {
    const spPath = low(sp.name);
    const spEl = branch((err ? '⚠ ' : '') + sp.name, spPath, null);
    const box = spEl.querySelector(':scope > .kids');
    if (err) {                       // never render a failed Space as an empty one
      box.append(errLine(err + ' — reload to retry', spPath));
      spEl.open = true;
    }
    folders.forEach(f => box.append(folderBranch(f, spPath)));
    lists.forEach(l => box.append(listBranch(l, spPath)));
    tree.append(spEl);
  }
  if (failed) say(failed + ' space(s) failed to load — see ⚠ in the sidebar', true);
}

/* ---------- filter: matches spaces, folders, lists and loaded tasks ---------- */
const kidsOf = el => el.tagName === 'DETAILS'
  ? [...el.querySelector(':scope > .kids').children].filter(c => c.dataset.path)
  : [];

function reveal(el) {
  el.hidden = false;
  el.querySelectorAll('[data-path]').forEach(n => n.hidden = false);
}

// returns true if this node or any descendant matches every term
function filterNode(el, terms) {
  if (!terms.length) {
    el.hidden = false;
    if (el.dataset.auto) { el.open = false; delete el.dataset.auto; }
    kidsOf(el).forEach(c => filterNode(c, terms));
    return true;
  }
  if (terms.every(t => el.dataset.path.includes(t))) { reveal(el); return true; }
  const hit = kidsOf(el).map(c => filterNode(c, terms)).some(Boolean);
  el.hidden = !hit;
  if (hit && !el.open) { el.open = true; el.dataset.auto = '1'; }
  return hit;
}

// Search index. Tasks load per list on demand, so an unexpanded list would be
// invisible to search. Rather than opening every list (one request each, and
// still capped at 100 tasks per list), page the workspace-wide task endpoint:
// one request per 100 tasks no matter how many lists exist.
let taskIndex = null, indexing = null;
const INDEX_PAGES = 25;            // 2500 tasks; see the cap message below

async function ensureIndex() {
  if (taskIndex) return taskIndex;
  if (indexing) return indexing;          // a second keystroke must not start a second sweep
  indexing = (async () => {
    const found = [];
    let page = 0, capped = false;
    for (; page < INDEX_PAGES; page++) {
      const r = await api('/team/' + cfg.teamId + '/task?page=' + page +
        '&subtasks=true&include_closed=true&order_by=updated');
      const batch = r.tasks || [];
      found.push(...batch);
      say('Indexing tasks for search… ' + found.length);
      if (batch.length < 100) break;      // short page means we reached the end
      if (page === INDEX_PAGES - 1) capped = true;
    }
    taskIndex = found;
    say(capped ? 'Search covers the ' + found.length + ' most recently updated tasks.' : '');
    return taskIndex;
  })();
  try { return await indexing; } finally { indexing = null; }
}

// A task matches when every term appears somewhere in its name or its location,
// so "snapchat adidas" narrows the same way it does in the tree.
const taskHaystack = t => [t.name, t.list && t.list.name,
  t.folder && t.folder.name, t.space && t.space.name].map(low).join(' ');
const matchesTerms = (t, terms) => {
  const hay = taskHaystack(t);
  return terms.every(term => hay.includes(term));
};

// Flat matches from the index, shown above the tree so nothing has to be expanded.
function renderResults(q) {
  const old = $('#results');
  if (old) old.remove();
  const terms = low(q).split(/\s+/).filter(Boolean);
  if (!terms.length || !taskIndex) return;

  const hits = taskIndex.filter(t => matchesTerms(t, terms));

  const shown = hits.slice(0, 50);
  const label = '🔎 Matches (' + hits.length + (hits.length > shown.length ? ', showing 50' : '') + ')';
  const el = branch(label, '', null);
  el.id = 'results';
  delete el.dataset.path;            // managed here, not by the tree filter
  const box = el.querySelector(':scope > .kids');
  shown.forEach(t => box.append(taskEl(t, 'results')));
  if (!shown.length) box.textContent = 'No task matches — try fewer words.';
  $('#tree').prepend(el);
  el.open = true;
}

function applyFilter(q) {
  const terms = low(q).split(/\s+/).filter(Boolean);
  [...$('#tree').children].filter(c => c.dataset.path).forEach(c => filterNode(c, terms));
}

/* ---------- timeline ---------- */
function drawGrid() {
  const g = $('#grid'), gut = $('#gutter');
  g.textContent = ''; gut.textContent = '';
  for (let h = 0; h <= 24; h++) {
    const y = h * 60 * PXM;
    g.insertAdjacentHTML('beforeend', '<hr style="top:' + y + 'px">');
    if (h < 24) g.insertAdjacentHTML('beforeend', '<hr class="half" style="top:' + (y + 30 * PXM) + 'px">');
    const lab = document.createElement('div');
    lab.style.top = y + 'px';
    lab.textContent = String(h).padStart(2, '0') + ':00';
    gut.append(lab);
  }
  for (let i = 1; i < days; i++)
    g.insertAdjacentHTML('beforeend', '<div class="vline" style="left:' + (i * 100 / days) + '%"></div>');
}

function drawHeader(perCol) {
  const h = $('#dayhdr'); h.textContent = '';
  const today = startOfDay(Date.now());
  for (let i = 0; i < days; i++) {
    const t = dayAt(i), d = document.createElement('div');
    if (t === today) d.className = 'today';
    d.innerHTML = '<span></span><small></small>';
    d.querySelector('span').textContent = new Date(t).toLocaleDateString([],
      days > 1 ? { weekday: 'short', day: 'numeric' }
        : { weekday: 'long', month: 'short', day: 'numeric' });
    d.querySelector('small').textContent = perCol[i] ? fmtDur(perCol[i]) : '—';
    h.append(d);
  }
}

function render() {
  const box = $('#blocks'); box.textContent = '';
  document.querySelectorAll('.now').forEach(n => n.remove());
  const vis = entries.filter(e => !e.del);

  const cols = Array.from({ length: days }, () => []);
  const perCol = Array.from({ length: days }, () => 0);
  for (const e of vis) {
    const c = colOf(e.start);
    if (c < 0) continue;                    // outside the visible range
    cols[c].push(e); perCol[c] += e.dur;
  }

  const colPct = 100 / days;
  cols.forEach((list, col) => {
    for (const { item, lane, lanes } of layout(list)) {
      const h = Math.max(item.dur / MIN * PXM, 14);
      const el = document.createElement('div');
      el.className = 'block' + (item.dirty || !item.id ? ' dirty' : '') +
        (item.billable ? '' : ' nb') +
        (h < 34 ? ' short' : '');            // too short for two lines — go single-line
      el.style.top = clamp((item.start - dayAt(col)) / MIN * PXM, 0, 24 * 60 * PXM) + 'px';
      el.style.height = h + 'px';
      el.style.left = 'calc(' + ((col + lane / lanes) * colPct) + '% + 2px)';
      el.style.width = 'calc(' + (colPct / lanes) + '% - 4px)';
      el.innerHTML = '<b></b><span></span><div class="bill" title="Billable">$</div>' +
        '<div class="x">×</div><div class="grip"></div>';
      el.querySelector('b').textContent = item.name;
      el.querySelector('span').textContent =
        fmtTime(item.start) + '–' + fmtTime(item.start + item.dur) + ' · ' + fmtDur(item.dur) +
        (item.desc ? ' · ' + item.desc : '');
      el.querySelector('.x').onclick = e => { e.stopPropagation(); item.del = true; render(); };
      el.querySelector('.bill').onclick = e => {
        e.stopPropagation();
        item.billable = !item.billable; item.dirty = true; render();
      };
      el.ondblclick = () => {
        const d = prompt('Note for this entry:', item.desc || '');
        if (d !== null) { item.desc = d; item.dirty = true; render(); }
      };
      el.addEventListener('pointerdown', ev => {
        if (ev.target.closest('.bill, .x')) return;   // let those fire their click
        startDrag(ev, item, ev.target.classList.contains('grip'));
      });
      box.append(el);
    }
  });

  drawHeader(perCol);
  $('#total').textContent = fmtDur(vis.reduce((s, e) => s + e.dur, 0));

  const nowCol = colOf(Date.now());
  if (nowCol >= 0) {
    const line = document.createElement('div');
    line.className = 'now';                 // inside #blocks, so % is per-column
    line.style.top = (Date.now() - dayAt(nowCol)) / MIN * PXM + 'px';
    line.style.left = (nowCol * colPct) + '%';
    line.style.width = colPct + '%';
    box.append(line);
  }
}

function startDrag(ev, item, resizing) {
  if (ev.button !== 0) return;
  ev.preventDefault();
  const x0 = ev.clientX, y0 = ev.clientY, dur0 = item.dur;
  const col0 = colOf(item.start), min0 = (item.start - dayAt(col0)) / MIN;
  const cw = colWidth();
  const move = e => {
    const dm = (e.clientY - y0) / PXM;
    if (resizing) {
      item.dur = clamp(snap(dur0 / MIN + dm), MIN_DUR, 24 * 60 - min0) * MIN;
    } else {
      const col = clamp(col0 + Math.round((e.clientX - x0) / cw), 0, days - 1);
      const m = clamp(snap(min0 + dm), 0, 24 * 60 - item.dur / MIN);
      item.start = dayAt(col) + m * MIN;
    }
    item.dirty = true;
    render();
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

// append after the last block on the day you're looking at (today if it's in range)
function nextFreeStart() {
  const col = Math.max(colOf(Date.now()), 0);
  const base = dayAt(col);
  const sameDay = entries.filter(e => !e.del && colOf(e.start) === col);
  const end = sameDay.length ? Math.max(...sameDay.map(e => e.start + e.dur)) : base + 9 * HOUR;
  return Math.min(end, base + 23 * HOUR);
}

function addEntry(tid, name, start, dur = HOUR) {
  entries.push({
    id: null, tid, name, start, dur, desc: '', dirty: true,
    billable: store.get('billable') !== false     // default on; ClickUp's API won't infer it
  });
  render();
}

/* ---------- day load / save ---------- */
async function loadDay() {
  say('Loading…');
  const r = await api('/team/' + cfg.teamId + '/time_entries?start_date=' + dayAt(0) +
    '&end_date=' + (dayAt(days) - 1));
  entries = (r.data || []).filter(t => +t.duration > 0).map(t => ({
    id: t.id, tid: t.task && t.task.id, name: (t.task && t.task.name) || '(no task)',
    start: +t.start, dur: +t.duration, desc: t.description || '',
    billable: !!t.billable, tags: t.tags || []
  }));
  render(); say('');
}

async function save() {
  say('Saving…');
  for (const e of entries.filter(e => e.del && e.id))
    await api('/team/' + cfg.teamId + '/time_entries/' + e.id, { method: 'DELETE' });
  for (const e of entries.filter(e => !e.del && e.dirty)) {
    const body = JSON.stringify(entryBody(e));
    if (e.id) await api('/team/' + cfg.teamId + '/time_entries/' + e.id, { method: 'PUT', body });
    else {
      const r = await api('/team/' + cfg.teamId + '/time_entries', { method: 'POST', body });
      e.id = r.data && r.data.id;
    }
    e.dirty = false;
  }
  entries = entries.filter(e => !e.del);
  render(); say('Saved.');
}

/* ---------- wiring ---------- */
function setDay(t) {
  day = days > 1 ? startOfWeek(t) : startOfDay(t);
  $('#date').value = new Date(day - new Date(day).getTimezoneOffset() * MIN).toISOString().slice(0, 10);
  $('#view').textContent = days > 1 ? 'Day' : 'Week';
  drawGrid();
  guard(loadDay)();
}

/* ---------- oauth ---------- */
function startOauth() {
  // state guards against someone feeding us an authorization code we didn't ask for
  const state = crypto.randomUUID();
  store.set('oauthState', state);
  location.href = 'https://app.clickup.com/api?client_id=' + encodeURIComponent(OAUTH.clientId) +
    '&redirect_uri=' + encodeURIComponent(redirectUri()) +
    '&state=' + encodeURIComponent(state);
}

// Returns true if this load was an OAuth redirect back from ClickUp (handled or failed).
async function finishOauth() {
  const q = new URLSearchParams(location.search);
  const code = q.get('code');
  if (!code && !q.get('error')) return false;

  // strip the code out of the URL and history either way — it is single-use
  const clean = () => history.replaceState(null, '', redirectUri());
  const expected = store.get('oauthState');
  store.set('oauthState', null);

  if (q.get('error')) { clean(); throw new Error('ClickUp denied the request: ' + q.get('error')); }
  if (!expected || q.get('state') !== expected) {
    clean();
    throw new Error('Login state did not match, so the request was discarded. Try Connect again.');
  }

  let r;
  try {
    r = await fetch(OAUTH.worker + '/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
  } catch (e) {
    clean();
    throw new Error('Could not reach the login service at ' + OAUTH.worker +
      ' (' + e.message + ')');
  }
  const data = await r.json().catch(() => ({}));
  clean();
  if (!r.ok || !data.access_token) throw new Error(data.error || 'Token exchange failed (' + r.status + ')');

  cfg.token = data.access_token;
  store.set('token', cfg.token); store.set('mode', 'oauth');
  return true;
}

async function boot() {
  // /team returns exactly the Workspaces this token is authorized for.
  // There is no /oauth/team — that path 404s, and because ClickUp omits CORS
  // headers on error responses the browser reports it as "Failed to fetch".
  const { teams } = await api('/team');
  $('#team').textContent = '';
  for (const t of teams) {
    const o = document.createElement('option');
    o.value = t.id; o.textContent = t.name;
    $('#team').append(o);
  }
  cfg.teamId = teams.some(t => t.id === cfg.teamId) ? cfg.teamId : teams[0].id;
  $('#team').value = cfg.teamId;
  store.set('teamId', cfg.teamId);
  setDay(day);                 // timeline and sidebar load independently
  guard(loadTree)();
  $('#scroll').scrollTop = 7 * 60 * PXM;
}

function wire() {
  $('#connect').onclick = startOauth;
  $('#logout').onclick = () => { store.clear(); location.reload(); };
  $('#team').onchange = guard(async () => {
    cfg.teamId = $('#team').value;
    store.set('teamId', cfg.teamId);
    setDay(day); guard(loadTree)();
  });
  $('#view').onclick = () => {
    days = days > 1 ? 1 : 7;
    store.set('days', days);
    setDay(days > 1 ? day : Math.max(day, Math.min(startOfDay(Date.now()), addDays(day, 6))));
  };
  $('#theme').value = document.documentElement.dataset.theme;
  $('#theme').onchange = e => { applyTheme(e.target.value); store.set('theme', e.target.value); };
  $('#defbill').checked = store.get('billable') !== false;
  $('#defbill').onchange = e => store.set('billable', e.target.checked);
  $('#prev').onclick = () => setDay(addDays(day, -days));
  $('#next').onclick = () => setDay(addDays(day, days));
  $('#today').onclick = () => setDay(Date.now());
  $('#date').onchange = e => e.target.value && setDay(new Date(e.target.value + 'T00:00'));
  $('#save').onclick = guard(save);

  $('#q').oninput = guard(async e => {
    const q = e.target.value;
    applyFilter(q);                        // tree filtering is instant, do it first
    if (q.trim().length < 2) return renderResults('');
    await ensureIndex();
    if ($('#q').value === q) renderResults(q);   // ignore a stale sweep
  });
  $('#q').onkeydown = guard(async e => {
    if (e.key !== 'Enter') return;
    const m = e.target.value.match(/\/t\/([\w-]+)/);
    const id = m ? m[1] : e.target.value.trim();
    if (!id) return;
    const t = await api('/task/' + id);
    const b = branch('🔎 ' + t.name, low(t.name), null);
    b.querySelector(':scope > .kids').append(taskEl(t, low(t.name)));
    $('#tree').prepend(b); b.open = true;
    e.target.value = ''; applyFilter('');
  });

  const tl = $('#tl');
  tl.addEventListener('dragover', e => { e.preventDefault(); tl.classList.add('over'); });
  tl.addEventListener('dragleave', () => tl.classList.remove('over'));
  tl.addEventListener('drop', e => {
    e.preventDefault(); tl.classList.remove('over');
    const raw = e.dataTransfer.getData('text/plain');
    const t = raw ? JSON.parse(raw) : {};
    if (!t.id) return;
    const cols = $('#blocks').getBoundingClientRect();
    const col = clamp(Math.floor((e.clientX - cols.left) / colWidth()), 0, days - 1);
    const mins = clamp(snap((e.clientY - tl.getBoundingClientRect().top) / PXM), 0, 24 * 60 - 60);
    addEntry(t.id, t.name, dayAt(col) + mins * MIN);
  });

  addEventListener('beforeunload', e => {
    if (entries.some(x => x.dirty || x.del)) e.preventDefault();
  });
}

/* ---------- selftest: open app.html#test ---------- */
function selftest() {
  const A = (c, m) => { if (!c) throw new Error('FAIL ' + m); };
  A(snap(7) === 7 && snap(43) === 43, 'snap keeps whole-minute precision');
  A(snap(7.4) === 7 && snap(7.6) === 8, 'fractional pixels round to the nearest minute');
  // the resize floor is independent of the snap grid
  A(clamp(snap(3), MIN_DUR, 1440) === MIN_DUR, 'resize cannot go below MIN_DUR');
  A(clamp(snap(17), MIN_DUR, 1440) === 17, 'durations above MIN_DUR are minute-accurate');
  A(fmtDur(5400000) === '1h30', 'fmtDur');
  A(clamp(99, 0, 10) === 10, 'clamp');
  const l = layout([
    { start: 0, dur: 2 * HOUR }, { start: HOUR, dur: HOUR }, { start: 5 * HOUR, dur: HOUR }
  ]);
  A(l.length === 3, 'layout keeps all items');
  A(l[0].lanes === 2 && l[1].lanes === 2, 'overlapping pair gets 2 lanes');
  A(l[0].lane !== l[1].lane, 'overlapping pair gets distinct lanes');
  A(l[2].lanes === 1, 'disjoint item is its own cluster');

  // week grid: Monday anchoring and day-column mapping
  const wed = +new Date(2026, 7, 26);                    // Wed 26 Aug 2026
  A(new Date(startOfWeek(wed)).getDate() === 24, 'startOfWeek snaps back to Monday');
  A(startOfWeek(startOfWeek(wed)) === startOfWeek(wed), 'startOfWeek is idempotent');
  const savedDay = day, savedDays = days;
  day = startOfWeek(wed); days = 7;
  A(colOf(day) === 0 && colOf(wed) === 2, 'colOf maps a date to its weekday column');
  A(colOf(addDays(day, 6) + 23 * HOUR) === 6, 'last hour of Sunday is still column 6');
  A(colOf(addDays(day, -1)) === -1 && colOf(addDays(day, 7)) === -1, 'out-of-range dates have no column');
  A(dayAt(7) - dayAt(0) >= 6 * DAY, 'week spans seven day boundaries');
  day = savedDay; days = savedDays;

  // filter across Space > Folder > List
  const nest = (parent, child) => { parent.querySelector(':scope > .kids').append(child); return parent; };
  const li = branch('Q3 Campaign', 'snapchat adidas q3 campaign', null);
  const fo = nest(branch('Adidas', 'snapchat adidas', null), li);
  const sp = nest(branch('Snapchat', 'snapchat', null), fo);
  const other = branch('Nike', 'nike', null);
  $('#tree').append(sp, other);

  applyFilter('adidas');
  A(!sp.hidden && !fo.hidden && !li.hidden, 'match reveals ancestors and children');
  A(sp.open, 'ancestor of a match auto-opens');
  A(other.hidden, 'non-matching space is hidden');
  applyFilter('snapchat q3');
  A(!li.hidden && !fo.hidden, 'multi-term matches across the whole path');
  applyFilter('');
  A(!other.hidden && !sp.open, 'clearing restores and re-collapses');

  // closed tasks split into their own sub-branch, and stay searchable
  const tb = document.createElement('div');
  renderTasks(tb, [
    { id: '1', name: 'Alpha', status: { type: 'open', status: 'to do' } },
    { id: '2', name: 'Beta', status: { type: 'closed', status: 'closed' } },
    { id: '3', name: 'Gamma', status: { type: 'done', status: 'done' } }
  ], 'list');
  A(tb.querySelectorAll(':scope > .task').length === 2, 'open and done tasks stay inline');
  const cb = tb.querySelector(':scope > details');
  A(cb && cb.dataset.path === 'list closed', 'closed tasks get a Closed branch');
  A(cb.querySelectorAll('.task').length === 1, 'only the closed task is nested');
  A(cb.querySelector('.task').dataset.path === 'list closed beta', 'closed task path is searchable');
  const empty = document.createElement('div');
  renderTasks(empty, [{ id: '4', name: 'Solo', status: { type: 'open' } }], 'list');
  A(!empty.querySelector('details'), 'no Closed branch when nothing is closed');

  console.log('selftest OK');
  document.title = 'selftest OK';
}

function showSetup(err) {
  $('#setup').hidden = false;
  $('#app').hidden = true;
  // no point offering a login button that can't work yet
  $('#connect').hidden = !oauthReady();
  $('#setupErr').textContent = err || (oauthReady() ? '' :
    'Login is not configured yet — set OAUTH.clientId and OAUTH.worker in app.js.');
}

(async () => {
  applyTheme(store.get('theme'));      // before wire(), so the select shows the right value
  wire();
  if (location.hash === '#test') return selftest();
  cfg.teamId = store.get('teamId') || '';
  days = store.get('days') === 7 ? 7 : 1;
  // A pk_ token saved by the older paste-a-token build would now go out as a
  // Bearer token and be rejected, so drop it and ask for a real login instead.
  if (store.get('mode') !== 'oauth') { store.set('token', null); store.set('mode', null); }
  cfg.token = store.get('token') || '';

  try {
    if (await finishOauth()) { /* token now in cfg */ }
  } catch (e) {
    return showSetup(e.message);
  }

  if (!cfg.token) return showSetup();
  $('#app').hidden = false;
  guard(boot)();
})();
