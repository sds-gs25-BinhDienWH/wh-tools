'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const LINES = ['A01','A02','A03','A04','A05','A06','A07','B08','B09','B10','B11','B12','B13','B14'];
// Địa chỉ proxy Apps Script (https://script.google.com/macros/s/.../exec): ghi MỘT LẦN ở đây,
// mọi thiết bị mở web đều dùng chung, không ai phải nhập tay.
const PROXY_URL = 'https://script.google.com/macros/s/AKfycbyV5otbjq-5N00CMUl-7mbyC36Ztqf87C8IIzaIOiRjqwV_HGsKF7akzkFIjBcBO-VZNQ/exec';
// Quản trị: mở web với ?admin=1 để hiện ô sửa địa chỉ API trong Cài đặt.
const ADMIN = new URLSearchParams(location.search).get('admin') === '1';
const LOCKED = !!PROXY_URL && !ADMIN;
const FLASH_MS = 60000;      // giữ tô sáng ô vừa đổi
const FRESH_MS = 10 * 60000; // bản lưu cũ hơn mức này thì không dùng làm mốc so sánh
const IDLE_MS = 10 * 60000;  // quá thời gian này không tra mã nào thì tự đăng xuất nhân viên
const ENABLED_TABS = ['list', 'move', 'set']; // Kiểm hàng, Ghép PAXD: tạm khoá

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
// Nhân viên đang thao tác chỉ nhớ trong phiên (đóng tab/app là phải quét lại thẻ)
const sess = {
  get() { try { return JSON.parse(sessionStorage.getItem('emp')); } catch { return null; } },
  set(v) { try { v ? sessionStorage.setItem('emp', JSON.stringify(v)) : sessionStorage.removeItem('emp'); } catch {} },
};

const S = {
  emp: sess.get(),
  base: LOCKED ? PROXY_URL : store.get('base', PROXY_URL),
  every: [0, 30, 60, 120].includes(store.get('every', 60)) ? store.get('every', 60) : 60,
  tab: store.get('tab', 'list'),
  items: [], prevMap: null, flash: new Map(), done: [],
  updatedAt: null, busy: false, error: null, timer: null,
};

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const fold = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
const sum = a => a.reduce((x, y) => x + y, 0);
const hhmmss = t => new Date(t).toLocaleTimeString('vi-VN', { hour12: false });

// ---------- Gọi API ----------
const isProxy = b => /script\.google(usercontent)?\.com/.test(b);
const mixedBlocked = () => location.protocol === 'https:' && /^http:/i.test(S.base);

// Thanh chạy ngang đầu trang: chỉ hiện nếu chờ quá 150ms để không nháy khi server trả lời nhanh
let netPending = 0, netTimer = null;
function netStart() {
  if (++netPending === 1) { clearTimeout(netTimer); netTimer = setTimeout(() => $('#netBar').classList.add('on'), 150); }
}
function netDone() {
  netPending = Math.max(0, netPending - 1);
  if (netPending === 0) { clearTimeout(netTimer); $('#netBar').classList.remove('on'); }
}

function baseOrThrow() {
  if (!S.base.trim()) throw new Error('Chưa cấu hình địa chỉ máy chủ. Vui lòng báo quản trị viên.');
  if (mixedBlocked()) throw new Error('Trang https không gọi được địa chỉ http. Cần dùng địa chỉ proxy Apps Script (https).');
  return S.base.trim().replace(/\/+$/, '');
}

// Với proxy: gửi text/plain để tránh preflight CORS; proxy tự gọi server kho và ghi log nhân viên
const proxyFetch = (base, payload, signal) => fetch(base, { method: 'POST',
  headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), signal });

async function api(method, path, body, emp) {
  const base = baseOrThrow();
  return request(signal => {
    if (isProxy(base)) return proxyFetch(base, { method, path, body: body || null, emp: emp || null }, signal);
    if (method === 'GET') return fetch(base + path, { signal });
    return fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal });
  });
}

// Xác thực mã nhân viên với Google Sheet (qua proxy). Chạy thẳng server kho thì không có sheet nên cho qua để thử.
async function loginEmp(id) {
  const base = baseOrThrow();
  if (!isProxy(base)) return { id, name: id + ' (thử nghiệm, không ghi log)' };
  return request(signal => proxyFetch(base, { action: 'login', emp: id }, signal));
}

async function request(doFetch) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  netStart();
  try {
    const res = await doFetch(ctl.signal);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data && data.__error) throw new Error(data.__error);
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Quá thời gian chờ (15 giây)');
    throw e;
  } finally { clearTimeout(timer); netDone(); }
}

// ---------- Dữ liệu hàng chờ ----------
function parseBulk(j) {
  // Hết hàng chờ: server trả {"status":"Success","message":"No item pending found","data":null}
  if (j && j.data == null && /success/i.test(j.status || '')) return [];
  const rows = Array.isArray(j) ? j : j && j.data;
  if (!Array.isArray(rows)) throw new Error((j && j.message) || 'Dữ liệu trả về không hợp lệ');
  return rows.map(r => ({
    code: String(r.ItemCode ?? ''), name: String(r.ItemName ?? ''),
    q: LINES.map(l => Number(r[l]) || 0),
  }));
}
const zoneA = it => sum(it.q.slice(0, 7));
const zoneB = it => sum(it.q.slice(7));

function applyDiff(items) {
  const now = Date.now();
  for (const [c, f] of S.flash) if (now - f.at > FLASH_MS) S.flash.delete(c);
  if (S.prevMap) {
    const cur = new Map(items.map(i => [i.code, i]));
    for (const it of items) {
      const p = S.prevMap.get(it.code);
      if (!p) { S.flash.set(it.code, { type: 'new', idx: new Set(), at: now }); continue; }
      const idx = new Set();
      it.q.forEach((v, k) => { if (v !== p.q[k]) idx.add(k); });
      if (idx.size) S.flash.set(it.code, { type: 'chg', idx, at: now });
    }
    for (const [c, p] of S.prevMap) if (!cur.has(c)) S.done.unshift({ code: c, name: p.name, at: now });
    S.done = S.done.slice(0, 30);
  }
  S.prevMap = new Map(items.map(i => [i.code, i]));
}

async function refresh() {
  if (S.busy) return;
  S.busy = true; renderStatus();
  try {
    const items = parseBulk(await api('GET', '/sftp/getAssortingPending'));
    applyDiff(items);
    S.items = items; S.updatedAt = Date.now(); S.error = null;
    store.set('snap', { at: S.updatedAt, items });
  } catch (e) {
    S.error = e.message || String(e);
  } finally {
    S.busy = false; renderList(); renderStatus();
  }
}

// every = 0 nghĩa là chỉ tải khi bấm nút "Tải lại". Không tự tải khi đang xem chi tiết một mã.
function schedule() {
  clearTimeout(S.timer);
  if (S.every <= 0) return;
  S.timer = setTimeout(async () => {
    if (!document.hidden && S.tab === 'list' && !$('#dlg').open) await refresh();
    schedule();
  }, S.every * 1000);
}

// ---------- Hiển thị ----------
function renderStatus() {
  const el = $('#status');
  el.classList.toggle('err', !!S.error);
  el.classList.toggle('busy', S.busy);
  $('#btnRefresh').classList.toggle('spinning', S.busy);
  if (S.busy) el.textContent = 'Đang tải…';
  else if (S.error) el.textContent = 'Lỗi: ' + S.error + (S.updatedAt ? ' · dữ liệu lúc ' + hhmmss(S.updatedAt) : '');
  else if (S.updatedAt) el.textContent = 'Cập nhật ' + hhmmss(S.updatedAt) + (S.every > 0 ? ' · tự tải mỗi ' + S.every + ' giây' : ' · bấm "Tải lại" để cập nhật');
  else el.textContent = 'Chưa có dữ liệu';
  const b = $('#banner');
  const blocked = !S.base.trim() || mixedBlocked();
  el.hidden = blocked;                      // đã có khung đỏ ở dưới thì không lặp lại dòng trạng thái
  b.hidden = !blocked;
  b.textContent = !S.base.trim()
    ? 'Chưa cấu hình địa chỉ máy chủ. Vui lòng báo quản trị viên.'
    : 'Trang https không gọi được địa chỉ http. Cần dùng địa chỉ proxy Apps Script (https).';
}

function linesGrid(q, flashIdx) {
  const row = from => q.slice(from, from + 7).map((v, i) => {
    const k = from + i;
    return `<div class="cell ${v === 0 ? 'zero' : ''} ${flashIdx && flashIdx.has(k) ? 'flash' : ''}"><small>${LINES[k]}</small><b>${v}</b></div>`;
  }).join('');
  return `<div class="grid">${row(0)}</div><div class="grid">${row(7)}</div>`;
}

function renderList() {
  const q = fold($('#q').value.trim());
  let items = S.items.filter(i => !q || fold(i.code).includes(q) || fold(i.name).includes(q));
  if ($('#sort').value === 'total') items = [...items].sort((a, b) => sum(b.q) - sum(a.q));
  const all = S.items;
  $('#summary').innerHTML = all.length
    ? `<span class="pill">${items.length}/${all.length} mã</span><span class="pill zA">Khu A: ${sum(all.map(zoneA))}</span><span class="pill zB">Khu B: ${sum(all.map(zoneB))}</span>`
    : (S.error ? '' : (S.updatedAt ? '<div class="empty-note">Hiện không có hàng chờ phân loại</div>' : ''));

  const dBox = $('#doneBox');
  dBox.hidden = !S.done.length;
  $('#doneTitle').textContent = `Vừa xong (${S.done.length})`;
  $('#doneList').innerHTML = S.done.map(d => `<div>${hhmmss(d.at)} · ${esc(d.code)} · ${esc(d.name)}</div>`).join('');

  const now = Date.now();
  $('#list').innerHTML = items.map(it => {
    const f = S.flash.get(it.code);
    const live = f && now - f.at <= FLASH_MS ? f : null;
    const chips = it.q.map((v, k) => v ? `<span class="chip ${LINES[k][0]} ${live && live.idx.has(k) ? 'flash' : ''}">${LINES[k]}<b>${v}</b></span>` : '').join('');
    return `<div class="card ${live && live.type === 'new' ? 'new' : ''}" data-code="${esc(it.code)}">
      <div class="name">${esc(it.name)}${live ? `<span class="tag">${live.type === 'new' ? 'MỚI' : 'ĐỔI'}</span>` : ''}</div>
      <div class="meta">${esc(it.code)} · <span class="zA">A ${zoneA(it)}</span> · <span class="zB">B ${zoneB(it)}</span> · Tổng ${sum(it.q)}</div>
      <div class="chips">${chips || '<span class="muted">Không còn hàng chờ</span>'}</div>
    </div>`;
  }).join('');
}

function showDetail(code) {
  const it = S.items.find(i => i.code === code);
  if (!it) return;
  const f = S.flash.get(code);
  $('#dlgBody').innerHTML = `<h2>${esc(it.name)}</h2><div class="muted">${esc(it.code)}</div>
    ${linesGrid(it.q, f && f.idx)}
    <div class="totals"><span class="zA">Khu A: ${zoneA(it)}</span><span class="zB">Khu B: ${zoneB(it)}</span><span>Tổng: ${sum(it.q)}</span></div>`;
  $('#dlg').showModal();
}

const errBox = e => `<div class="err-box">${esc(e.message || e)}</div>`;
const loading = '<p class="muted">Đang tải…</p>';

// ---------- Nhân viên (quét thẻ trước khi điều hàng) ----------
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 2200);
}

function renderEmp() {
  const e = S.emp;
  $('#empBox').hidden = !!e;
  $('#empBar').hidden = !e;
  $('#moveWork').hidden = !e;
  if (e) { $('#empName').textContent = e.name; $('#empId').textContent = 'Mã NV: ' + e.id; }
  if (S.tab === 'move') (e ? $('#moveCode') : $('#empCode')).focus();
}
function setEmp(e) { S.emp = e ? { ...e, at: Date.now() } : null; sess.set(S.emp); renderEmp(); }
function touchEmp() { if (S.emp) { S.emp.at = Date.now(); sess.set(S.emp); } }

async function doLoginEmp(raw) {
  const id = raw.trim().toUpperCase();
  if (!id) return;
  const out = $('#empOut');
  out.innerHTML = loading;
  try {
    const r = await loginEmp(id);
    out.innerHTML = '';
    setEmp({ id: r.id, name: r.name });
    $('#moveOut').innerHTML = '';
  } catch (e) { out.innerHTML = errBox(e); }
  $('#empCode').value = '';
}

// ---------- Điều hàng (itemPending) ----------
async function lookupItem(raw) {
  const code = raw.trim();
  if (!code) return;
  if (!S.emp) { renderEmp(); return; }
  const out = $('#moveOut');
  out.innerHTML = loading;
  try {
    const j = await api('POST', '/pda/itemPending', { ItemCode: code }, S.emp.id);
    touchEmp();
    if (!j || !Array.isArray(j.Details)) throw new Error('Không tìm thấy mã hàng');
    const q = LINES.map(() => 0);
    for (const d of j.Details) {
      const k = LINES.indexOf(String(d.Line || '').replace('-', ''));
      if (k >= 0) q[k] = Number(d.Quantity) || 0;
    }
    out.innerHTML = `<div class="card"><div class="name">${esc(j.ItemName || 'Không rõ tên')}</div>
      <div class="meta">${esc(code)}</div>${linesGrid(q)}
      <div class="totals"><span class="zA">Khu A: ${zoneA({ q })}</span><span class="zB">Khu B: ${zoneB({ q })}</span><span>Tổng: ${sum(q)}</span></div></div>`;
  } catch (e) {
    if (/^NO_EMP/.test(e.message || '')) { setEmp(null); out.innerHTML = ''; $('#empOut').innerHTML = errBox('Phiên nhân viên không hợp lệ, vui lòng quét lại thẻ.'); return; }
    out.innerHTML = errBox(e);
  }
  $('#moveCode').value = ''; $('#moveCode').focus();
}

// ---------- Ghép hàng (storeAssorted) ----------
// Quy tắc làm sạch mã cửa hàng lấy từ app cũ
function cleanStoreCode(s) {
  let t = String(s || '').trim();
  const parts = t.split(/#./);
  if (parts.length === 4) t = parts[1];
  return t.replace(/[\\`~!@#$%^&*()+=\[{\]}|'<,.>?\/";:\s]/g, '');
}

async function lookupStore(raw) {
  const code = cleanStoreCode(raw);
  if (!code) return;
  $('#storeCode').value = code;
  const out = $('#storeOut');
  out.innerHTML = loading;
  try {
    const j = await api('POST', '/pda/storeAssorted', { StoreCode: code });
    if (!Array.isArray(j)) throw new Error((j && j.message) || 'Phản hồi không đúng dạng danh sách');
    const html = j.map(loc => {
      const det = Array.isArray(loc.Details) ? loc.Details : [];
      return `<div class="loc">${esc(loc.Location || '(không có vị trí)')}</div>` + det.map(d =>
        `<div class="item"><span>${esc(d.ItemName)}<br><small class="muted">${esc(d.ItemCode)}</small></span><span class="q">${Number(d.Quantity) || 0}</span></div>`).join('');
    }).join('');
    out.innerHTML = html || '<p class="muted">Không có dữ liệu ghép hàng</p>';
  } catch (e) { out.innerHTML = errBox(e); }
}

// ---------- Vị trí DAS (location) ----------
async function lookupDas(dateStr, raw) {
  const code = cleanStoreCode(raw);
  if (!code || !dateStr) return;
  const [y, m, d] = dateStr.split('-');
  const out = $('#dasOut');
  out.innerHTML = loading;
  try {
    const j = await api('POST', '/pda/location', { StoreCode: code, Date: `${d}/${m}/${y}` });
    if (!Array.isArray(j)) throw new Error((j && j.message) || 'Phản hồi không đúng dạng danh sách');
    out.innerHTML = j.length ? j.map(r => {
      const loc = String(r.Location || ''), ses = String(r.Session || '');
      const line = loc.length === 6 ? loc.slice(0, 4) : loc, cell = loc.length === 6 ? loc.slice(4) : '';
      return `<div class="card">${j.length > 1 ? `<div class="meta">Phiên ${esc(ses.slice(-4))}</div>` : ''}
        <div class="name">Mã CH ${esc(code)}</div>
        <div>Line: <b>${esc(line)}</b> · Vị trí: <b>${esc(cell)}</b></div></div>`;
    }).join('') : '<p class="muted">Không có dữ liệu</p>';
  } catch (e) { out.innerHTML = errBox(e); }
}

// ---------- Cài đặt ----------
function loadSettings() {
  $('#adminBox').hidden = LOCKED;          // người dùng thường không thấy ô địa chỉ
  $('#setBase').value = S.base;
  $('#setEvery').value = String(S.every);
}
function saveSettings() {
  if (!LOCKED) { S.base = $('#setBase').value.trim() || PROXY_URL; store.set('base', S.base); }
  const ev = Number($('#setEvery').value);
  S.every = [0, 30, 60, 120].includes(ev) ? ev : 60;
  store.set('every', S.every);
  $('#setOut').textContent = 'Đã lưu.';
  renderStatus(); schedule(); refresh();
}
async function testConnection() {
  const out = $('#setOut');
  const saved = S.base;
  if (!LOCKED) S.base = $('#setBase').value.trim() || PROXY_URL;
  out.textContent = 'Đang thử…';
  const t0 = performance.now();
  try {
    const items = parseBulk(await api('GET', '/sftp/getAssortingPending'));
    out.textContent = `OK: ${items.length} mã hàng, ${Math.round(performance.now() - t0)} ms`;
  } catch (e) { out.textContent = 'Lỗi: ' + (e.message || e); }
  S.base = saved;
}

// ---------- Chuyển tab ----------
function showTab(t) {
  if (!ENABLED_TABS.includes(t)) { toast('Chức năng này tạm khoá'); return; }
  S.tab = t; store.set('tab', t);
  $$('.view').forEach(v => { v.hidden = v.id !== 'view-' + t; v.classList.toggle('on', !v.hidden); });
  $$('.rail-item').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  if (t === 'list' && (!S.updatedAt || (S.every > 0 && Date.now() - S.updatedAt > S.every * 1000))) refresh();
  if (t === 'move') renderEmp();
}

// ---------- Khởi động ----------
function init() {
  $$('.rail-item').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('#btnRefresh').addEventListener('click', refresh);
  $('#q').addEventListener('input', renderList);
  $('#sort').addEventListener('change', renderList);
  $('#list').addEventListener('click', e => { const c = e.target.closest('.card'); if (c) showDetail(c.dataset.code); });
  $('#dlgClose').addEventListener('click', () => $('#dlg').close());
  $('#formEmp').addEventListener('submit', e => { e.preventDefault(); doLoginEmp($('#empCode').value); });
  $('#btnSwitch').addEventListener('click', () => { setEmp(null); $('#moveOut').innerHTML = ''; $('#empOut').innerHTML = ''; });
  $('#formMove').addEventListener('submit', e => { e.preventDefault(); lookupItem($('#moveCode').value); });
  // Tự đăng xuất nhân viên nếu bỏ máy quá lâu, tránh người sau tra mã mà ghi nhầm tên người trước
  setInterval(() => { if (S.emp && Date.now() - S.emp.at > IDLE_MS) { setEmp(null); toast('Hết phiên, vui lòng quét lại thẻ nhân viên'); } }, 15000);
  $('#formStore').addEventListener('submit', e => { e.preventDefault(); lookupStore($('#storeCode').value); });
  $('#formDas').addEventListener('submit', e => { e.preventDefault(); lookupDas($('#dasDate').value, $('#dasStore').value); });
  $('#btnSave').addEventListener('click', saveSettings);
  $('#btnTest').addEventListener('click', testConnection);
  $('#btnReset').addEventListener('click', () => { $('#setBase').value = PROXY_URL; });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.tab === 'list' && (S.every > 0 || !S.updatedAt)) { refresh(); schedule(); }
  });

  const d = new Date();
  $('#dasDate').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const apiOverride = new URLSearchParams(location.search).get('api'); // chỉ để thử, không lưu
  if (apiOverride) S.base = apiOverride;
  loadSettings();

  const snap = store.get('snap', null);
  if (snap && Array.isArray(snap.items)) {
    S.items = snap.items; S.updatedAt = snap.at;
    if (Date.now() - snap.at < FRESH_MS) S.prevMap = new Map(snap.items.map(i => [i.code, i]));
  }
  renderList(); renderStatus();
  showTab(ENABLED_TABS.includes(S.tab) ? S.tab : 'list');
  if (S.tab !== 'list') refresh();
  schedule();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
