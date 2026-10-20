'use strict';
// Bảng theo dõi trên TV. Chỉ hiện số liệu CHUNG của cả kho: không tên người, không thời gian làm việc.
// Mở: https://<trang>/tv.html   (nếu proxy có DASH_KEY thì thêm  #key=<khoá>  vào cuối địa chỉ)

// Phải giống PROXY_URL trong app.js (đổi proxy thì sửa cả hai chỗ)
const PROXY_URL = 'https://script.google.com/macros/s/AKfycbyV5otbjq-5N00CMUl-7mbyC36Ztqf87C8IIzaIOiRjqwV_HGsKF7akzkFIjBcBO-VZNQ/exec';
const REFRESH_MS = 30000;          // tải lại số liệu mỗi 30 giây
const RELOAD_MS = 6 * 3600 * 1000; // tải lại cả trang mỗi 6 giờ để TV để cả tuần vẫn lấy bản mới
const LINES = ['A01','A02','A03','A04','A05','A06','A07','B08','B09','B10','B11','B12','B13','B14'];

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const hashKey = new URLSearchParams(location.hash.replace(/^#/, '')).get('key');
const KEY = hashKey || params.get('key') || '';
const BASE = params.get('api') || PROXY_URL;   // ?api=... chỉ để thử
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const fmt = n => Number(n || 0).toLocaleString('vi-VN');

function tickClock() {
  const d = new Date();
  $('clockTime').textContent = d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
  $('clockDate').textContent = d.toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
}

function render(d) {
  const p = d.pending;
  $('kA').textContent = p ? fmt(p.a) : '–';
  $('kB').textContent = p ? fmt(p.b) : '–';
  $('kItems').textContent = p ? fmt(p.items) : '–';
  $('kDone').textContent = fmt(d.today.done);
  $('kQty').textContent = d.today.qty ? fmt(d.today.qty) + ' sản phẩm' : '';
  $('kDoing').textContent = fmt(d.today.doing);

  // biểu đồ cột theo line
  const lines = p ? p.lines : {};
  const max = Math.max(1, ...LINES.map(l => lines[l] || 0));
  $('bars').innerHTML = LINES.map(l => {
    const v = lines[l] || 0, h = Math.round((v / max) * 100);
    return `<div class="bar ${l[0] === 'A' ? 'zA' : 'zB'}"><div class="v">${v ? fmt(v) : ''}</div>
      <div class="col" style="height:${v ? Math.max(h, 2) : 0}%"></div><div class="l">${l}</div></div>`;
  }).join('');

  // mã còn nhiều hàng chờ nhất
  const top = p ? p.top.slice(0, 6) : [];
  const tmax = Math.max(1, ...top.map(t => t.total));
  $('topList').innerHTML = !p ? '<div class="empty" style="color:var(--muted)">Chưa có dữ liệu</div>'
    : !top.length ? '<div class="empty">Không còn hàng chờ</div>'
    : top.map(t => `<div class="row"><div class="n">${esc(t.name)}</div><div class="t">${fmt(t.total)}</div>
        <div class="meter"><i style="width:${Math.round(t.total / tmax * 100)}%"></i></div></div>`).join('');
}

async function load() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    const res = await fetch(BASE, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'dashboard', key: KEY }), signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    if (d.__error) throw new Error(d.__error);
    render(d);
    $('dot').classList.remove('err');
    $('status').textContent = 'Cập nhật lúc ' + new Date().toLocaleTimeString('vi-VN', { hour12: false }) + ' · tự làm mới mỗi ' + REFRESH_MS / 1000 + ' giây';
  } catch (e) {
    // Lỗi thì giữ nguyên số liệu cũ trên TV, chỉ đổi dòng trạng thái ở chân trang
    $('dot').classList.add('err');
    $('status').textContent = 'Mất kết nối, đang thử lại… (' + (e.message || e) + ')';
  }
}

tickClock(); setInterval(tickClock, 1000);
load(); setInterval(load, REFRESH_MS);
setTimeout(() => location.reload(), RELOAD_MS);
