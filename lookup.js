'use strict';
// Màn "Tra ảnh" của WH Tool: PIC claim (dùng trên máy tính) tìm ảnh rổ theo NGÀY + CỬA HÀNG.
// Gọi proxy ảnh (PHOTO_URL, xem photo.js): listPhotos (danh sách ảnh của 1 ngày, lọc theo cửa hàng) và getPhotos (ảnh thu nhỏ theo lô / 1 ảnh gốc).
// Chỉ tài khoản có trong VIEWER_IDS của proxy ảnh mới xem được (proxy kiểm tra, app chỉ hiện thông báo lỗi nếu bị từ chối).
// Dùng lại từ app.js: S (nhân viên), proxyFetch, toast, netStart, netDone, errBox, loading. Dùng lại từ photo.js: PH.url, PH.stores, PH.match.
const LK = (() => {
  const g = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const dmy = s => s.split('-').reverse().join('/');
  const hms = t => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
  const THUMB_BATCH = 8;          // phải <= THUMB_BATCH_MAX của proxy
  const FULL_KEEP = 12;           // số ảnh gốc giữ trong bộ nhớ

  const L = { bound: false, items: [], date: '', store: '', view: [], thumbs: new Map(), full: new Map(), gridId: 0, cur: -1, fromCards: false };

  async function call(action, payload, timeout) {
    const url = PH.url;
    if (!/^https:\/\//i.test(url)) throw new Error('Chưa cấu hình địa chỉ máy chủ ảnh (PHOTO_URL trong photo.js)');
    if (!S.emp) throw new Error('Chưa đăng nhập');
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), timeout || 60000);
    netStart();
    try {
      const res = await proxyFetch(url, { action, emp: S.emp.id, ...payload }, ctl.signal);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      if (d && d.__error) throw new Error(d.__error);
      return d;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Quá thời gian chờ, thử lại');
      throw e;
    } finally { clearTimeout(tm); netDone(); }
  }

  const toBlobUrl = async p => { const b = await (await fetch('data:' + p.mime + ';base64,' + p.b64)).blob(); return URL.createObjectURL(b); };

  // ---------- Tìm ----------
  async function search() {
    const date = g('lkDate').value, raw = g('lkStore').value.trim();
    if (!date) { toast('Chọn ngày'); return; }
    let store = '';
    if (raw) {
      const ms = PH.match(raw), q = raw.replace(/\D/g, '');
      if (ms.length && (ms.length === 1 || ms[0].num === q)) store = ms[0].id;
      else if (/^\d{4}$/.test(q)) store = 'VN' + q;
      else { g('lkOut').innerHTML = errBox('Không rõ cửa hàng "' + raw + '". Chọn một cửa hàng trong gợi ý hoặc để trống để xem tất cả.'); return; }
    }
    hideSugg();
    L.date = date; L.store = store; clearMem();
    g('lkOut').innerHTML = loading;
    try {
      const d = await call('listPhotos', { date, store });
      L.items = d.items || [];
      render(d.truncated);
    } catch (e) { g('lkOut').innerHTML = errBox(e); }
  }

  function groups() {
    const m = new Map();
    L.items.forEach(it => { if (!m.has(it.store)) m.set(it.store, { store: it.store, name: it.storeName, list: [] }); m.get(it.store).list.push(it); });
    return [...m.values()];
  }
  const totes = list => new Set(list.map(i => i.tote).filter(Boolean)).size;

  function render(truncated) {
    const gs = groups(), out = g('lkOut');
    if (!gs.length) {
      out.innerHTML = '<p class="muted">Không có ảnh nào ngày <b>' + dmy(L.date) + '</b>' + (L.store ? ' của cửa hàng <b>' + esc(L.store) + '</b>' : '') + '.</p>';
      return;
    }
    if (gs.length === 1) { L.fromCards = false; renderGrid(gs[0], truncated); return; }
    L.fromCards = true;
    out.innerHTML = '<div class="lk-sum">Ngày <b>' + dmy(L.date) + '</b>: <b>' + gs.length + '</b> cửa hàng · <b>' + L.items.length + '</b> ảnh · <b>' + totes(L.items) + '</b> rổ' +
      (truncated ? ' <span class="lk-warn">(chỉ hiện ' + L.items.length + ' ảnh đầu, lọc theo cửa hàng để xem đủ)</span>' : '') + '</div>' +
      '<div class="lk-cards">' + gs.map(x => '<button type="button" class="lk-card" data-s="' + esc(x.store) + '"><b>' + esc(x.store) + '</b><span>' + esc(x.name) + '</span><small>' + x.list.length + ' ảnh · ' + totes(x.list) + ' rổ</small></button>').join('') + '</div>';
  }

  function renderGrid(gr, truncated) {
    L.view = gr.list; L.gridId++;
    g('lkOut').innerHTML = '<div class="lk-head">' + (L.fromCards ? '<button type="button" class="ghost" id="lkBack">← Tất cả cửa hàng</button>' : '') +
      '<div class="lk-title"><b>' + esc(gr.store) + '</b> · ' + esc(gr.name) + '<small>Ngày ' + dmy(L.date) + ' · ' + gr.list.length + ' ảnh · ' + totes(gr.list) + ' rổ' +
      (truncated ? ' · chưa hiện đủ' : '') + '</small></div></div>' +
      '<div class="lk-grid">' + gr.list.map((it, i) => '<div class="lk-tile" data-i="' + i + '"><div class="lk-img"><img data-f="' + esc(it.fileId) + '" alt=""><span class="lk-ph">…</span></div>' +
        '<div class="lk-cap"><b>' + esc(it.tote || 'Không mã rổ') + '</b><small>' + (it.trip ? 'C' + esc(it.trip) + (it.tripType ? ' ' + esc(it.tripType) : '') + ' · ' : '') + hms(it.at) + ' · ' + esc(it.empName) + (it.note ? ' · <span class="lk-warn">⚠ ' + esc(it.note) + '</span>' : '') + '</small></div></div>').join('') + '</div>';
    loadThumbs(L.gridId);
  }

  // Ảnh thu nhỏ tải theo lô, lần lượt; chuyển màn khác giữa chừng thì dừng (gridId đổi)
  async function loadThumbs(id) {
    const need = L.view.filter(it => !L.thumbs.has(it.fileId));
    for (let i = 0; i < need.length && id === L.gridId; i += THUMB_BATCH) {
      const batch = need.slice(i, i + THUMB_BATCH);
      try {
        const d = await call('getPhotos', { items: batch.map(b => ({ fileId: b.fileId, sig: b.sig })) });
        for (const b of batch) { const p = d.photos && d.photos[b.fileId]; if (p && p.b64) L.thumbs.set(b.fileId, await toBlobUrl(p)); }
      } catch (e) { if (id === L.gridId) toast('Không tải được ảnh thu nhỏ: ' + (e.message || e)); break; }
      if (id === L.gridId) paintThumbs();
    }
    if (id === L.gridId) paintThumbs();
  }
  function paintThumbs() {
    document.querySelectorAll('#lkOut img[data-f]').forEach(im => {
      const u = L.thumbs.get(im.dataset.f);
      if (u && im.src !== u) { im.src = u; im.parentNode.classList.add('on'); }
    });
  }

  // ---------- Xem ảnh to ----------
  async function openFull(i) {
    const it = L.view[i]; if (!it) return;
    L.cur = i;
    const box = g('lkFull'); box.hidden = false;
    g('lkFullCap').innerHTML = '<b>' + esc(it.tote || 'Không mã rổ') + '</b> · ' + esc(it.store) + ' ' + esc(it.storeName) + '<small>' + dmy(L.date) + ' ' + hms(it.at) + ' · ' + esc(it.empName) + ' (' + esc(it.emp) + ') · ' + it.kb + ' KB' + (it.note ? ' · ⚠ ' + esc(it.note) : '') +
      (it.trip ? ' · Chuyến ' + esc(it.trip) + (it.tripType ? ' ' + esc(it.tripType) : '') + (it.plate ? ' · ' + esc(it.plate) : '') + (it.driver ? ' · ' + esc(it.driver) : '') : '') + '</small>';
    const img = g('lkFullImg'); img.removeAttribute('src');
    g('lkFullMsg').textContent = 'Đang tải ảnh…';
    let url = L.full.get(it.fileId);
    if (!url) {
      try {
        const d = await call('getPhotos', { items: [{ fileId: it.fileId, sig: it.sig }], full: true });
        const p = d.photos && d.photos[it.fileId];
        if (!p || !p.b64) throw new Error((p && p.error) || 'Không mở được ảnh');
        url = await toBlobUrl(p);
        L.full.set(it.fileId, url);
        while (L.full.size > FULL_KEEP) { const k = L.full.keys().next().value; try { URL.revokeObjectURL(L.full.get(k)); } catch {} L.full.delete(k); }
      } catch (e) { if (L.cur === i) g('lkFullMsg').textContent = 'Lỗi: ' + (e.message || e); return; }
    }
    if (L.cur !== i) return;                     // đã chuyển sang ảnh khác trong lúc chờ
    g('lkFullMsg').textContent = '';
    img.src = url;
    const a = g('lkDownload'); a.href = url;
    a.download = [it.store, dmy(L.date).replace(/\//g, '-'), it.tote || 'khong-ma-ro', hms(it.at).replace(/:/g, '')].join('_') + '.jpg';
  }
  function closeFull() { g('lkFull').hidden = true; L.cur = -1; g('lkFullImg').removeAttribute('src'); }
  function step(d) { if (L.cur < 0) return; const n = L.cur + d; if (n >= 0 && n < L.view.length) openFull(n); }

  // ---------- Gợi ý cửa hàng khi gõ ----------
  function hideSugg() { const b = g('lkSugg'); b.hidden = true; b.innerHTML = ''; }
  function onStoreInput() {
    const raw = g('lkStore').value, box = g('lkSugg');
    if (!raw.trim()) { hideSugg(); return; }
    const ms = PH.match(raw).slice(0, 6);
    box.hidden = !ms.length;
    box.innerHTML = ms.map((s, i) => '<button type="button" class="sg" data-i="' + i + '"><b>' + esc(s.id) + '</b><small>' + esc(s.name) + '</small></button>').join('');
    box.onclick = e => { const b = e.target.closest('.sg'); if (!b) return; const s = ms[Number(b.dataset.i)]; g('lkStore').value = s.id; hideSugg(); search(); };
  }

  function shiftDay(d) {
    const v = g('lkDate').value; if (!v) return;
    const t = new Date(v + 'T12:00:00'); t.setDate(t.getDate() + d); g('lkDate').value = ymd(t); search();
  }

  function clearMem() {
    L.gridId++; closeFull();
    [...L.thumbs.values(), ...L.full.values()].forEach(u => { try { URL.revokeObjectURL(u); } catch {} });
    L.thumbs.clear(); L.full.clear(); L.items = []; L.view = [];
  }

  function bind() {
    if (L.bound) return; L.bound = true;
    g('lkGo').onclick = search;
    g('lkPrev').onclick = () => shiftDay(-1);
    g('lkNext').onclick = () => shiftDay(1);
    g('lkToday').onclick = () => { g('lkDate').value = ymd(new Date()); search(); };
    g('lkStore').oninput = onStoreInput;
    g('lkStore').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); search(); } };
    g('lkDate').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); search(); } };
    g('lkOut').onclick = e => {
      const c = e.target.closest('.lk-card'); if (c) { const gr = groups().find(x => x.store === c.dataset.s); if (gr) renderGrid(gr); return; }
      if (e.target.closest('#lkBack')) { render(); return; }
      const t = e.target.closest('.lk-tile'); if (t) openFull(Number(t.dataset.i));
    };
    g('lkFullClose').onclick = closeFull;
    g('lkFullPrev').onclick = () => step(-1);
    g('lkFullNext').onclick = () => step(1);
    g('lkFull').onclick = e => { if (e.target === g('lkFull')) closeFull(); };
    document.addEventListener('keydown', e => {
      if (g('lkFull').hidden) return;
      if (e.key === 'Escape') closeFull(); else if (e.key === 'ArrowLeft') step(-1); else if (e.key === 'ArrowRight') step(1);
    });
    document.addEventListener('click', e => { if (!e.target.closest('#lkSugg, #lkStore')) hideSugg(); });
  }

  function show() {
    bind();
    if (!g('lkDate').value) g('lkDate').value = ymd(new Date());
    PH.stores().catch(() => {});
  }
  // Đổi người / hết phiên: xoá ảnh đang hiển thị khỏi bộ nhớ (người sau không thấy)
  function reset() { clearMem(); if (g('lkOut')) g('lkOut').innerHTML = ''; if (g('lkStore')) g('lkStore').value = ''; }

  return { show, reset };
})();
