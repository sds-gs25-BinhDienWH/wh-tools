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
    for (const it of p.items) { const n = c[norm(it[0])] || 0; got += Math.min(n, it[2]); if (n !== it[2]) diff = true; }
    return { got, any, diff, done: pr.done };
  }

  // ---------- Danh sách PO ----------
  function showList() {
    S.po = null; g('fzList').hidden = false; g('fzCheck').hidden = true;
    renderList(); focusQ();
  }
  function renderList() {
    const q = fold(g('fzQ').value.trim());
    const ps = S.data.pos.filter(p => !q || fold(p.store + ' ' + p.storeName + ' ' + p.po).includes(q));
    const done = S.data.pos.filter(p => prog(p.po).done).length;
    g('fzMeta').textContent = 'PO ngày ' + S.data.date + ' · ' + ps.length + '/' + S.data.pos.length + ' PO · đã kiểm xong ' + done;
    g('fzPos').innerHTML = ps.map(p => {
      const s = status(p);
      const b = s.done ? (s.diff ? '<span class="fz-badge bad">Lệch</span>' : '<span class="fz-badge ok">Đủ</span>')
        : s.any ? '<span class="fz-badge wip">' + s.got + '/' + p.total + '</span>' : '<span class="fz-badge">' + p.total + ' sp</span>';
      return '<div class="fz-po" data-po="' + esc(p.po) + '"><div><b>' + esc(p.store) + ' · ' + esc(p.storeName) + '</b><small>' + esc(p.po) + ' · ' + p.items.length + ' mã</small></div>' + b + '</div>';
    }).join('') || '<p>Không có PO nào khớp.</p>';
  }

  // ---------- Kiểm một PO ----------
  function openPO(po) {
    S.po = S.data.pos.find(p => p.po === po); S.last = null; S.filter = 'todo';
    g('fzList').hidden = true; g('fzCheck').hidden = false; g('fzLast').hidden = true;
    g('fzTitle').innerHTML = esc(S.po.store) + ' · ' + esc(S.po.storeName) + '<small>' + esc(S.po.po) + '</small>';
    g('fzTabs').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.f === S.filter));
    render(); focusScan();
  }
  function focusQ() { const i = g('fzQ'); i.value = ''; renderList(); setTimeout(() => i.focus(), 30); }
  function focusScan() { const i = g('fzScan'); i.value = ''; i.focus(); }

  const state = (it, n) => n === it[2] ? 'ok' : n > it[2] ? 'bad' : n > 0 ? 'wip' : '';
  function render(flashKey) {
    const p = S.po, c = prog(p.po).counts;
    let got = 0; p.items.forEach(it => got += Math.min(c[norm(it[0])] || 0, it[2]));
    const pct = p.total ? Math.round(got * 100 / p.total) : 0;
    g('fzProg').innerHTML = 'Đã kiểm ' + got + '/' + p.total + ' sp (' + pct + '%)<div class="fz-bar"><i style="width:' + pct + '%"></i></div>';
    const rows = p.items.map(it => ({ it, k: norm(it[0]), n: c[norm(it[0])] || 0 }));
    const extra = Object.keys(c).filter(k => !p.map.has(k) && c[k] > 0).map(k => ({ it: [k, 'Mã ngoài PO', 0], k, n: c[k] }));
    let list = rows.concat(extra);
    if (S.filter === 'todo') list = list.filter(r => r.n !== r.it[2]);
    if (S.filter === 'done') list = list.filter(r => r.n === r.it[2]);
    list.sort((a, b) => (b.k === flashKey) - (a.k === flashKey) || (b.n > 0) - (a.n > 0));
    g('fzItems').innerHTML = list.map(r => '<div class="fz-it ' + state(r.it, r.n) + (r.k === flashKey ? ' flash' : '') + '" data-k="' + esc(r.k) + '"><div class="nm">' + esc(r.it[1]) +
      '<small>' + esc(r.it[0]) + '</small></div><div class="q">' + r.n + '<span> / ' + r.it[2] + '</span></div></div>').join('') || '<p>Không có dòng nào.</p>';
  }

  function setCount(k, n) {
    const pr = prog(S.po.po); n = Math.max(0, n);
    if (n) pr.counts[k] = n; else delete pr.counts[k];
    pr.done = false; save(key(S.po.po), pr);
  }
  function showLast(k) {
    const it = S.po.map.get(k), n = prog(S.po.po).counts[k] || 0, box = g('fzLast');
    const known = !!it, need = known ? it[2] : 0;
    const st = !known ? 'bad' : state(it, n);
    const msg = !known ? 'MÃ NGOÀI PO — không có trong đơn này'
      : n === need ? 'ĐỦ SỐ LƯỢNG: ' + n + '/' + need + ' ✓'
      : n > need ? 'THỪA ' + (n - need) + ' (đã quét ' + n + ', cần ' + need + ')'
      : 'Còn thiếu ' + (need - n) + ' (đã quét ' + n + ', cần ' + need + ')';
    box.className = 'fz-last ' + st; box.hidden = false;
    box.innerHTML = '<div class="nm">' + esc(known ? it[1] : 'Mã ' + k) + '</div><div class="code">' + esc(known ? it[0] : k) + '</div>' +
      '<div class="big"><b>' + n + '</b><span>/ ' + need + '</span></div><div class="msg">' + esc(msg) + '</div>' +
      '<div class="adj"><button type="button" class="ghost" data-d="-1">−1</button><button type="button" class="ghost" data-d="set">Nhập số</button><button type="button" class="ghost" data-d="1">+1</button></div>';
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
    p.items.forEach(it => { const n = c[norm(it[0])] || 0; if (n < it[2]) lack.push(it[1] + ' — thiếu ' + (it[2] - n) + ' (' + n + '/' + it[2] + ')'); else if (n > it[2]) over.push(it[1] + ' — thừa ' + (n - it[2])); });
    Object.keys(c).filter(k => !p.map.has(k)).forEach(k => over.push('Mã ngoài PO ' + k + ' — ' + c[k]));
    const list = a => a.map(x => '<div>' + esc(x) + '</div>').join('');
    const ok = !lack.length && !over.length;
    dialog('<h3 style="margin:0">' + (ok ? 'Đủ hàng ✓' : 'Có chênh lệch') + '</h3><div>' + esc(p.store) + ' · ' + esc(p.po) + '</div>' +
      (lack.length ? '<b style="color:#C62828">Thiếu (' + lack.length + ')</b><div class="fz-dlist">' + list(lack) + '</div>' : '') +
      (over.length ? '<b style="color:#B45309">Thừa (' + over.length + ')</b><div class="fz-dlist">' + list(over) + '</div>' : ''),
      [['Kiểm tiếp', 'ghost'], ['Xác nhận xong', '', () => { const pr = prog(p.po); pr.done = true; save(key(p.po), pr); showList(); }]]);
  }

  // ---------- Gắn sự kiện (một lần) ----------
  function bind() {
    if (S.bound) return; S.bound = true;
    g('fzPos').onclick = e => { const el = e.target.closest('.fz-po'); if (el) openPO(el.dataset.po); };
    g('fzQ').oninput = () => S.data && renderList();
    g('fzQ').onkeydown = e => { // quét mã cửa hàng/PO + Enter: chỉ còn 1 PO thì vào luôn
      if (e.key !== 'Enter' || !S.data) return;
      const q = fold(g('fzQ').value.trim()); if (!q) return;
      const ps = S.data.pos.filter(p => fold(p.store + ' ' + p.po).includes(q));
      if (ps.length === 1) openPO(ps[0].po);
    };
    g('fzBack').onclick = showList;
    g('fzTabs').onclick = e => {
      const b = e.target.closest('button'); if (!b) return; S.filter = b.dataset.f;
      g('fzTabs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); render();
    };
    g('fzLast').onclick = e => {
      const b = e.target.closest('button'); if (!b || !S.last) return; const k = S.last, cur = prog(S.po.po).counts[k] || 0;
      if (b.dataset.d === 'set') {
        const v = prompt('Số lượng thực tế của mã này:', cur); if (v === null) return;
        const n = parseInt(v, 10); if (isNaN(n) || n < 0) return; setCount(k, n);
      } else setCount(k, cur + parseInt(b.dataset.d, 10));
      showLast(k); render(k); focusScan();
    };
    g('fzItems').onclick = e => { const el = e.target.closest('.fz-it'); if (el) { showLast(el.dataset.k); focusScan(); } };
    g('fzScan').onkeydown = e => {
      if (e.key !== 'Enter') return;
      const raw = e.target.value.trim(); e.target.value = ''; if (!raw) return;
      const k = norm(raw), it = S.po.map.get(k);
      setCount(k, (prog(S.po.po).counts[k] || 0) + 1);
      const n = prog(S.po.po).counts[k];
      beep(!!it && n <= it[2]); showLast(k); render(k);
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
