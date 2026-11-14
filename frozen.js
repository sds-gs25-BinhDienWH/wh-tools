'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const fold = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

const S = { data: null, po: null, filter: 'todo', last: null, kbd: false };
// Tiến độ lưu theo PO trên máy: {counts:{mã:số đã quét}, done:bool}. Mã ngoài PO cũng được đếm (coi là thừa).
const key = po => 'frozen:' + S.data.date + ':' + po;
const prog = po => load(key(po), { counts: {}, done: false });
const norm = c => String(c).replace(/\s+/g, '').replace(/^0+(?=\d)/, '');

function beep(ok) {
  try {
    navigator.vibrate && navigator.vibrate(ok ? 40 : [80, 60, 80]);
    const a = new (window.AudioContext || window.webkitAudioContext)(), o = a.createOscillator(), g = a.createGain();
    o.frequency.value = ok ? 1000 : 300; g.gain.value = .15; o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + (ok ? .08 : .3));
  } catch {}
}

async function init() {
  try {
    const r = await fetch('frozen-data.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    S.data = await r.json();
  } catch (e) { $('#poList').innerHTML = '<p>Không tải được dữ liệu PO (' + esc(e.message) + ').</p>'; return; }
  S.data.pos.forEach(p => { p.map = new Map(p.items.map(i => [norm(i[0]), i])); p.total = p.items.reduce((a, i) => a + i[2], 0); });
  showList();
}

function status(p) {
  const c = prog(p.po).counts, pr = prog(p.po);
  let got = 0, diff = false, any = false;
  for (const [k, n] of Object.entries(c)) { any = true; if (!p.map.has(k)) diff = true; }
  for (const it of p.items) { const n = c[norm(it[0])] || 0; got += Math.min(n, it[2]); if (n !== it[2]) diff = true; }
  return { got, any, diff, done: pr.done };
}

// ---------- Danh sách PO ----------
function showList() {
  S.po = null; $('#vList').hidden = false; $('#vCheck').hidden = true; $('#back').hidden = true;
  $('#title').innerHTML = 'Kiểm hàng đông<small>PO ngày ' + esc(S.data.date) + '</small>';
  renderList(); $('#q').focus();
}
function renderList() {
  const q = fold($('#q').value.trim());
  const ps = S.data.pos.filter(p => !q || fold(p.store + ' ' + p.storeName + ' ' + p.po).includes(q));
  const done = S.data.pos.filter(p => prog(p.po).done).length;
  $('#meta').textContent = ps.length + '/' + S.data.pos.length + ' PO · đã kiểm xong ' + done;
  $('#poList').innerHTML = ps.map(p => {
    const s = status(p);
    const b = s.done ? (s.diff ? '<span class="badge bad">Lệch</span>' : '<span class="badge ok">Đủ</span>')
      : s.any ? '<span class="badge wip">' + s.got + '/' + p.total + '</span>' : '<span class="badge">' + p.total + ' sp</span>';
    return '<div class="po" data-po="' + esc(p.po) + '"><div><b>' + esc(p.store) + ' · ' + esc(p.storeName) + '</b><small>' + esc(p.po) + ' · ' + p.items.length + ' mã</small></div>' + b + '</div>';
  }).join('') || '<p>Không có PO nào khớp.</p>';
}
$('#poList').onclick = e => { const el = e.target.closest('.po'); if (el) openPO(el.dataset.po); };
$('#q').oninput = renderList;
$('#q').onkeydown = e => { // quét mã cửa hàng/PO + Enter: nếu chỉ còn 1 PO thì vào luôn
  if (e.key !== 'Enter') return;
  const q = fold($('#q').value.trim()); if (!q) return;
  const ps = S.data.pos.filter(p => fold(p.store + ' ' + p.po).includes(q));
  if (ps.length === 1) openPO(ps[0].po);
};
$('#reload').onclick = () => location.reload();

// ---------- Kiểm một PO ----------
function openPO(po) {
  S.po = S.data.pos.find(p => p.po === po); S.last = null; S.filter = 'todo';
  $('#vList').hidden = true; $('#vCheck').hidden = false; $('#back').hidden = false; $('#last').hidden = true;
  $('#title').innerHTML = esc(S.po.store) + ' · ' + esc(S.po.storeName) + '<small>' + esc(S.po.po) + '</small>';
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.f === S.filter));
  render(); focusScan();
}
$('#back').onclick = showList;
const focusScan = () => { const i = $('#scan'); i.value = ''; i.focus(); };

function state(it, n) { return n === it[2] ? 'ok' : n > it[2] ? 'bad' : n > 0 ? 'wip' : ''; }
function render(flashKey) {
  const p = S.po, c = prog(p.po).counts;
  let got = 0; p.items.forEach(it => got += Math.min(c[norm(it[0])] || 0, it[2]));
  const pct = p.total ? Math.round(got * 100 / p.total) : 0;
  $('#prog').innerHTML = 'Đã kiểm ' + got + '/' + p.total + ' sp (' + pct + '%)<div class="bar"><i style="width:' + pct + '%"></i></div>';
  const rows = p.items.map(it => ({ it, k: norm(it[0]), n: c[norm(it[0])] || 0 }));
  const extra = Object.keys(c).filter(k => !p.map.has(k) && c[k] > 0).map(k => ({ it: [k, 'Mã ngoài PO', 0], k, n: c[k] }));
  let list = rows.concat(extra);
  if (S.filter === 'todo') list = list.filter(r => r.n !== r.it[2]);
  if (S.filter === 'done') list = list.filter(r => r.n === r.it[2]);
  list.sort((a, b) => (b.k === flashKey) - (a.k === flashKey) || (b.n > 0) - (a.n > 0));
  $('#items').innerHTML = list.map(r => '<div class="it ' + state(r.it, r.n) + (r.k === flashKey ? ' flash' : '') + '" data-k="' + esc(r.k) + '"><div class="nm">' + esc(r.it[1]) +
    '<small>' + esc(r.it[0]) + '</small></div><div class="q">' + r.n + '<span> / ' + r.it[2] + '</span></div></div>').join('') || '<p>Không có dòng nào.</p>';
}
document.querySelector('.tabs').onclick = e => {
  const b = e.target.closest('button'); if (!b) return; S.filter = b.dataset.f;
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b)); render();
};

function setCount(k, n) {
  const pr = prog(S.po.po); n = Math.max(0, n);
  if (n) pr.counts[k] = n; else delete pr.counts[k];
  pr.done = false; save(key(S.po.po), pr);
}
function showLast(k) {
  const it = S.po.map.get(k), n = prog(S.po.po).counts[k] || 0, box = $('#last');
  const known = !!it, need = known ? it[2] : 0;
  const st = !known ? 'bad' : state(it, n);
  const msg = !known ? 'MÃ NGOÀI PO — không có trong đơn này'
    : n === need ? 'ĐỦ SỐ LƯỢNG: ' + n + '/' + need + ' ✓'
    : n > need ? 'THỪA ' + (n - need) + ' (đã quét ' + n + ', cần ' + need + ')'
    : 'Còn thiếu ' + (need - n) + ' (đã quét ' + n + ', cần ' + need + ')';
  box.className = 'last ' + st; box.hidden = false;
  box.innerHTML = '<div class="nm">' + esc(known ? it[1] : 'Mã ' + k) + '</div><div class="code">' + esc(known ? it[0] : k) + '</div>' +
    '<div class="big"><b>' + n + '</b><span>/ ' + need + '</span></div><div class="msg">' + esc(msg) + '</div>' +
    '<div class="adj"><button type="button" class="ghost" data-d="-1">−1</button><button type="button" class="ghost" data-d="set">Nhập số</button><button type="button" class="ghost" data-d="1">+1</button></div>';
  S.last = k;
}
$('#last').onclick = e => {
  const b = e.target.closest('button'); if (!b || !S.last) return; const k = S.last, cur = prog(S.po.po).counts[k] || 0;
  if (b.dataset.d === 'set') {
    const v = prompt('Số lượng thực tế của mã này:', cur); if (v === null) return;
    const n = parseInt(v, 10); if (isNaN(n) || n < 0) return; setCount(k, n);
  } else setCount(k, cur + parseInt(b.dataset.d, 10));
  showLast(k); render(k); focusScan();
};
$('#items').onclick = e => { const el = e.target.closest('.it'); if (el) { showLast(el.dataset.k); focusScan(); } };

$('#scan').onkeydown = e => {
  if (e.key !== 'Enter') return;
  const raw = e.target.value.trim(); e.target.value = ''; if (!raw) return;
  const k = norm(raw), it = S.po.map.get(k);
  setCount(k, (prog(S.po.po).counts[k] || 0) + 1);
  const n = prog(S.po.po).counts[k];
  beep(!!it && n <= it[2]); showLast(k); render(k);
};
$('#kbd').onclick = () => { S.kbd = !S.kbd; $('#scan').inputMode = S.kbd ? 'numeric' : 'none'; $('#scan').blur(); $('#scan').focus(); };
// PDA hay mất focus sau khi bấm nút: quay lại ô quét
document.addEventListener('click', e => { if (S.po && !$('#dlg').open && !e.target.closest('input,dialog')) setTimeout(() => $('#scan').focus(), 50); });

// ---------- Kết thúc ----------
function dialog(html, acts) {
  $('#dlgBody').innerHTML = html; const a = $('#dlgAct'); a.innerHTML = '';
  acts.forEach(([t, cls, fn]) => { const b = document.createElement('button'); b.textContent = t; if (cls) b.className = cls; b.onclick = () => { $('#dlg').close(); fn && fn(); }; a.appendChild(b); });
  $('#dlg').showModal();
}
$('#finish').onclick = () => {
  const p = S.po, c = prog(p.po).counts, lack = [], over = [];
  p.items.forEach(it => { const n = c[norm(it[0])] || 0; if (n < it[2]) lack.push(it[1] + ' — thiếu ' + (it[2] - n) + ' (' + n + '/' + it[2] + ')'); else if (n > it[2]) over.push(it[1] + ' — thừa ' + (n - it[2])); });
  Object.keys(c).filter(k => !p.map.has(k)).forEach(k => over.push('Mã ngoài PO ' + k + ' — ' + c[k]));
  const list = a => a.map(x => '<div>' + esc(x) + '</div>').join('');
  const ok = !lack.length && !over.length;
  dialog('<h3 style="margin:0">' + (ok ? 'Đủ hàng ✓' : 'Có chênh lệch') + '</h3><div>' + esc(p.store) + ' · ' + esc(p.po) + '</div>' +
    (lack.length ? '<b style="color:#C62828">Thiếu (' + lack.length + ')</b><div class="dlg-list">' + list(lack) + '</div>' : '') +
    (over.length ? '<b style="color:#B45309">Thừa (' + over.length + ')</b><div class="dlg-list">' + list(over) + '</div>' : ''),
    [['Kiểm tiếp', 'ghost'], ['Xác nhận xong', '', () => { const pr = prog(p.po); pr.done = true; save(key(p.po), pr); showList(); }]]);
};
$('#reset').onclick = () => dialog('<b>Xoá toàn bộ số đã quét của PO này và kiểm lại từ đầu?</b>',
  [['Không', 'ghost'], ['Làm lại', '', () => { save(key(S.po.po), { counts: {}, done: false }); S.last = null; $('#last').hidden = true; render(); focusScan(); }]]);

init();
