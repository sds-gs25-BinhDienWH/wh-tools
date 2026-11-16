'use strict';
// Chức năng "Kiểm đông" của WH Tool: kiểm hàng đông theo PO của từng cửa hàng bằng cách quét sản phẩm.
// Tự đóng gói trong IIFE để không đụng biến của app.js. app.js gọi FZ.show() khi mở tab.
// Dữ liệu PO tạm lấy từ frozen-data.json (tạo bằng tools/make-frozen-data.py từ file Excel PO).
const FZ = (() => {
  const g = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const fold = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
  const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  const S = { data: null, loading: false, po: null, filter: 'todo', last: null, pending: null, kbd: false, bound: false };
  // Tiến độ lưu theo PO trên máy: {counts:{mã:số đã quét}, done:bool}. Mã ngoài PO cũng được đếm (coi là thừa).
  const key = po => 'frozen:' + S.data.date + ':' + po;
  const prog = po => load(key(po), { counts: {}, done: false });
  const norm = c => String(c).replace(/\s+/g, '').replace(/^0+(?=\d)/, '');
  const visible = () => !g('view-frozen').hidden;

  function beep(ok) {
    try {
      navigator.vibrate && navigator.vibrate(ok ? 40 : [80, 60, 80]);
      const a = new (window.AudioContext || window.webkitAudioContext)(), o = a.createOscillator(), v = a.createGain();
      o.frequency.value = ok ? 1000 : 300; v.gain.value = .15; o.connect(v); v.connect(a.destination); o.start(); o.stop(a.currentTime + (ok ? .08 : .3));
    } catch {}
  }

  // Nguồn dữ liệu: Google Sheet (nhân viên dán sheet Detail của file Allocation vào tab Detail Data hàng ngày; tab Store có STORE ID, STORE NAME).
  // Hai link dưới là link "Xuất bản lên web" dạng CSV. Sheet trống hoặc lỗi thì dùng tạm frozen-data.json.
  const SHEET = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTep-iGhHUh0oyxUZZQj8Z_UoEH5ZdS_y3HnLVGiTXUBaWflEliVaTUWo9C9poXatzwZ9I4wV5hdeTi/pub';
  const DETAIL_URL = SHEET + '?gid=0&single=true&output=csv', STORE_URL = SHEET + '?gid=99054321&single=true&output=csv';

  function parseCSV(t) {
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
      else if (c !== '\r') f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows;
  }
  const getCSV = async url => { const r = await fetch(url + '&t=' + Date.now(), { cache: 'no-store' }); if (!r.ok) throw new Error(r.status); return parseCSV(await r.text()); };

  async function fromSheet() {
    const [det, sto] = await Promise.all([getCSV(DETAIL_URL), getCSV(STORE_URL).catch(() => [])]);
    const head = (det[0] || []).map(h => h.trim().toLowerCase());
    const col = n => head.indexOf(n);
    const cCode = col('item code'), cDo = col('do no.'), cName = col('item name'), cAlloc = col('allocation qty.');
    if (cCode < 0 || cDo < 0 || cAlloc < 0) throw new Error('Sheet Detail Data thiếu cột Item Code / DO No. / Allocation Qty.');
    const names = new Map();
    sto.slice(1).forEach(r => { const id = (r[0] || '').trim().toUpperCase(); if (id) names.set(id, (r[1] || '').trim().replace(new RegExp('^' + id + '\\s*', 'i'), '')); });
    const pos = new Map(), dates = {};
    for (const r of det.slice(1)) {
      const code = (r[cCode] || '').trim(), dn = (r[cDo] || '').trim();
      if (!code || !dn) continue;
      const qty = parseInt(String(r[cAlloc] || '').replace(/[^\d-]/g, ''), 10) || 0;
      const m = dn.replace(/WH34$/i, '').match(/(\d\d)(\d\d)(\d\d)$/);
      if (m) { const d = m[3] + '/' + m[2] + '/20' + m[1]; dates[d] = (dates[d] || 0) + 1; }
      if (qty <= 0) continue; // không có allocation = không có tồn: bỏ
      let p = pos.get(dn);
      if (!p) {
        const sm = dn.match(/^VN(\d{4})/); if (!sm) continue;
        const num = sm[1] === '9997' ? dn.slice(6, 10) : sm[1];
        p = { po: dn, store: 'VN' + sm[1], num, storeName: names.get('VN' + num) || '', items: [] }; pos.set(dn, p);
      }
      const ex = p.items.find(i => norm(i[0]) === norm(code));
      if (ex) ex[2] += qty; else p.items.push([code, (r[cName] || '').trim(), qty]);
    }
    if (!pos.size) throw new Error('EMPTY');
    const date = Object.keys(dates).sort((a, b) => dates[b] - dates[a])[0] || '';
    return { date, source: 'Google Sheet', pos: [...pos.values()].sort((a, b) => a.num < b.num ? -1 : a.num > b.num ? 1 : 0) };
  }
  async function fromFile() {
    const r = await fetch('frozen-data.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    const d = await r.json(); d.source = 'Dự phòng (Sheet chưa có dữ liệu)'; return d;
  }

  // force = tải lại từ Sheet (giữ dữ liệu cũ nếu lần tải này lỗi)
  async function ensureData(force) {
    if (S.loading || (S.data && !force)) return;
    S.loading = true;
    if (!S.data) g('fzPos').innerHTML = '<p>Đang tải danh sách cửa hàng…</p>';
    else g('fzRefresh').textContent = 'Đang cập nhật…';
    try {
      let d;
      try { d = await fromSheet(); }
      catch (e) { if (S.data) { S.data.err = e.message === 'EMPTY' ? 'Sheet đang trống' : e.message; d = null; } else { d = await fromFile(); d.err = e.message; } }
      if (d) { d.at = Date.now(); d.pos.forEach(p => { p.map = new Map(p.items.map(i => [norm(i[0]), i])); p.total = p.items.reduce((a, i) => a + i[2], 0); }); S.data = d; }
    } catch (e) { if (!S.data) g('fzPos').innerHTML = '<p>Không tải được dữ liệu (' + esc(e.message) + ').</p>'; }
    S.loading = false; g('fzRefresh').textContent = '↻ Cập nhật';
    if (S.data && !S.po) showList();
  }

  function show() {
    bind();
    if (!S.data) { ensureData(); return; }
    if (S.po) focusScan(); else { if (Date.now() - (S.data.at || 0) > 120000) ensureData(true); g('fzQ').focus(); } // vào lại tab sau > 2 phút thì tự lấy dữ liệu mới (không làm khi đang trong một PO)
  }

  function status(p) {
    const c = prog(p.po).counts, pr = prog(p.po);
    let got = 0, diff = false, any = false;
    for (const k of Object.keys(c)) { any = true; if (!p.map.has(k)) diff = true; }
    for (const it of p.items) { const n = c[norm(it[0])] || 0; if (n > 0) got++; if (n !== it[2]) diff = true; }
    return { got, any, diff, done: pr.done };
  }

  // ---------- Danh sách PO ----------
  function showList() {
    S.po = null; S.pending = null; g('fzList').hidden = false; g('fzCheck').hidden = true;
    renderList(); focusQ();
  }
  // Khớp theo số cửa hàng (bỏ chữ VN): đầu số trước (005 -> 0052, 0053), rồi tới chứa số, rồi tới tên
  function match(raw) {
    const q = fold(raw.trim()).replace(/^vn/, '').replace(/\s+/g, '');
    if (!q) return [];
    const sc = p => p.num === q ? 0 : p.num.startsWith(q) ? 1 : p.num.includes(q) ? 2 : fold(p.storeName + ' ' + p.po).includes(q) ? 3 : 9;
    return S.data.pos.map(p => [sc(p), p]).filter(x => x[0] < 9).sort((a, b) => a[0] - b[0] || (a[1].num < b[1].num ? -1 : 1)).map(x => x[1]);
  }
  const cat = p => { const s = status(p); return s.done ? 'done' : s.any ? 'wip' : 'todo'; };
  function renderList() {
    const qv = g('fzQ').value.trim(), total = S.data.pos.length;
    const n = { done: 0, wip: 0, todo: 0 }; S.data.pos.forEach(p => n[cat(p)]++);
    const t = new Date(S.data.at || Date.now()), pad = x => String(x).padStart(2, '0');
    g('fzMeta').textContent = 'Đơn ngày ' + S.data.date + ' · Nguồn: ' + S.data.source + ' · cập nhật ' + pad(t.getHours()) + ':' + pad(t.getMinutes()) + (S.data.err && S.data.err !== 'EMPTY' ? ' (' + S.data.err + ')' : '');
    // Ngày trong mã DO là ngày ĐẶT hàng, thường kiểm sau 1-2 ngày nên chỉ cảnh báo khi dữ liệu cũ hơn 3 ngày
    const dp = String(S.data.date || '').split('/'), age = dp.length === 3 ? Math.floor((Date.now() - new Date(+dp[2], dp[1] - 1, +dp[0]).getTime()) / 86400000) : 0;
    const w = g('fzWarn'); w.hidden = !(age > 3);
    w.textContent = '⚠ Dữ liệu là đơn ngày ' + S.data.date + ' (cách đây ' + age + ' ngày). Kiểm tra Sheet đã dán dữ liệu mới chưa, rồi bấm Cập nhật.';
  }

  // ---------- Kiểm một PO ----------
  function openPO(po) {
    S.po = S.data.pos.find(p => p.po === po); S.last = null; S.pending = null;
    g('fzList').hidden = true; g('fzCheck').hidden = false; g('fzLast').hidden = true;
    g('fzTitle').innerHTML = 'VN' + esc(S.po.num) + ' · ' + esc(S.po.storeName) + '<small>' + esc(S.po.po) + '</small>';
    render(); focusScan();
  }
  function focusQ() { const i = g('fzQ'); i.value = ''; S.cat = null; renderList(); setTimeout(() => i.focus(), 30); }
  function focusScan() { const i = g('fzScan'); i.value = ''; i.focus(); }

  const state = (it, n) => n === it[2] ? 'ok' : n > it[2] ? 'bad' : n > 0 ? 'wip' : '';
  // Quét MÃ HÀNG (không quét từng cái): quét một lần là xác nhận mã đó đúng bằng số lượng trong PO. Số lượng chỉ để tham khảo.
  function render() {
    const p = S.po, c = prog(p.po).counts;
    let codes = 0, got = 0; p.items.forEach(it => { const n = c[norm(it[0])] || 0; if (n > 0) codes++; got += Math.min(n, it[2]); });
    const pct = p.items.length ? Math.round(codes * 100 / p.items.length) : 0;
    g('fzDone').hidden = !prog(p.po).done;
    g('fzProg').innerHTML = 'Đã kiểm <b>' + codes + '</b> / ' + p.items.length + ' mã<div class="fz-bar"><i style="width:' + pct + '%"></i></div>';
  }

  function setCount(k, n) {
    const pr = prog(S.po.po); n = Math.max(0, n);
    if (n) pr.counts[k] = n; else delete pr.counts[k];
    if (pr.marks) delete pr.marks[k]; // quét/sửa lại thì bỏ đánh dấu nguyên hộp/thiếu
    pr.done = false; save(key(S.po.po), pr);
  }
  // Quét một mã -> hiện số lượng PO + chờ xác nhận. Chưa xác nhận (hoặc nhập số khác) thì chưa được quét mã khác.
  function showLast(k, again, warn) {
    const it = S.po.map.get(k), n = prog(S.po.po).counts[k] || 0, box = g('fzLast');
    const known = !!it, need = known ? it[2] : 0, pend = S.pending === k;
    const st = pend ? 'ask' : !known ? 'bad' : state(it, n);
    const msg = pend ? (known ? 'Xác nhận số lượng: ' + need + '?' : 'MÃ NGOÀI PO — không có trong đơn này')
      : !known ? 'MÃ NGOÀI PO — đã ghi nhận ' + n
      : n === need ? 'ĐÃ XÁC NHẬN SỐ LƯỢNG: ' + need + ' ✓'
      : 'ĐÃ GHI NHẬN ' + n + ' (PO ' + need + ')';
    const btns = pend
      ? (known ? '<button type="button" class="fz-ok" data-d="ok">XÁC NHẬN ' + need + '</button><button type="button" class="ghost" data-d="set">Số lượng khác</button>'
               : '<button type="button" class="ghost" data-d="set">Nhập số lượng</button><button type="button" class="ghost" data-d="skip">Bỏ qua</button>')
      : '<button type="button" class="ghost" data-d="set">Số lượng khác</button><button type="button" class="ghost" data-d="del">Bỏ quét mã này</button>';
    box.className = 'fz-last ' + st; box.hidden = false;
    box.innerHTML = (warn ? '<div class="warn">⚠ Xác nhận mã này xong mới quét được mã khác</div>' : '') +
      '<div class="nm">' + esc(known ? it[1] : 'Mã ' + k) + '</div><div class="code">' + esc(known ? it[0] : k) + (again ? ' · mã này đã xác nhận rồi' : '') + '</div>' +
      '<div class="big"><span>SL PO</span><b>' + need + '</b></div><div class="msg">' + esc(msg) + '</div><div class="adj">' + btns + '</div>';
    S.last = k;
  }

  // ---------- Hộp thoại ----------
  function dialog(html, acts) {
    g('fzDlgBody').innerHTML = html; const a = g('fzDlgAct'); a.innerHTML = '';
    acts.forEach(([t, cls, fn]) => { const b = document.createElement('button'); b.textContent = t; if (cls) b.className = cls; b.onclick = () => { g('fzDlg').close(); fn && fn(); }; a.appendChild(b); });
    g('fzDlg').showModal();
  }
  // Kết thúc: mã nào chưa quét thì hỏi "nguyên hộp" (barcode thùng khác barcode sản phẩm, nên không quét được -> tính đủ SL PO) hay "thiếu".
  function finish() {
    S.pending = null; g('fzLast').hidden = true; resolveStep();
  }
  function resolveStep() {
    const p = S.po, pr = prog(p.po), c = pr.counts, m = pr.marks || {};
    const rows = p.items.filter(it => !(c[norm(it[0])] > 0) || m[norm(it[0])] === 'case');
    if (!rows.length) { summary(); return; }
    const undecided = rows.filter(it => !m[norm(it[0])]).length;
    g('fzDlgBody').innerHTML = '<h3 style="margin:0">Còn ' + rows.length + ' mã chưa quét</h3><div class="fz-hint">Mỗi mã: là <b>nguyên hộp</b> (tính đủ SL PO) hay <b>thiếu</b>?</div><div class="fz-dlist fz-res">' +
      rows.map(it => { const k = norm(it[0]), v = m[k]; return '<div class="fz-resrow"><div class="nm">' + esc(it[1]) + '<small>' + esc(it[0]) + ' · SL PO ' + it[2] + '</small></div>' +
        '<button type="button" data-k="' + esc(k) + '" data-v="case" class="' + (v === 'case' ? 'on-case' : 'ghost') + '">Nguyên hộp</button>' +
        '<button type="button" data-k="' + esc(k) + '" data-v="short" class="' + (v === 'short' ? 'on-short' : 'ghost') + '">Thiếu</button></div>'; }).join('') + '</div>';
    g('fzDlgBody').onclick = e => {
      const b = e.target.closest('button[data-k]'); if (!b) return;
      const q = prog(p.po); q.marks = q.marks || {}; const it = p.map.get(b.dataset.k);
      if (b.dataset.v === 'case') q.counts[b.dataset.k] = it[2]; else delete q.counts[b.dataset.k];
      q.marks[b.dataset.k] = b.dataset.v; q.done = false; save(key(p.po), q);
      const sc = g('fzDlgBody').querySelector('.fz-dlist').scrollTop; resolveStep(); g('fzDlgBody').querySelector('.fz-dlist').scrollTop = sc; render();
    };
    const a = g('fzDlgAct'); a.innerHTML = '';
    const add = (t, cls, fn, dis) => { const b = document.createElement('button'); b.textContent = t; if (cls) b.className = cls; b.disabled = !!dis; b.onclick = fn; a.appendChild(b); };
    add('Kiểm tiếp', 'ghost', () => g('fzDlg').close());
    add('Tất cả nguyên hộp', 'ghost', () => { const q = prog(p.po); q.marks = q.marks || {}; rows.forEach(it => { const k = norm(it[0]); if (!q.marks[k]) { q.counts[k] = it[2]; q.marks[k] = 'case'; } }); save(key(p.po), q); resolveStep(); render(); });
    add(undecided ? 'Còn ' + undecided + ' mã chưa chọn' : 'Tiếp tục', '', () => summary(), undecided);
    if (!g('fzDlg').open) g('fzDlg').showModal();
  }
  function summary() {
    const p = S.po, pr = prog(p.po), c = pr.counts, m = pr.marks || {}, lack = [], over = [], box = [];
    p.items.forEach(it => {
      const k = norm(it[0]), n = c[k] || 0;
      if (m[k] === 'case') box.push(it[1] + ' — ' + it[2]);
      else if (n === 0) lack.push(it[1] + ' — thiếu hoàn toàn (PO ' + it[2] + ')');
      else if (n < it[2]) lack.push(it[1] + ' — ghi nhận ' + n + ', PO ' + it[2]);
      else if (n > it[2]) over.push(it[1] + ' — thừa ' + (n - it[2]));
    });
    Object.keys(c).filter(k => !p.map.has(k)).forEach(k => over.push('Mã ngoài PO ' + k + ' — ' + c[k]));
    const list = a => a.map(x => '<div>' + esc(x) + '</div>').join('');
    const ok = !lack.length && !over.length;
    g('fzDlgBody').onclick = null;
    g('fzDlgBody').innerHTML = '<h3 style="margin:0">' + (ok ? 'Đủ hàng ✓' : 'Có chênh lệch') + '</h3><div>VN' + esc(p.num) + ' · ' + esc(p.po) + '</div>' +
      (lack.length ? '<b style="color:#C62828">Thiếu / lệch (' + lack.length + ')</b><div class="fz-dlist">' + list(lack) + '</div>' : '') +
      (over.length ? '<b style="color:#B45309">Thừa (' + over.length + ')</b><div class="fz-dlist">' + list(over) + '</div>' : '') +
      (box.length ? '<b style="color:#12805C">Nguyên hộp (' + box.length + ')</b><div class="fz-dlist">' + list(box) + '</div>' : '');
    const a = g('fzDlgAct'); a.innerHTML = '';
    const add = (t, cls, fn) => { const b = document.createElement('button'); b.textContent = t; if (cls) b.className = cls; b.onclick = fn; a.appendChild(b); };
    add('Kiểm tiếp', 'ghost', () => g('fzDlg').close());
    add('Xác nhận xong', '', () => { const q = prog(p.po); q.done = true; save(key(p.po), q); g('fzDlg').close(); showList(); });
    if (!g('fzDlg').open) g('fzDlg').showModal();
  }

  // ---------- Gắn sự kiện (một lần) ----------
  function bind() {
    if (S.bound) return; S.bound = true;
    g('fzPos').onclick = e => { const el = e.target.closest('.fz-po'); if (el) openPO(el.dataset.po); };
    g('fzRefresh').onclick = () => ensureData(true);
    g('fzQ').oninput = () => { if (!S.data) return; if (g('fzQ').value.trim()) S.cat = null; renderList(); };
    g('fzStats').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.cat = S.cat === b.dataset.c ? null : b.dataset.c; g('fzQ').value = ''; renderList(); };
    g('fzQ').onkeydown = e => {
      if (e.key !== 'Enter' || !S.data) return;
      const ps = match(g('fzQ').value);
      if (ps.length && (ps.length === 1 || match(g('fzQ').value)[0].num === g('fzQ').value.replace(/\D/g, ''))) openPO(ps[0].po);
    };
    g('fzBack').onclick = showList;
    g('fzLast').onclick = e => {
      const b = e.target.closest('button'); if (!b || !S.last) return; confirmAct(b.dataset.d);
    };
    function confirmAct(d) {
      const k = S.last, it = S.po.map.get(k), cur = prog(S.po.po).counts[k] || 0;
      if (d === 'ok') { if (!it) return; setCount(k, it[2]); S.pending = null; }
      else if (d === 'set') {
        const v = prompt('Số lượng thực tế của mã này:', cur || (it ? it[2] : '')); if (v === null) return;
        const n = parseInt(v, 10); if (isNaN(n) || n < 1) return; setCount(k, n); S.pending = null;
      } else if (d === 'del') { setCount(k, 0); S.pending = null; g('fzLast').hidden = true; render(); focusScan(); return; }
      else if (d === 'skip') { S.pending = null; g('fzLast').hidden = true; render(); focusScan(); return; }
      beep(true); showLast(k); render(); focusScan();
    }
    // Máy quét PDA có thể gửi Enter hoặc không: không có Enter thì tự gửi sau khi mã ngừng chạy vào ô (~150ms).
    // Bật bàn phím (⌨) thì gõ tay, chỉ nhận khi bấm Enter.
    let scanTimer = null, lastSubmit = 0;
    function submitScan(raw) {
      lastSubmit = Date.now();
      if (prog(S.po.po).done) { beep(false); return; } // đã kết thúc: phải bấm Mở lại mới quét tiếp
      const k = norm(raw);
      if (S.pending) { beep(false); showLast(S.pending, false, true); return; } // chưa xác nhận mã trước
      const it = S.po.map.get(k), again = (prog(S.po.po).counts[k] || 0) > 0;
      if (!again) S.pending = k;
      beep(!!it); showLast(k, again); render();
    }
    g('fzScan').oninput = e => {
      clearTimeout(scanTimer);
      if (S.kbd) return;
      scanTimer = setTimeout(() => {
        const i = g('fzScan'), raw = i.value.trim();
        if (raw.length >= 6) { i.value = ''; submitScan(raw); }
      }, 150);
    };
    g('fzScan').onkeydown = e => {
      if (e.key !== 'Enter') return;
      clearTimeout(scanTimer);
      const raw = e.target.value.trim(); e.target.value = '';
      if (raw) { submitScan(raw); return; }
      // Enter trống = xác nhận mã đang mở (bỏ qua Enter đi kèm ngay sau một lần quét)
      if (Date.now() - lastSubmit > 600 && S.pending && S.po.map.has(S.pending)) confirmAct('ok');
    };
    const kbd = () => { S.kbd = !S.kbd; ['fzScan', 'fzQ'].forEach(id => g(id).inputMode = S.kbd ? 'text' : 'none'); const i = S.po ? g('fzScan') : g('fzQ'); i.blur(); i.focus(); };
    g('fzKbd').onclick = kbd; g('fzKbd2').onclick = kbd;
    // PDA hay mất focus sau khi bấm nút: quay lại ô quét
    document.addEventListener('click', e => {
      if (visible() && !g('fzDlg').open && !e.target.closest('input,dialog,.rail')) setTimeout(() => { if (visible()) (S.po ? g('fzScan') : g('fzQ')).focus(); }, 50);
    });
    g('fzFinish').onclick = finish;
    g('fzReopen').onclick = () => { const pr = prog(S.po.po); pr.done = false; save(key(S.po.po), pr); render(); focusScan(); };
    g('fzReset').onclick = () => dialog('<b>Xoá toàn bộ kết quả đã quét của PO này và kiểm lại từ đầu?</b>',
      [['Không', 'ghost'], ['Xoá hết', '', () => { save(key(S.po.po), { counts: {}, done: false }); S.last = null; S.pending = null; g('fzLast').hidden = true; render(); focusScan(); }]]);
  }

  return { show };
})();
