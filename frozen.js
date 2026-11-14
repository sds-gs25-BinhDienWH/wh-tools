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

  const S = { data: null, loading: false, po: null, filter: 'todo', last: null, kbd: false, bound: false };
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

  async function ensureData() {
    if (S.data || S.loading) return;
    S.loading = true; g('fzPos').innerHTML = '<p>Đang tải danh sách PO…</p>';
    try {
      const r = await fetch('frozen-data.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error(r.status);
      S.data = await r.json();
      S.data.pos.forEach(p => { p.map = new Map(p.items.map(i => [norm(i[0]), i])); p.total = p.items.reduce((a, i) => a + i[2], 0); });
    } catch (e) { g('fzPos').innerHTML = '<p>Không tải được dữ liệu PO (' + esc(e.message) + ').</p>'; }
    S.loading = false;
    if (S.data) showList();
  }

  function show() {
    bind();
    if (!S.data) { ensureData(); return; }
    if (S.po) focusScan(); else { g('fzQ').focus(); }
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
    S.po = null; g('fzList').hidden = false; g('fzCheck').hidden = true;
    renderList(); focusQ();
  }
  // Khớp theo số cửa hàng (bỏ chữ VN): đầu số trước (005 -> 0052, 0053), rồi tới chứa số, rồi tới tên
  function match(raw) {
    const q = fold(raw.trim()).replace(/^vn/, '').replace(/\s+/g, '');
    if (!q) return [];
    const sc = p => p.num === q ? 0 : p.num.startsWith(q) ? 1 : p.num.includes(q) ? 2 : fold(p.storeName + ' ' + p.po).includes(q) ? 3 : 9;
    return S.data.pos.map(p => [sc(p), p]).filter(x => x[0] < 9).sort((a, b) => a[0] - b[0] || (a[1].num < b[1].num ? -1 : 1)).map(x => x[1]);
  }
  function renderList() {
    const ps = match(g('fzQ').value), total = S.data.pos.length;
    const done = S.data.pos.filter(p => prog(p.po).done).length;
    g('fzMeta').textContent = 'PO ngày ' + S.data.date + ' · đã kiểm xong ' + done + '/' + total + (g('fzQ').value.trim() ? ' · tìm thấy ' + ps.length : '');
    g('fzPos').innerHTML = ps.slice(0, 8).map(p => {
      const s = status(p);
      const b = s.done ? (s.diff ? '<span class="fz-badge bad">Lệch</span>' : '<span class="fz-badge ok">Đủ</span>')
        : s.any ? '<span class="fz-badge wip">' + s.got + '/' + p.items.length + ' mã</span>' : '<span class="fz-badge">' + p.items.length + ' mã</span>';
      return '<div class="fz-po" data-po="' + esc(p.po) + '"><div><b>' + esc(p.num) + ' · ' + esc(p.storeName) + '</b><small>' + esc(p.po) + ' · ' + p.items.length + ' mã</small></div>' + b + '</div>';
    }).join('') + (ps.length > 8 ? '<p class="fz-meta">Còn ' + (ps.length - 8) + ' cửa hàng nữa, gõ thêm số để lọc.</p>' : '')
      || (g('fzQ').value.trim() ? '<p>Không có cửa hàng nào khớp.</p>' : '');
  }

  // ---------- Kiểm một PO ----------
  function openPO(po) {
    S.po = S.data.pos.find(p => p.po === po); S.last = null;
    g('fzList').hidden = true; g('fzCheck').hidden = false; g('fzLast').hidden = true;
    g('fzTitle').innerHTML = esc(S.po.num) + ' · ' + esc(S.po.storeName) + '<small>' + esc(S.po.po) + '</small>';
    render(); focusScan();
  }
  function focusQ() { const i = g('fzQ'); i.value = ''; renderList(); setTimeout(() => i.focus(), 30); }
  function focusScan() { const i = g('fzScan'); i.value = ''; i.focus(); }

  const state = (it, n) => n === it[2] ? 'ok' : n > it[2] ? 'bad' : n > 0 ? 'wip' : '';
  // Quét MÃ HÀNG (không quét từng cái): quét một lần là xác nhận mã đó đúng bằng số lượng trong PO. Số lượng chỉ để tham khảo.
  function render() {
    const p = S.po, c = prog(p.po).counts;
    let codes = 0, got = 0; p.items.forEach(it => { const n = c[norm(it[0])] || 0; if (n > 0) codes++; got += Math.min(n, it[2]); });
    const pct = p.items.length ? Math.round(codes * 100 / p.items.length) : 0;
    g('fzProg').innerHTML = 'Đã kiểm <b>' + codes + '</b> / ' + p.items.length + ' mã<div class="fz-bar"><i style="width:' + pct + '%"></i></div>';
  }

  function setCount(k, n) {
    const pr = prog(S.po.po); n = Math.max(0, n);
    if (n) pr.counts[k] = n; else delete pr.counts[k];
    pr.done = false; save(key(S.po.po), pr);
  }
  function showLast(k, again) {
    const it = S.po.map.get(k), n = prog(S.po.po).counts[k] || 0, box = g('fzLast');
    const known = !!it, need = known ? it[2] : 0;
    const st = !known ? 'bad' : state(it, n);
    const msg = !known ? 'MÃ NGOÀI PO — không có trong đơn này'
      : n === need ? 'XÁC NHẬN SỐ LƯỢNG: ' + need + ' ✓'
      : 'ĐÃ GHI NHẬN ' + n + ' (PO ' + need + ')';
    box.className = 'fz-last ' + st; box.hidden = false;
    box.innerHTML = '<div class="nm">' + esc(known ? it[1] : 'Mã ' + k) + '</div><div class="code">' + esc(known ? it[0] : k) + (again ? ' · mã này đã quét rồi' : '') + '</div>' +
      '<div class="big"><span>SL PO</span><b>' + need + '</b></div><div class="msg">' + esc(msg) + '</div>' +
      '<div class="adj"><button type="button" class="ghost" data-d="set">Số lượng khác</button><button type="button" class="ghost" data-d="del">Bỏ quét mã này</button></div>';
    S.last = k;
  }

  // ---------- Hộp thoại ----------
  function dialog(html, acts) {
    g('fzDlgBody').innerHTML = html; const a = g('fzDlgAct'); a.innerHTML = '';
    acts.forEach(([t, cls, fn]) => { const b = document.createElement('button'); b.textContent = t; if (cls) b.className = cls; b.onclick = () => { g('fzDlg').close(); fn && fn(); }; a.appendChild(b); });
    g('fzDlg').showModal();
  }
  function finish() {
    const p = S.po, c = prog(p.po).counts, lack = [], over = [];
    p.items.forEach(it => { const n = c[norm(it[0])] || 0; if (n === 0) lack.push(it[1] + ' — chưa quét (PO ' + it[2] + ')'); else if (n < it[2]) lack.push(it[1] + ' — ghi nhận ' + n + ', PO ' + it[2]); else if (n > it[2]) over.push(it[1] + ' — thừa ' + (n - it[2])); });
    Object.keys(c).filter(k => !p.map.has(k)).forEach(k => over.push('Mã ngoài PO ' + k + ' — ' + c[k]));
    const list = a => a.map(x => '<div>' + esc(x) + '</div>').join('');
    const ok = !lack.length && !over.length;
    dialog('<h3 style="margin:0">' + (ok ? 'Đủ hàng ✓' : 'Có chênh lệch') + '</h3><div>' + esc(p.store) + ' · ' + esc(p.po) + '</div>' +
      (lack.length ? '<b style="color:#C62828">Chưa quét / thiếu (' + lack.length + ')</b><div class="fz-dlist">' + list(lack) + '</div>' : '') +
      (over.length ? '<b style="color:#B45309">Thừa (' + over.length + ')</b><div class="fz-dlist">' + list(over) + '</div>' : ''),
      [['Kiểm tiếp', 'ghost'], ['Xác nhận xong', '', () => { const pr = prog(p.po); pr.done = true; save(key(p.po), pr); showList(); }]]);
  }

  // ---------- Gắn sự kiện (một lần) ----------
  function bind() {
    if (S.bound) return; S.bound = true;
    g('fzPos').onclick = e => { const el = e.target.closest('.fz-po'); if (el) openPO(el.dataset.po); };
    g('fzQ').oninput = () => S.data && renderList();
    g('fzQ').onkeydown = e => {
      if (e.key !== 'Enter' || !S.data) return;
      const ps = match(g('fzQ').value);
      if (ps.length && (ps.length === 1 || match(g('fzQ').value)[0].num === g('fzQ').value.replace(/\D/g, ''))) openPO(ps[0].po);
    };
    g('fzBack').onclick = showList;
    g('fzLast').onclick = e => {
      const b = e.target.closest('button'); if (!b || !S.last) return; const k = S.last, cur = prog(S.po.po).counts[k] || 0;
      if (b.dataset.d === 'set') {
        const v = prompt('Số lượng thực tế của mã này:', cur); if (v === null) return;
        const n = parseInt(v, 10); if (isNaN(n) || n < 0) return; setCount(k, n);
      } else setCount(k, 0);
      showLast(k); render(); focusScan();
    };
    g('fzScan').onkeydown = e => {
      if (e.key !== 'Enter') return;
      const raw = e.target.value.trim(); e.target.value = ''; if (!raw) return;
      const k = norm(raw), it = S.po.map.get(k), again = (prog(S.po.po).counts[k] || 0) > 0;
      if (!again) setCount(k, it ? it[2] : 1);
      beep(!!it); showLast(k, again); render();
    };
    const kbd = () => { S.kbd = !S.kbd; ['fzScan', 'fzQ'].forEach(id => g(id).inputMode = S.kbd ? 'text' : 'none'); const i = S.po ? g('fzScan') : g('fzQ'); i.blur(); i.focus(); };
    g('fzKbd').onclick = kbd; g('fzKbd2').onclick = kbd;
    // PDA hay mất focus sau khi bấm nút: quay lại ô quét
    document.addEventListener('click', e => {
      if (visible() && !g('fzDlg').open && !e.target.closest('input,dialog,.rail')) setTimeout(() => { if (visible()) (S.po ? g('fzScan') : g('fzQ')).focus(); }, 50);
    });
    g('fzFinish').onclick = finish;
    g('fzReset').onclick = () => dialog('<b>Xoá toàn bộ số đã quét của PO này và kiểm lại từ đầu?</b>',
      [['Không', 'ghost'], ['Làm lại', '', () => { save(key(S.po.po), { counts: {}, done: false }); S.last = null; g('fzLast').hidden = true; render(); focusScan(); }]]);
  }

  return { show };
})();
