'use strict';
// Chức năng "Chụp ảnh rổ" của WH Tool (thay cho tab Kiểm hàng cũ).
// Luồng: quét/nhập số cửa hàng -> quét mã rổ -> bấm CHỤP -> ảnh được nén + đóng dấu, lưu trong hàng đợi trên máy (IndexedDB)
// rồi gửi ngầm lên proxy Apps Script (action "uploadPhoto") để ghi vào Google Drive. Mất mạng thì giữ hàng đợi, có mạng tự gửi lại.
// Tự đóng gói trong IIFE để không đụng biến của app.js. app.js gọi PH.show() / PH.hide() / PH.reset() / PH.init().
// Dùng lại từ app.js: S (nhân viên), proxyFetch, getDev, toast, netStart, netDone. Gửi ảnh tới PHOTO_URL (proxy ảnh riêng), không dùng proxy cũ.
// Thử không gửi lên Drive: mở trang với #photodry (ảnh vẫn chụp, nén, đóng dấu, vào hàng đợi, nhưng bị bỏ thay vì gửi).
const PH = (() => {
  // ---- Thông số (đổi ở đây, không phải sửa logic) ----
  // Địa chỉ proxy ẢNH (Apps Script RIÊNG, deploy bằng tài khoản Google chứa Drive ảnh; xem photo-proxy/Code.gs trong thư mục PDA Claim Photo).
  // KHÔNG phải PROXY_URL của app.js: các tab khác vẫn gọi proxy cũ, chỉ tab Chụp ảnh gọi địa chỉ này. Chưa điền thì ảnh vẫn chụp và giữ trong hàng đợi.
  const PHOTO_URL = 'https://script.google.com/macros/s/AKfycbyrKZNFlgngpRcDIP_iYevslaBziJRxSWtwt7AO0HKn4VU8abN_EaQtvYUfQ2B3iesoOg/exec';
  const PHOTO_MAX_EDGE = 2048;       // cạnh dài tối đa của ảnh sau nén (px)
  const PHOTO_JPEG_QUALITY = 0.85;    // chất lượng JPEG
  const UPLOAD_TIMEOUT_MS = 90000;    // mỗi lần gửi tối đa chừng này
  const SERVER_ERR_MAX_TRIES = 3;     // máy chủ trả lỗi (không phải mất mạng): thử tối đa chừng này lần rồi giữ lại chờ bấm gửi lại
  const SHOW_LAST = 30;               // số ảnh gần nhất hiện trong danh sách
  const BLUR_VAR_MIN = 18;            // độ nét (phương sai Laplace trên ảnh 200px) thấp hơn mức này thì cảnh báo mờ
  const DARK_MEAN_MIN = 45;           // độ sáng trung bình (0-255) thấp hơn mức này thì cảnh báo tối

  const g = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const fold = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
  const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const pad = n => String(n).padStart(2, '0');
  const dry = () => /photodry/i.test(location.hash);

  const P = {
    store: null, tote: '', lastTote: '', stores: [], storesAt: 0,
    plan: null, planAt: 0, trips: [], trip: null,          // truck plan hôm nay + các chuyến của cửa hàng đang chọn + chuyến đang chọn
    stream: null, track: null, torch: false, starting: false,
    kbd: false, bound: false, busyShot: false, lastSubmit: 0,
    shots: [], sending: false, timer: null, pickTimer: null, scanTimer: null,
  };

  function beep(ok) {
    try {
      navigator.vibrate && navigator.vibrate(ok ? 40 : [80, 60, 80]);
      const a = new (window.AudioContext || window.webkitAudioContext)(), o = a.createOscillator(), v = a.createGain();
      o.frequency.value = ok ? 1000 : 300; v.gain.value = .15; o.connect(v); v.connect(a.destination); o.start(); o.stop(a.currentTime + (ok ? .08 : .3));
    } catch {}
  }

  const visible = () => !g('view-photo').hidden;

  // ---------- Danh sách cửa hàng (Google Sheet đã xuất bản dạng CSV, tab Store: cột A STORE ID, cột B STORE NAME) ----------
  const SHEET = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTep-iGhHUh0oyxUZZQj8Z_UoEH5ZdS_y3HnLVGiTXUBaWflEliVaTUWo9C9poXatzwZ9I4wV5hdeTi/pub';
  const STORE_URL = SHEET + '?gid=99054321&single=true&output=csv';
  const STORE_FRESH_MS = 6 * 3600 * 1000;

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

  async function loadStores() {
    const c = load('ph:stores', null);
    if (c && Array.isArray(c.list) && !P.stores.length) { P.stores = c.list; P.storesAt = c.at || 0; }
    if (P.stores.length && Date.now() - P.storesAt < STORE_FRESH_MS) return;
    try {
      const r = await fetch(STORE_URL + '&t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const list = [];
      parseCSV(await r.text()).slice(1).forEach(x => {
        const id = (x[0] || '').trim().toUpperCase();
        if (!/^[A-Z]{2}\d{4}$/.test(id)) return;
        list.push({ id, num: id.slice(2), name: (x[1] || '').trim().replace(new RegExp('^' + id + '\\s*', 'i'), '') });
      });
      if (list.length) { P.stores = list; P.storesAt = Date.now(); save('ph:stores', { at: P.storesAt, list }); }
    } catch { /* dùng bản đã lưu; không có thì cho nhập số cửa hàng 4 chữ số */ }
  }

  // Khớp theo số cửa hàng (bỏ chữ VN): số đúng -> đầu số -> chứa số -> tên
  function matchStores(raw) {
    const q = fold(raw.trim()).replace(/^vn/, '').replace(/\s+/g, '');
    if (!q) return [];
    const sc = s => s.num === q ? 0 : s.num.startsWith(q) ? 1 : s.num.includes(q) ? 2 : fold(s.name).includes(q) ? 3 : 9;
    return P.stores.map(s => [sc(s), s]).filter(x => x[0] < 9).sort((a, b) => a[0] - b[0] || (a[1].num < b[1].num ? -1 : 1)).map(x => x[1]);
  }

  // ---------- Truck plan (lịch chuyến hôm nay, lấy từ proxy ảnh) ----------
  const PLAN_FRESH_MS = 10 * 60 * 1000;
  const ymdLocal = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const dmy = s => String(s || '').split('-').reverse().join('/');
  const planTrips = () => (P.plan && Array.isArray(P.plan.trips)) ? P.plan.trips : [];
  const tripsOfStore = id => planTrips().filter(t => t.stores.indexOf(id) !== -1);
  const tripLabel = t => 'Chuyến ' + t.trip + (t.type ? ' · ' + t.type : '');
  const storeById = id => P.stores.find(s => s.id === id) || { id, num: id.slice(2), name: '' };

  async function loadPlan(force) {
    const c = load('ph:plan', null);
    if (c && c.plan && !P.plan) { P.plan = c.plan; P.planAt = c.at || 0; }
    if (!force && P.plan && Date.now() - P.planAt < PLAN_FRESH_MS) return;
    if (!/^https:\/\//i.test(PHOTO_URL) || typeof S === 'undefined' || !S.emp) return;
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 30000);
    try {
      const res = await proxyFetch(PHOTO_URL, { action: 'getTripPlan', emp: S.emp.id }, ctl.signal);
      const d = res.ok ? await res.json() : null;
      if (d && d.ok) { P.plan = d; P.planAt = Date.now(); save('ph:plan', { at: P.planAt, plan: d }); }
    } catch { /* mất mạng: dùng bản đã lưu (nếu có) */ }
    clearTimeout(tm);
  }

  // ---------- Danh sách chọn cửa hàng: LUÔN hiện bên dưới ô quét/nhập ----------
  //  - ô trống + có lịch chuyến: cửa hàng hôm nay gom theo chuyến (bấm chuyến để mở);
  //  - ô trống + chưa có lịch: một đoạn đầu danh sách cửa hàng;
  //  - đang gõ/quét: các cửa hàng khớp (kèm chuyến hôm nay nếu có).
  function storeBtn(s, withTrip) {
    const ts = withTrip ? tripsOfStore(s.id) : [];
    return '<button type="button" class="sg" data-id="' + esc(s.id) + '"><b>' + esc(s.id) + '</b><small>' + esc(s.name) + '</small>' +
      (ts.length ? '<span class="ph-badges">' + ts.map(t => '<i>C' + esc(t.trip) + (t.type ? ' ' + esc(t.type) : '') + '</i>').join('') + '</span>' : '') + '</button>';
  }
  function renderSugg() {
    const box = g('phSugg'), raw = g('phQ').value.trim(), msg = g('phQMsg');
    msg.textContent = '';
    if (raw) {
      const ms = matchStores(raw).slice(0, 40);
      box.innerHTML = ms.length ? ms.map(s => storeBtn(s, true)).join('') : '<div class="sg-note">' + (P.stores.length ? 'Không có cửa hàng khớp.' : 'Chưa tải được danh sách cửa hàng: nhập đủ 4 chữ số (vd 0052) rồi Enter.') + '</div>';
      return;
    }
    const trips = planTrips();
    if (trips.length) {
      const today = ymdLocal(new Date());
      if (P.plan.date && P.plan.date !== today) msg.textContent = 'Lịch chuyến đang là ngày ' + dmy(P.plan.date) + ' (chưa cập nhật cho hôm nay?)';
      const open = new Set([...box.querySelectorAll('details[open]')].map(d => d.dataset.t));   // giữ các chuyến đang mở khi vẽ lại
      box.innerHTML = '<div class="ph-plan-h">Lịch chuyến' + (P.plan.date ? ' ' + dmy(P.plan.date) : '') + ' · gõ hoặc quét số cửa hàng ở ô trên</div>' +
        trips.map(t => '<details class="ph-trip-g" data-t="' + esc(t.trip) + '"' + (open.has(String(t.trip)) ? ' open' : '') + '><summary><b>' + esc(tripLabel(t)) + '</b> · ' + t.stores.length + ' CH' +
          '<small>' + [t.truck, t.plate, t.driver].filter(Boolean).map(esc).join(' · ') + '</small></summary>' +
          t.stores.map(id => storeBtn(storeById(id), false)).join('') + '</details>').join('');
      return;
    }
    if (P.plan && P.plan.note) msg.textContent = 'Lịch chuyến: ' + P.plan.note;
    const all = P.stores.slice(0, 60);
    box.innerHTML = all.length ? '<div class="ph-plan-h">Gõ hoặc quét số cửa hàng, hoặc chọn trong danh sách</div>' + all.map(s => storeBtn(s, false)).join('') + (P.stores.length > 60 ? '<div class="sg-note">… còn ' + (P.stores.length - 60) + ' cửa hàng, gõ để lọc</div>' : '')
      : '<div class="sg-note">Chưa tải được danh sách cửa hàng: nhập đủ 4 chữ số (vd 0052) rồi Enter.</div>';
  }

  function onQInput() {
    clearTimeout(P.pickTimer);
    renderSugg();
    const q = g('phQ').value.replace(/\D/g, ''), ms = matchStores(g('phQ').value);
    // Gõ/quét ĐÚNG số cửa hàng 4 chữ số và chỉ có 1 kết quả: tự chọn sau 0,35 giây không gõ thêm
    if (q.length === 4 && ms.length && ms[0].num === q && (ms.length === 1 || ms[1].num !== q)) {
      const s = ms[0]; P.pickTimer = setTimeout(() => { if (g('phQ').value.replace(/\D/g, '') === q && !P.store) pickStore(s); }, 350);
    }
  }
  function onQKey(e) {
    if (e.key !== 'Enter') return;
    e.preventDefault(); clearTimeout(P.pickTimer);
    const raw = g('phQ').value.trim(); if (!raw) return;
    const ms = matchStores(raw), q = raw.replace(/\D/g, '');
    if (ms.length && (ms.length === 1 || ms[0].num === q)) { pickStore(ms[0]); return; }
    if (!P.stores.length && /^\d{4}$/.test(q)) { pickStore({ id: 'VN' + q, num: q, name: '' }); return; } // chưa có danh sách: chấp nhận số 4 chữ số
    beep(false); g('phQMsg').textContent = ms.length ? 'Có nhiều cửa hàng khớp, bấm chọn một cửa hàng.' : 'Không có cửa hàng khớp.';
  }

  function pickStore(s) {
    if (!s) return;
    clearTimeout(P.pickTimer);
    P.store = s; P.tote = ''; P.lastTote = '';
    P.trips = tripsOfStore(s.id); P.trip = P.trips.length === 1 ? P.trips[0] : null;   // 1 chuyến: tự chọn; từ 2 chuyến (chill + frozen): phải chọn
    g('phQ').value = ''; g('phSugg').innerHTML = ''; g('phQMsg').textContent = '';
    g('phPick').hidden = true; g('phWork').hidden = false;
    g('phStore').innerHTML = '<b>' + esc(s.id) + '</b>' + (s.name ? ' · ' + esc(s.name) : '');
    beep(true); renderTrips(); renderTote(); renderList(); startCam(); focusScan();
  }
  function backToPick() {
    P.store = null; P.tote = ''; P.lastTote = ''; P.trips = []; P.trip = null;
    stopCam();
    g('phWork').hidden = true; g('phPick').hidden = false;
    focusQ(); loadPlan().then(() => { if (!P.store && visible()) renderSugg(); });
  }

  // Chuyến của cửa hàng đang chọn (từ truck plan). Từ 2 chuyến thì bắt chọn trước khi chụp.
  function renderTrips() {
    const box = g('phTrips');
    if (P.trips.length) {
      box.innerHTML = P.trips.map(t => '<button type="button" class="ph-trip' + (P.trip === t ? ' on' : '') + '" data-t="' + esc(t.trip) + '">' + esc(tripLabel(t)) +
        (P.trips.length === 1 ? '' : '<small>' + [t.plate, t.driver].filter(Boolean).map(esc).join(' · ') + '</small>') + '</button>').join('') +
        (P.trip ? '<div class="ph-tinfo">' + [P.trip.truck, P.trip.plate, P.trip.driver].filter(Boolean).map(esc).join(' · ') + '</div>' : '<div class="ph-tinfo warn">Cửa hàng đi ' + P.trips.length + ' chuyến: chọn chuyến của rổ này</div>');
    } else if (planTrips().length) {
      box.innerHTML = '<div class="ph-tinfo warn">Cửa hàng không có trong lịch chuyến hôm nay (vẫn chụp được)</div>';
    } else box.innerHTML = '';
  }
  const needTrip = () => P.trips.length >= 2 && !P.trip;
  const canShoot = () => !!P.store && !P.busyShot && !needTrip();      // mã rổ KHÔNG bắt buộc: chỉ cần cửa hàng (và chuyến nếu cửa hàng đi từ 2 chuyến)

  // ---------- Quét mã rổ ----------
  // Cùng quy tắc với app Tote Tracking: bắt đầu bằng TOT/BAS, kết thúc bằng số, tối đa 20 ký tự, không dính 2 mã.
  const isTote = c => c.length <= 20 && /^(TOT|BAS)/.test(c) && /\d$/.test(c) && !/.(TOT|BAS)/.test(c);
  const isStoreCode = c => /^[A-Z]{2}\d{4}$/.test(c);

  function submitTote(raw) {
    P.lastSubmit = Date.now();
    const c = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
    if (isStoreCode(c)) { beep(false); say('Đây là mã cửa hàng. Muốn đổi cửa hàng thì bấm "Đổi cửa hàng".', 'bad'); return; }
    if (!isTote(c)) { beep(false); P.tote = ''; renderTote(); say('Mã quét không phải mã rổ: ' + c + ' (bỏ qua cũng được, vẫn bấm CHỤP)', 'bad'); return; }
    P.tote = c; beep(true); renderTote();
  }
  // Quét xong rổ mà chưa có camera thì vẫn cho quét, nút CHỤP chỉ sáng khi có cả rổ lẫn camera
  function renderTote() {
    const t = g('phTote');
    if (P.tote) { t.className = 'ph-tote ok'; t.innerHTML = 'RỔ <b>' + esc(P.tote) + '</b> · ' + (needTrip() ? 'chọn chuyến rồi bấm CHỤP' : 'bấm CHỤP'); }
    else { t.className = 'ph-tote'; t.textContent = needTrip() ? 'Chọn chuyến rồi bấm CHỤP (quét mã rổ nếu có)' : 'Quét mã rổ (nếu có) rồi bấm CHỤP'; }
    g('phShot').disabled = !canShoot();
    g('phMore').hidden = !!P.tote || !P.lastTote;
    if (!P.tote && P.lastTote) g('phMore').textContent = '+ Chụp thêm ảnh rổ ' + P.lastTote;
  }
  function say(msg, cls) { const t = g('phTote'); t.className = 'ph-tote ' + (cls || ''); t.textContent = msg; }

  // ---------- Camera ----------
  const wantCam = () => visible() && !!P.store && !document.hidden && !!(typeof S !== 'undefined' && S.emp);

  async function startCam() {
    if (P.stream || P.starting || !wantCam()) return;
    const msg = g('phCamMsg');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { msg.textContent = 'Trình duyệt không có camera (cần mở bằng https).'; return; }
    P.starting = true; msg.textContent = 'Đang mở camera…';
    try {
      const st = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
      if (!wantCam()) { st.getTracks().forEach(t => t.stop()); P.starting = false; msg.textContent = ''; return; }
      P.stream = st; P.track = st.getVideoTracks()[0]; P.torch = false;
      const v = g('phVideo'); v.srcObject = st; try { await v.play(); } catch {}
      const caps = P.track.getCapabilities ? P.track.getCapabilities() : {};
      g('phTorch').hidden = !caps.torch; g('phTorch').classList.remove('on');
      try { if (caps.focusMode && caps.focusMode.includes('continuous')) await P.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch {}
      msg.textContent = '';
    } catch (e) {
      P.stream = null; P.track = null;
      msg.textContent = 'Không mở được camera: ' + (e && e.name ? e.name + ' - ' : '') + ((e && e.message) || e) + '. Kiểm tra quyền Camera của trang.';
    }
    P.starting = false;
  }
  function stopCam() {
    try { if (P.stream) P.stream.getTracks().forEach(t => t.stop()); } catch {}
    P.stream = null; P.track = null; P.torch = false;
    const v = g('phVideo'); if (v) v.srcObject = null;
  }
  async function toggleTorch() {
    if (!P.track) return;
    try { await P.track.applyConstraints({ advanced: [{ torch: !P.torch }] }); P.torch = !P.torch; g('phTorch').classList.toggle('on', P.torch); }
    catch { toast('Máy không bật được đèn'); }
  }

  // ---------- Chụp, nén, đóng dấu ----------
  // Ưu tiên chụp ảnh đầy đủ độ phân giải (ImageCapture); không có thì lấy khung hình từ video.
  async function grab() {
    if (window.ImageCapture && P.track) {
      try { const blob = await new ImageCapture(P.track).takePhoto(); return await createImageBitmap(blob); } catch { /* dùng khung hình video */ }
    }
    const v = g('phVideo');
    if (!v.videoWidth) throw new Error('Camera chưa sẵn sàng');
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    return c;
  }

  // Độ sáng trung bình + độ nét (phương sai Laplace) trên bản thu nhỏ 200px, chỉ để cảnh báo
  function quality(cv) {
    const w = 200, h = Math.max(1, Math.round(cv.height * w / cv.width));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(cv, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data, gr = new Float32Array(w * h);
    let mean = 0;
    for (let i = 0; i < w * h; i++) { gr[i] = d[i * 4] * .299 + d[i * 4 + 1] * .587 + d[i * 4 + 2] * .114; mean += gr[i]; }
    mean /= w * h;
    let s = 0, s2 = 0, n = 0;
    for (let yy = 1; yy < h - 1; yy++) for (let xx = 1; xx < w - 1; xx++) {
      const i = yy * w + xx, l = gr[i - 1] + gr[i + 1] + gr[i - w] + gr[i + w] - 4 * gr[i];
      s += l; s2 += l * l; n++;
    }
    return { mean, sharp: n ? s2 / n - (s / n) * (s / n) : 0 };
  }

  function stamp(ctx, W, H, lines) {
    const fs = Math.max(14, Math.round(W * 0.022)), lh = Math.round(fs * 1.3), pd = Math.round(fs * 0.5);
    ctx.font = 'bold ' + fs + 'px -apple-system,Segoe UI,Roboto,Arial,sans-serif'; ctx.textBaseline = 'top';
    const w = Math.max.apply(null, lines.map(t => ctx.measureText(t).width)) + pd * 2, h = lh * lines.length + pd * 2 - (lh - fs);
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, H - h, w, h);
    ctx.fillStyle = '#fff';
    lines.forEach((t, i) => ctx.fillText(t, pd, H - h + pd + i * lh));
  }

  async function renderPhoto(src, meta) {
    const sw = src.width, sh = src.height, k = Math.min(1, PHOTO_MAX_EDGE / Math.max(sw, sh));
    const W = Math.round(sw * k), H = Math.round(sh * k);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(src, 0, 0, W, H);
    if (src.close) try { src.close(); } catch {}
    const q = quality(cv);
    const d = new Date(meta.takenAt);
    stamp(ctx, W, H, [
      meta.store + (meta.storeName ? ' · ' + meta.storeName : '') + (meta.trip ? '  |  Chuyến ' + meta.trip + (meta.tripType ? ' ' + meta.tripType : '') + (meta.plate ? ' · ' + meta.plate : '') : ''),
      (meta.tote ? meta.tote + '   ' : '') + pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()),
      'NV: ' + meta.empName + ' (' + meta.emp + ')' + (meta.dev ? ' · ' + meta.dev : ''),
    ]);
    const blob = await new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error('Không nén được ảnh')), 'image/jpeg', PHOTO_JPEG_QUALITY));
    const warn = [];
    if (q.mean < DARK_MEAN_MIN) warn.push('TỐI');
    if (q.sharp < BLUR_VAR_MIN) warn.push('MỜ');
    return { blob, warn };
  }

  async function capture() {
    if (!canShoot() || !P.store) return;
    if (!P.stream) { toast('Camera chưa sẵn sàng'); startCam(); return; }
    const e = S.emp; if (!e) return;
    P.busyShot = true; g('phShot').disabled = true;
    try {
      const meta = { id: 'P' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), emp: e.id, empName: e.name,
        store: P.store.id, storeName: P.store.name, tote: P.tote, takenAt: Date.now(), dev: getDev(),
        trip: P.trip ? String(P.trip.trip) : '', tripType: P.trip ? (P.trip.type || '') : '', plate: P.trip ? (P.trip.plate || '') : '', driver: P.trip ? (P.trip.driver || '') : '' };
      const src = await grab();
      const { blob, warn } = await renderPhoto(src, meta);
      const item = { ...meta, blob, kb: Math.round(blob.size / 1024), note: warn.length ? warn.join('/') + '?' : '', tries: 0, dead: false, err: '' };
      await idb.put(item);
      addShot(item);
      beep(true);
      P.lastTote = P.tote; P.tote = '';
      renderTote();
      const t = g('phTote'); t.className = 'ph-tote ok'; t.innerHTML = 'Đã lưu ✓ <b>' + esc(item.tote || 'không mã rổ') + '</b> (' + item.kb + ' KB)' + (warn.length ? ' <span class="ph-warn">⚠ Ảnh có thể ' + esc(warn.join('/')).toLowerCase() + ', nên chụp thêm</span>' : '');
      if (warn.length) beep(false);
      pump();
    } catch (err) {
      beep(false); toast('Chụp lỗi: ' + (err.message || err));
    }
    P.busyShot = false;
    if (g('phShot')) g('phShot').disabled = !canShoot();
    focusScan();
  }

  // ---------- Hàng đợi ảnh trên máy (IndexedDB) ----------
  const idb = {
    db: null,
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((res, rej) => {
        const r = indexedDB.open('whphoto', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('queue', { keyPath: 'id' });
        r.onsuccess = () => { this.db = r.result; res(this.db); };
        r.onerror = () => rej(r.error);
      });
    },
    async tx(mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => { const t = db.transaction('queue', mode), rq = fn(t.objectStore('queue')); t.oncomplete = () => res(rq && rq.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
    },
    put(it) { return this.tx('readwrite', s => s.put(it)); },
    del(id) { return this.tx('readwrite', s => s.delete(id)); },
    all() { return this.tx('readonly', s => s.getAll()).then(a => a || []); },
  };

  // ---------- Danh sách ảnh đã chụp (chỉ trong lần mở app này) ----------
  function addShot(it, st) {
    P.shots.unshift({ id: it.id, tote: it.tote, store: it.store, at: it.takenAt, url: URL.createObjectURL(it.blob), st: st || 'wait', msg: it.err || '', kb: it.kb, note: it.note });
    while (P.shots.length > SHOW_LAST) { const o = P.shots.pop(); try { URL.revokeObjectURL(o.url); } catch {} }
    renderList();
  }
  function setShot(id, st, msg) {
    const s = P.shots.find(x => x.id === id);
    if (s) { s.st = st; s.msg = msg || ''; renderList(); }
  }
  const ST = { wait: 'Chờ gửi', send: 'Đang gửi…', ok: '✓ Đã gửi', err: 'Lỗi, bấm để gửi lại' };
  function renderList() {
    const box = g('phList');
    box.innerHTML = P.shots.map(s => {
      const d = new Date(s.at);
      return '<div class="ph-row ' + s.st + '" data-id="' + esc(s.id) + '"><img src="' + s.url + '" alt=""><div class="ph-info"><b>' + esc(s.tote || 'Không có mã rổ') + '</b><small>' + esc(s.store) + ' · ' +
        pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + ' · ' + s.kb + ' KB' + (s.note ? ' · ⚠ ' + esc(s.note) : '') + '</small>' +
        (s.msg ? '<small class="ph-msg">' + esc(s.msg) + '</small>' : '') + '</div><span class="ph-st">' + ST[s.st] + '</span></div>';
    }).join('');
    updateQInfo();
  }
  async function updateQInfo() {
    const box = g('phQInfo'); if (!box) return;
    let n = 0, dead = 0;
    try { const a = await idb.all(); n = a.length; dead = a.filter(x => x.dead).length; } catch {}
    box.hidden = !n && !dry();
    box.innerHTML = (dry() ? '<b>CHẾ ĐỘ THỬ:</b> ảnh KHÔNG gửi lên Drive. ' : '') +
      (n ? 'Còn <b>' + n + '</b> ảnh chưa gửi' + (dead ? ' (' + dead + ' lỗi)' : '') + ' <button type="button" class="ghost" id="phRetry">Gửi ngay</button>' : '');
  }

  // ---------- Gửi ảnh lên proxy ----------
  const toB64 = blob => new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(String(f.result).split(',')[1] || ''); f.onerror = () => rej(f.error); f.readAsDataURL(blob); });

  async function pump() {
    if (P.sending) return;
    P.sending = true; clearTimeout(P.timer);
    let retryIn = 0;
    try {
      for (;;) {
        const items = (await idb.all()).filter(i => !i.dead).sort((a, b) => a.takenAt - b.takenAt);
        if (!items.length) break;
        const r = await sendOne(items[0]);
        if (r.retry) { retryIn = r.retry; break; }
      }
    } catch { retryIn = 15000; }
    P.sending = false;
    if (retryIn) P.timer = setTimeout(pump, retryIn);
    updateQInfo();
  }

  // Trả { retry: ms } nếu phải dừng và thử lại sau; {} nếu xong (hoặc đã đánh dấu lỗi, đi tiếp ảnh khác)
  async function sendOne(it) {
    setShot(it.id, 'send');
    if (dry()) { await idb.del(it.id); setShot(it.id, 'ok', 'thử, không gửi'); return {}; }
    const fail = async (msg, transient) => {
      it.tries = (it.tries || 0) + 1; it.err = msg;
      if (!transient && it.tries >= SERVER_ERR_MAX_TRIES) it.dead = true;
      await idb.put(it);
      setShot(it.id, it.dead ? 'err' : 'wait', msg);
      if (it.dead) return {};
      return { retry: Math.min(60000, 5000 * Math.pow(2, Math.min(it.tries, 4))) };
    };
    if (!/^https:\/\//i.test(PHOTO_URL)) return fail('Chưa cấu hình địa chỉ máy chủ ảnh (PHOTO_URL trong photo.js), ảnh được giữ lại trên máy', true);
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), UPLOAD_TIMEOUT_MS);
    netStart();
    try {
      const image = await toB64(it.blob);
      const res = await proxyFetch(PHOTO_URL, { action: 'uploadPhoto', emp: it.emp, photoId: it.id, store: it.store, storeName: it.storeName,
        tote: it.tote, takenAt: it.takenAt, note: it.note || '', trip: it.trip || '', tripType: it.tripType || '', plate: it.plate || '', driver: it.driver || '', image }, ctl.signal);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (data && data.__error) {
        const m = String(data.__error);
        // Nhân viên không còn trong danh sách: gửi lại cũng vô ích
        if (/^NO_EMP/.test(m)) { it.dead = true; it.err = 'Mã nhân viên không còn hợp lệ'; await idb.put(it); setShot(it.id, 'err', it.err); return {}; }
        // Máy chủ ảnh chưa có chức năng này (chưa dán lại Code.gs / chưa tạo phiên bản mới)
        if (/Hành động không hợp lệ/i.test(m)) return fail('Máy chủ ảnh chưa cập nhật (báo quản trị viên)', false);
        return fail(m, false);
      }
      if (data && data.ok) { await idb.del(it.id); setShot(it.id, 'ok'); return {}; }
      return fail('Máy chủ trả kết quả lạ', false);
    } catch (e) {
      return fail(e.name === 'AbortError' ? 'Quá thời gian gửi, sẽ thử lại' : 'Mất mạng hoặc máy chủ bận, sẽ thử lại', true);
    } finally { clearTimeout(tm); netDone(); }
  }

  async function retryAll() {
    try { const a = await idb.all(); for (const it of a) { if (it.dead) { it.dead = false; it.tries = 0; await idb.put(it); setShot(it.id, 'wait'); } } } catch {}
    pump();
  }

  // Mở lại app: ảnh còn trong hàng đợi (lần trước chưa gửi xong) hiện lại trong danh sách và được gửi tiếp
  async function restoreQueue() {
    try {
      (await idb.all()).sort((a, b) => a.takenAt - b.takenAt).forEach(it => { if (!P.shots.some(s => s.id === it.id)) addShot(it, it.dead ? 'err' : 'wait'); });
    } catch {}
    pump();
  }

  // ---------- Điều khiển giao diện ----------
  function focusQ() { const i = g('phQ'); if (!i) return; i.value = ''; renderSugg(); setTimeout(() => i.focus(), 30); }
  function focusScan() { const i = g('phScan'); if (!i) return; i.value = ''; setTimeout(() => i.focus(), 30); }

  function show() {
    bind();
    g('phDry').hidden = !dry();
    loadStores().then(() => { if (!P.store && visible()) renderSugg(); });
    loadPlan().then(() => { if (visible()) { if (P.store && !P.trips.length) { P.trips = tripsOfStore(P.store.id); P.trip = P.trips.length === 1 ? P.trips[0] : null; renderTrips(); renderTote(); } else if (!P.store) renderSugg(); } });
    if (P.store) { startCam(); focusScan(); } else focusQ();
    renderList(); pump();
  }
  function hide() { stopCam(); }
  // Đổi người / hết phiên: bỏ cửa hàng + rổ đang chọn, tắt camera (ảnh trong hàng đợi vẫn giữ và vẫn gửi theo đúng người đã chụp)
  function reset() {
    clearTimeout(P.pickTimer); clearTimeout(P.scanTimer);
    P.store = null; P.tote = ''; P.lastTote = ''; P.trips = []; P.trip = null;
    stopCam();
    if (g('phWork')) { g('phWork').hidden = true; g('phPick').hidden = false; g('phQ').value = ''; }
  }
  function init() { bind(); restoreQueue(); }

  function bind() {
    if (P.bound) return; P.bound = true;
    g('phQ').oninput = onQInput;
    g('phQ').onkeydown = onQKey;
    g('phBack').onclick = backToPick;
    g('phSugg').onclick = e => { const b = e.target.closest('.sg[data-id]'); if (b) pickStore(storeById(b.dataset.id)); };
    g('phTrips').onclick = e => {
      const b = e.target.closest('.ph-trip'); if (!b) return;
      const t = P.trips.find(x => String(x.trip) === b.dataset.t);
      if (t) { P.trip = t; beep(true); renderTrips(); renderTote(); }
      focusScan();
    };
    g('phShot').onclick = capture;
    g('phTorch').onclick = toggleTorch;
    g('phMore').onclick = () => { if (P.lastTote) { P.tote = P.lastTote; beep(true); renderTote(); focusScan(); } };
    g('phQInfo').onclick = e => { if (e.target.closest('#phRetry')) retryAll(); };
    g('phList').onclick = e => { const r = e.target.closest('.ph-row.err'); if (r) retryAll(); };
    // Máy quét PDA có thể gửi Enter hoặc không: không có Enter thì tự gửi sau khi mã ngừng chạy vào ô (~150ms).
    g('phScan').oninput = () => {
      clearTimeout(P.scanTimer);
      if (P.kbd) return;
      P.scanTimer = setTimeout(() => {
        const i = g('phScan'), raw = i.value.trim();
        if (raw.length >= 6) { i.value = ''; submitTote(raw); }
      }, 150);
    };
    g('phScan').onkeydown = e => {
      if (e.key !== 'Enter') return;
      clearTimeout(P.scanTimer);
      const raw = e.target.value.trim(); e.target.value = '';
      if (raw) { submitTote(raw); return; }
      // Enter trống = chụp (bỏ qua Enter đi kèm ngay sau một lần quét)
      if (Date.now() - P.lastSubmit > 600 && canShoot()) capture();
    };
    const kbd = () => { P.kbd = !P.kbd; ['phScan', 'phQ'].forEach(id => g(id).inputMode = P.kbd ? 'text' : 'none'); const i = P.store ? g('phScan') : g('phQ'); i.blur(); i.focus(); };
    g('phKbd').onclick = kbd; g('phKbd2').onclick = kbd;
    // PDA hay mất focus sau khi bấm nút: quay lại ô quét
    document.addEventListener('click', e => {
      if (visible() && !e.target.closest('input,dialog,.rail,#phSugg')) setTimeout(() => { if (visible()) (P.store ? g('phScan') : g('phQ')).focus(); }, 50);
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopCam(); else if (wantCam()) startCam(); });
    window.addEventListener('online', pump);
  }

  // lookup.js (màn Tra ảnh) dùng lại địa chỉ proxy ảnh + danh sách cửa hàng
  return { show, hide, reset, init, url: PHOTO_URL, stores: async () => { await loadStores(); return P.stores; }, match: matchStores };
})();
