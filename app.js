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
const IDLE_MS = 10 * 60000;  // PDA dùng chung: quá thời gian này không chạm/quét gì thì tự đăng xuất
const ENABLED_TABS = ['list', 'move', 'set']; // Kiểm hàng, Ghép PAXD: tạm khoá

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
// Nhân viên đang thao tác được nhớ trên máy: thoát app rồi vào lại ngay vẫn còn đăng nhập.
// Hết phiên theo thời gian rảnh (IDLE_MS), không phải theo việc đóng app: quá hạn thì checkIdle() sẽ đăng xuất.
const sess = {
  get() { try { return JSON.parse(localStorage.getItem('emp')); } catch { return null; } },
  set(v) { try { v ? localStorage.setItem('emp', JSON.stringify(v)) : localStorage.removeItem('emp'); } catch {} },
};

const S = {
  emp: sess.get(),
  mode: store.get('inputMode', 'scan') === 'type' ? 'type' : 'scan', // scan = quét bằng PDA, type = nhập tay có gợi ý
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

// Mọi lệnh gọi đều kèm mã nhân viên đang đăng nhập; proxy kiểm tra và ghi log theo người đó
async function api(method, path, body, emp = S.emp && S.emp.id) {
  const base = baseOrThrow();
  try {
    return await request(signal => {
      if (isProxy(base)) return proxyFetch(base, { method, path, body: body || null, emp: emp || null }, signal);
      if (method === 'GET') return fetch(base + path, { signal });
      return fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal });
    });
  } catch (e) {
    // Proxy báo nhân viên không còn hợp lệ (vd bị xoá khỏi sheet): quay về màn hình đăng nhập
    if (/^NO_EMP/.test(e.message || '')) logout('invalid', 'Phiên không hợp lệ, vui lòng đăng nhập lại');
    throw e;
  }
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
  if (S.busy || !S.emp) return;
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

// ---------- Đăng nhập nhân viên (hỏi "ai đang làm việc" trước mọi chức năng) ----------
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 2600);
}

// Chưa đăng nhập: hiện màn hình đăng nhập phủ kín. Đã đăng nhập: hiện tên người làm ở thanh trên.
function renderEmp() {
  const e = S.emp;
  $('#login').hidden = !!e;
  $('#who').hidden = !e;
  $('.page').inert = !e;
  if (e) { $('#empName').textContent = e.name; $('#empId').textContent = 'Mã NV: ' + e.id; }
  const el = !e ? $('#empCode') : (S.tab === 'move' ? $('#moveCode') : null);
  if (el) el.focus();
}
function setEmp(e) { S.emp = e ? { ...e, at: Date.now() } : null; sess.set(S.emp); renderEmp(); }
// Chỉ thao tác của người (chạm, quét, gõ) mới tính là còn làm việc; tự tải ngầm thì không
function touchEmp() { if (S.emp) { S.emp.at = Date.now(); sess.set(S.emp); } }

// Thẻ nhân viên quét ra dạng "WK10600143": bỏ tiền tố WK để khớp cột Employee ID trong sheet
const cleanEmpId = s => String(s || '').trim().toUpperCase().replace(/^WK[\s\-_:]*(?=\d)/, '');

async function doLoginEmp(raw) {
  hideSugg();
  const id = cleanEmpId(raw);
  if (!id) return;
  const out = $('#empOut');
  out.innerHTML = loading;
  try {
    const r = await loginEmp(id);
    out.innerHTML = '';
    $('#moveOut').innerHTML = '';
    setEmp({ id: r.id, name: r.name });
    toast('Xin chào ' + r.name);
    restoreJob(); // có mã làm dở của chính người này (chưa quá 1 giờ) thì mở lại luôn
    refresh(); schedule();
  } catch (e) { out.innerHTML = errBox(e); }
  $('#empCode').value = '';
}

// Ghi nhận đăng xuất lên proxy (không chờ, không báo lỗi: lỡ mất mạng vẫn đăng xuất được trên máy)
function sendLogout(emp, reason) {
  try {
    const base = baseOrThrow();
    if (!isProxy(base) || reason === 'invalid') return;
    const note = reason === 'idle'
      ? `Hết phiên (không thao tác ${IDLE_MS / 60000} phút), hoạt động cuối ${hhmmss(emp.at)}`
      : 'Đăng xuất thủ công';
    fetch(base, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, keepalive: true,
      body: JSON.stringify({ action: 'logout', emp: emp.id, note }) }).catch(() => {});
  } catch { /* bỏ qua */ }
}

// reason: 'manual' (bấm Đổi người) | 'idle' (hết phiên) | 'invalid' (proxy không nhận mã này nữa)
function logout(reason, msg) {
  const e = S.emp;
  if (!e) return;
  sendLogout(e, reason);
  S.work = null; jobStore.clear();
  closeWork();
  setEmp(null);
  $('#moveOut').innerHTML = ''; $('#empOut').innerHTML = ''; $('#empCode').value = '';
  if (msg) toast(msg);
}
function checkIdle() {
  // Đang làm dở một mã: không tự đăng xuất theo thời gian rảnh (người ta đang đi chuyển hàng, không chạm máy).
  // Thay vào đó mã làm dở được giữ tối đa 1 giờ, quá hạn thì huỷ (có ghi log).
  if (S.work) {
    if (Date.now() - S.work.startedAt > WORK_TTL_MS) discardWork('timeout', 'Mã làm quá 1 giờ nên đã huỷ');
    return;
  }
  if (S.emp && Date.now() - S.emp.at > IDLE_MS) logout('idle', 'Hết phiên, vui lòng đăng nhập lại');
}

// ---------- Cách nhập: Quét (PDA) / Nhập tay có gợi ý ----------
function applyMode() {
  const scan = S.mode === 'scan';
  $$('.seg button').forEach(b => b.classList.toggle('on', b.dataset.mode === S.mode));
  // Chế độ quét: không bật bàn phím ảo, nút quét của PDA đẩy mã thẳng vào ô
  [$('#empCode'), $('#moveCode')].forEach(el => el.setAttribute('inputmode', scan ? 'none' : 'text'));
  $('#empCode').placeholder = scan ? 'Bấm nút quét, quét thẻ nhân viên' : 'Gõ tên hoặc mã nhân viên';
  $('#moveCode').placeholder = scan ? 'Bấm nút quét, quét mã hàng' : 'Gõ mã hoặc tên hàng';
  $('#empHint').textContent = scan
    ? 'Bấm nút quét của PDA rồi quét thẻ nhân viên đang đeo. Mọi thao tác sau đó được ghi lại theo tên bạn.'
    : 'Gõ vài chữ của tên hoặc mã, bấm vào gợi ý để chọn. Mọi thao tác sau đó được ghi lại theo tên bạn.';
  hideSugg();
  const el = !S.emp ? $('#empCode') : (S.tab === 'move' ? $('#moveCode') : null);
  if (el) { el.blur(); el.focus(); }
}

const hideSugg = () => ['#empSugg', '#itemSugg'].forEach(s => { $(s).hidden = true; $(s).innerHTML = ''; });

// Một dòng thông báo trong khung gợi ý (đang tìm / không có kết quả / lỗi)
function suggNote(box, msg) {
  box.innerHTML = `<div class="sg-note">${esc(msg)}</div>`;
  box.hidden = false;
  box.onclick = null;
}

// rows = [{ main, sub }]; pick(i) chạy khi bấm vào dòng thứ i
function showSugg(box, rows, pick) {
  box.innerHTML = rows.map((r, i) => `<button type="button" class="sg" data-i="${i}"><b>${esc(r.main)}</b><small>${esc(r.sub)}</small></button>`).join('');
  box.hidden = !rows.length;
  box.onclick = e => { const b = e.target.closest('.sg'); if (b) pick(Number(b.dataset.i)); };
}

// Gợi ý mã hàng: lấy từ danh sách hàng đang chờ (đã tải ở tab Hàng chờ)
function suggestItems() {
  if (S.mode !== 'type') return;
  const q = fold($('#moveCode').value.trim());
  if (q.length < 2) { $('#itemSugg').hidden = true; return; }
  const rows = S.items.filter(i => fold(i.code).includes(q) || fold(i.name).includes(q)).slice(0, 8);
  if (!rows.length) { suggNote($('#itemSugg'), S.items.length ? 'Không có mã hàng nào khớp trong danh sách đang chờ' : 'Chưa có danh sách hàng chờ để gợi ý'); return; }
  showSugg($('#itemSugg'), rows.map(i => ({ main: i.name, sub: i.code })), i => {
    hideSugg(); $('#moveCode').value = rows[i].code; lookupItem(rows[i].code);
  });
}

// Gợi ý nhân viên: hỏi proxy (đọc từ Google Sheet). Chậm tay 250ms để không gọi mỗi phím
let empSuggSeq = 0, empSuggTimer = null;
function suggestEmps() {
  clearTimeout(empSuggTimer);
  if (S.mode !== 'type') return;
  const q = $('#empCode').value.trim();
  if (q.length < 2) { $('#empSugg').hidden = true; return; }
  empSuggTimer = setTimeout(async () => {
    const seq = ++empSuggSeq;
    const box = $('#empSugg');
    try {
      const base = baseOrThrow();
      if (!isProxy(base)) { suggNote(box, 'Gợi ý tên chỉ có khi dùng proxy Apps Script.'); return; }
      suggNote(box, 'Đang tìm…');
      const rows = await request(signal => proxyFetch(base, { action: 'suggest', q }, signal));
      if (seq !== empSuggSeq) return; // đã có lần gõ mới hơn
      if (!Array.isArray(rows)) throw new Error('Proxy trả về sai dạng (chưa cập nhật bản mới?)');
      if (!rows.length) { suggNote(box, 'Không thấy nhân viên nào khớp'); return; }
      showSugg(box, rows.map(r => ({ main: r.name, sub: 'Mã NV: ' + r.id })), i => {
        hideSugg(); $('#empCode').value = rows[i].id; doLoginEmp(rows[i].id);
      });
    } catch (e) {
      // Hiện rõ lý do (sai SHEET_ID, proxy chưa cập nhật, mất mạng...) thay vì im lặng; vẫn quét/nhập mã bình thường được
      if (seq === empSuggSeq) suggNote(box, 'Không tải được gợi ý: ' + (e.message || e));
    }
  }, 250);
}

// ---------- Điều hàng (itemPending) ----------
let lookupBusy = false; // máy quét đôi khi gửi Enter hai lần: chỉ nhận một lần tra tại một thời điểm (tránh sinh hai dòng log)
const newJobId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

async function lookupItem(raw) {
  hideSugg();
  const code = raw.trim();
  if (!code || lookupBusy) return;
  if (!S.emp) { renderEmp(); return; }
  lookupBusy = true;
  const out = $('#moveOut');
  out.innerHTML = loading;
  S.work = null;
  try {
    const j = await api('POST', '/pda/itemPending', { ItemCode: code });
    if (!j || !Array.isArray(j.Details)) throw new Error('Không tìm thấy mã hàng');
    const q = LINES.map(() => 0);
    for (const d of j.Details) {
      const k = LINES.indexOf(String(d.Line || '').replace('-', ''));
      if (k >= 0) q[k] = Number(d.Quantity) || 0;
    }
    // Mã phiên do proxy tạo (Họ tên_Mã hàng_giờ bắt đầu) và trả về trong __job; proxy cũ/chạy thẳng thì dùng mã dự phòng
    const job = (j.__job && j.__job.id) || newJobId();
    S.work = { emp: S.emp.id, job, code, name: j.ItemName || 'Không rõ tên', q, startedAt: Date.now(), done: new Set(), sending: false };
    out.innerHTML = '';
    jobStore.save();
    renderWork();
  } catch (e) {
    out.innerHTML = errBox(e);
  } finally {
    lookupBusy = false;
  }
  $('#moveCode').value = ''; if (S.emp) $('#moveCode').focus();
}

// ---------- Làm việc với một mã hàng: màn hình riêng phủ kín, KHOÁ cho tới khi bấm Hoàn thành ----------
// Quét mã -> mở màn hình này. Chạm line đã xong để chốt (chốt rồi thì không chạm bỏ được, phải giữ ô).
// Chỉ "Hoàn thành" mới đóng màn hình. Lối thoát duy nhất khác là giữ nút "Huỷ mã" (để khỏi kẹt khi quét nhầm mã).
const WORK_TTL_MS = 60 * 60000; // mã làm dở được giữ trên máy tối đa 1 giờ (kể cả lỡ thoát app); quá hạn thì huỷ
const HOLD_UNDO_MS = 1500;      // phải giữ ô đã chốt chừng này mới bỏ chọn được
const HOLD_CANCEL_MS = 2000;    // phải giữ nút Huỷ mã chừng này mới huỷ

const todoOf = w => w.q.map((v, k) => v > 0 ? k : -1).filter(k => k >= 0); // chỉ line còn hàng mới chạm được
const snap = w => ({ emp: w.emp, job: w.job, code: w.code, name: w.name, q: w.q, startedAt: w.startedAt, done: [...w.done] });

// Lưu mã đang làm dở lên máy: lỡ đóng app/tắt máy thì đăng nhập lại là làm tiếp, không phải quét lại mã
const jobStore = {
  save() { if (S.work) store.set('job', snap(S.work)); },
  load() { return store.get('job', null); },
  clear() { try { localStorage.removeItem('job'); } catch { /* bỏ qua */ } },
};

let skipPop = false; // bỏ qua popstate do chính mình gọi history.back()
function openWork() {
  $('#workScreen').hidden = false;
  $('.page').inert = true; // chặn mọi thao tác phía sau (ô nhập, tab, đổi người)
  try { history.pushState({ work: 1 }, ''); } catch { /* bỏ qua */ }
}
function closeWork() {
  const ws = $('#workScreen');
  if (ws.hidden) return;
  ws.hidden = true;
  cancelHold();
  $('.page').inert = !S.emp;
  if (history.state && history.state.work) { skipPop = true; try { history.back(); } catch { skipPop = false; } }
}

// Báo proxy mã bị huỷ / quá hạn (không chờ, không báo lỗi). job = snap(...) hoặc bản đã lưu trên máy.
function sendCancel(job, reason) {
  try {
    const base = baseOrThrow();
    if (!isProxy(base)) return;
    const all = todoOf(job), dn = new Set(job.done);
    const pick = ks => ks.map(k => ({ l: LINES[k], q: job.q[k] }));
    fetch(base, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, keepalive: true,
      body: JSON.stringify({ action: 'complete', cancel: true, reason, emp: job.emp, job: job.job, itemCode: job.code, itemName: job.name,
        startedAt: job.startedAt, endedAt: Date.now(), done: pick(all.filter(k => dn.has(k))), rest: pick(all.filter(k => !dn.has(k))) }) }).catch(() => {});
  } catch { /* bỏ qua */ }
}

// Bỏ mã đang làm dở (giữ nút Huỷ mã, hoặc quá 1 giờ). Có ghi log để biết mã nào bị huỷ.
function discardWork(reason, msg) {
  const w = S.work;
  if (w) sendCancel(snap(w), reason);
  S.work = null; jobStore.clear(); closeWork();
  if (msg) toast(msg);
  if (S.emp) $('#moveCode').focus();
}

// Mở lại mã làm dở sau khi đăng nhập (hoặc mở lại app). Chỉ đúng người đó, và chưa quá 1 giờ.
function restoreJob() {
  const j = jobStore.load();
  if (!j || !S.emp || S.work) return;
  if (Date.now() - j.startedAt > WORK_TTL_MS) { sendCancel(j, 'timeout'); jobStore.clear(); toast(`Mã ${j.code} làm dở quá 1 giờ nên đã huỷ`); return; }
  if (j.emp !== S.emp.id) { sendCancel(j, 'other'); jobStore.clear(); return; } // người khác dùng máy: bỏ việc dở của người trước
  S.work = { emp: j.emp, job: j.job, code: j.code, name: j.name, q: j.q, startedAt: j.startedAt, done: new Set(j.done), sending: false };
  renderWork();
  toast('Tiếp tục mã đang làm dở');
}

function renderWork() {
  const w = S.work;
  if (!w) return;
  const todo = todoOf(w);
  if (!todo.length) {
    $('#moveOut').innerHTML = `<div class="card"><div class="name">${esc(w.name)}</div><div class="meta">${esc(w.code)}</div>
      <p class="muted">Mã này hiện không còn hàng chờ ở line nào.</p></div>`;
    S.work = null; jobStore.clear();
    return;
  }
  const zone = (title, cls, from) => {
    const ks = todo.filter(k => k >= from && k < from + 7);
    if (!ks.length) return '';
    return `<div class="ws-zone ${cls}"><span>${title}</span><span>${sum(ks.map(k => w.q[k]))}</span></div>
      <div class="ws-grid">${ks.map(k => `<button type="button" class="ws-cell ${cls}" data-k="${k}" aria-pressed="false"><small>${LINES[k]}</small><b>${w.q[k]}</b></button>`).join('')}</div>`;
  };
  $('#wsBody').innerHTML = `<div class="ws-name">${esc(w.name)}</div>
    <div class="ws-meta">${esc(w.code)} · Tổng ${sum(w.q)}</div>
    ${zone('KHU A', 'zA', 0)}${zone('KHU B', 'zB', 7)}
    <p class="hint" style="margin-top:16px">Chạm từng line đã làm xong để chốt. <b>Phải chốt đủ tất cả các line</b> thì mới bấm được Hoàn thành.
      Chốt nhầm muốn bỏ thì <b>giữ ô 1,5 giây</b>. Quét nhầm mã thì giữ nút <b>Huỷ mã</b> 2 giây.</p>`;
  $('#wsBody').scrollTop = 0;
  updateWorkUI();
  openWork();
}

// Cập nhật tại chỗ (không vẽ lại cả màn hình) để không bị nhảy cuộn khi chạm
function updateWorkUI() {
  const w = S.work;
  if (!w) return;
  $$('#wsBody .ws-cell').forEach(c => {
    const on = w.done.has(Number(c.dataset.k));
    c.classList.toggle('done', on);
    c.setAttribute('aria-pressed', on);
  });
  const n = todoOf(w).length;
  const bd = $('#btnDone');
  bd.disabled = w.done.size !== n || w.sending; // bắt buộc chốt đủ MỌI line mới hoàn thành được
  bd.textContent = w.sending ? 'Đang ghi…' : `Hoàn thành (${w.done.size}/${n})`;
  $('#btnAll').disabled = w.sending || w.done.size === n;
}

function tapLine(k) {
  const w = S.work;
  if (!w || w.sending || !(w.q[k] > 0)) return;
  if (w.done.has(k)) { toast('Đã chốt rồi. Muốn bỏ chọn thì giữ ô 1,5 giây'); return; } // chạm thường không bỏ được
  w.done.add(k); jobStore.save(); updateWorkUI();
}
function undoLine(k) {
  const w = S.work;
  if (!w || w.sending || !w.done.has(k)) return;
  w.done.delete(k); jobStore.save(); updateWorkUI();
  toast('Đã bỏ chọn ' + LINES[k]);
  try { navigator.vibrate && navigator.vibrate(40); } catch { /* bỏ qua */ }
}
function selectAllLines() {
  const w = S.work;
  if (!w || w.sending) return;
  todoOf(w).forEach(k => w.done.add(k)); // chỉ thêm, không bỏ (muốn bỏ phải giữ từng ô)
  jobStore.save(); updateWorkUI();
}

// Giữ lâu mới có tác dụng (bỏ chọn một ô / huỷ mã): hiện thanh tô dần để người dùng biết đang giữ
let hold = null, suppressClickUntil = 0;
function startHold(ms, fire, el) {
  cancelHold();
  el.style.setProperty('--hold', ms + 'ms');
  el.classList.add('holding');
  hold = { el, t: setTimeout(() => {
    hold = null; el.classList.remove('holding');
    suppressClickUntil = Date.now() + 350; // nhả tay ra sẽ sinh thêm một cú click, bỏ qua nó
    fire();
  }, ms) };
}
function cancelHold() {
  if (!hold) return;
  clearTimeout(hold.t); hold.el.classList.remove('holding'); hold = null;
}

async function completeWork() {
  const w = S.work;
  if (!w || w.sending || w.done.size !== todoOf(w).length) return; // chưa chốt đủ line thì không cho hoàn thành
  const endedAt = Date.now();
  const pick = ks => ks.map(k => ({ l: LINES[k], q: w.q[k] }));
  const all = todoOf(w);
  const doneKs = all.filter(k => w.done.has(k)), restKs = all.filter(k => !w.done.has(k));
  w.sending = true; updateWorkUI();
  try {
    const base = baseOrThrow();
    if (isProxy(base)) {
      await request(signal => proxyFetch(base, { action: 'complete', emp: S.emp.id, job: w.job, itemCode: w.code, itemName: w.name,
        startedAt: w.startedAt, endedAt, done: pick(doneKs), rest: pick(restKs) }, signal));
    }
    $('#moveOut').innerHTML = `<div class="card done-box"><div class="name">✓ Đã ghi hoàn thành</div>
      <div class="meta">${esc(w.name)} · ${esc(w.code)}</div>
      <div class="totals"><span>${doneKs.length}/${all.length} line</span></div>
      ${isProxy(base) ? '' : '<p class="hint">Chế độ thử (không có proxy): chưa ghi vào sổ nhật ký.</p>'}</div>`;
    S.work = null; jobStore.clear();
    closeWork();
    $('#moveCode').focus();
  } catch (e) {
    // Lỗi mạng/proxy: giữ nguyên các line đã chốt để bấm lại, không mất công
    w.sending = false;
    if (/^NO_EMP/.test(e.message || '')) { logout('invalid', 'Phiên không hợp lệ, vui lòng đăng nhập lại'); return; }
    updateWorkUI();
    toast('Chưa ghi được: ' + (e.message || e));
  }
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
  if (t === 'move') {
    renderEmp();
    // Gợi ý mã hàng cần danh sách hàng chờ: tải nếu chưa có hoặc đã cũ
    if (!S.items.length || !S.updatedAt || Date.now() - S.updatedAt > 120000) refresh();
  }
}

// ---------- Tự cập nhật khi bạn đẩy bản mới lên GitHub ----------
// App mở sẵn cả ngày vẫn chạy bản cũ nếu không tải lại. App định kỳ hỏi GitHub nội dung các file chính, thấy khác
// bản đang chạy thì tự tải lại, nhưng CHỈ khi không làm gián đoạn ai: không tải lại lúc đang làm một mã (màn hình khoá).
const APP_FILES = ['index.html', 'app.js', 'style.css'];
let baseFp = null, updateReady = false;

async function fingerprint() {
  const parts = await Promise.all(APP_FILES.map(f => fetch(f, { cache: 'no-store' }).then(r => r.ok ? r.text() : '')));
  const s = parts.join('\u0000');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h + ':' + s.length;
}
async function checkNewVersion() {
  try {
    const fp = await fingerprint();
    if (baseFp === null) { baseFp = fp; return; }      // lần đầu: ghi nhận bản đang chạy làm mốc
    if (fp !== baseFp) { updateReady = true; maybeReload(); }
  } catch { /* mất mạng: thử lại lần sau */ }
}
function maybeReload() {
  if (!updateReady || S.work || !$('#workScreen').hidden || S.busy) return;
  updateReady = false;
  location.reload();
}
function setupAutoUpdate() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (location.protocol === 'file:') return;
  checkNewVersion();                                                   // ghi mốc ngay khi mở
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkNewVersion(); maybeReload(); } });
  setInterval(checkNewVersion, 10 * 60000);                            // và định kỳ 10 phút
  setInterval(maybeReload, 20000);                                     // đang bận (làm mã dở) thì thử lại, xong việc là cập nhật
}
// ---------- Khởi động ----------
function init() {
  $$('.rail-item').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('#btnRefresh').addEventListener('click', refresh);
  $('#q').addEventListener('input', renderList);
  $('#sort').addEventListener('change', renderList);
  $('#list').addEventListener('click', e => { const c = e.target.closest('.card'); if (c) showDetail(c.dataset.code); });
  $('#dlgClose').addEventListener('click', () => $('#dlg').close());
  $$('.seg button').forEach(b => b.addEventListener('click', () => { S.mode = b.dataset.mode; store.set('inputMode', S.mode); applyMode(); }));
  $('#empCode').addEventListener('input', suggestEmps);
  $('#moveCode').addEventListener('input', suggestItems);
  document.addEventListener('click', e => { if (!e.target.closest('.sugg, #empCode, #moveCode')) hideSugg(); });
  $('#formEmp').addEventListener('submit', e => { e.preventDefault(); doLoginEmp($('#empCode').value); });
  $('#btnSwitch').addEventListener('click', () => logout('manual'));
  $('#formMove').addEventListener('submit', e => { e.preventDefault(); lookupItem($('#moveCode').value); });
  const ws = $('#workScreen');
  ws.addEventListener('click', e => {
    if (Date.now() < suppressClickUntil) return; // cú click sinh ra khi nhả tay sau khi giữ
    const cell = e.target.closest('.ws-cell');
    if (cell) return tapLine(Number(cell.dataset.k));
    if (e.target.closest('#btnAll')) return selectAllLines();
    if (e.target.closest('#btnDone')) return completeWork();
    if (e.target.closest('#wsCancel')) toast('Muốn huỷ mã này thì giữ nút 2 giây');
  });
  // Giữ ô đã chốt 1,5 giây để bỏ chọn; giữ nút Huỷ mã 2 giây để huỷ. Thả sớm/cuộn là thôi.
  ws.addEventListener('pointerdown', e => {
    if (!S.work || S.work.sending) return;
    const cell = e.target.closest('.ws-cell.done');
    if (cell) return startHold(HOLD_UNDO_MS, () => undoLine(Number(cell.dataset.k)), cell);
    const x = e.target.closest('#wsCancel');
    if (x) startHold(HOLD_CANCEL_MS, () => discardWork('cancel', 'Đã huỷ mã này'), x);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => ws.addEventListener(ev, cancelHold, true));
  ws.addEventListener('contextmenu', e => e.preventDefault()); // chặn menu hiện ra khi giữ lâu
  // Nút Back của PDA/điện thoại KHÔNG thoát được màn hình làm việc (chỉ Hoàn thành mới thoát)
  window.addEventListener('popstate', () => {
    if (skipPop) { skipPop = false; return; }
    if (!ws.hidden) { try { history.pushState({ work: 1 }, ''); } catch { /* bỏ qua */ } toast('Làm xong thì bấm Hoàn thành để thoát'); }
  });
  // PDA dùng chung: bỏ máy quá lâu thì tự đăng xuất, tránh người sau thao tác mà ghi nhầm tên người trước.
  // Chạm màn hình hoặc quét/gõ phím đều tính là còn làm việc (tự tải ngầm thì không).
  ['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, touchEmp, true));
  setInterval(checkIdle, 15000);
  $('#formStore').addEventListener('submit', e => { e.preventDefault(); lookupStore($('#storeCode').value); });
  $('#formDas').addEventListener('submit', e => { e.preventDefault(); lookupDas($('#dasDate').value, $('#dasStore').value); });
  $('#btnSave').addEventListener('click', saveSettings);
  $('#btnTest').addEventListener('click', testConnection);
  $('#btnReset').addEventListener('click', () => { $('#setBase').value = PROXY_URL; });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    checkIdle(); // máy ngủ/tắt màn hình rồi bật lại: kiểm tra hết phiên ngay
    if (S.tab === 'list' && (S.every > 0 || !S.updatedAt)) { refresh(); schedule(); }
  });

  const d = new Date();
  $('#dasDate').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const apiOverride = new URLSearchParams(location.search).get('api'); // chỉ để thử, không lưu
  if (apiOverride) S.base = apiOverride;
  loadSettings();
  applyMode();

  const snap = store.get('snap', null);
  if (snap && Array.isArray(snap.items)) {
    S.items = snap.items; S.updatedAt = snap.at;
    if (Date.now() - snap.at < FRESH_MS) S.prevMap = new Map(snap.items.map(i => [i.code, i]));
  }
  renderList(); renderStatus();
  renderEmp();      // chưa đăng nhập: hiện màn hình đăng nhập
  restoreJob();     // lỡ tải lại trang giữa chừng: mở lại mã đang làm dở (phải chạy TRƯỚC checkIdle)
  checkIdle();      // phiên cũ quá hạn thì đăng xuất (và ghi log); đang có mã làm dở thì không đăng xuất
  showTab(ENABLED_TABS.includes(S.tab) ? S.tab : 'list');
  if (S.tab !== 'list') refresh();
  schedule();

  setupAutoUpdate();
}
init();
