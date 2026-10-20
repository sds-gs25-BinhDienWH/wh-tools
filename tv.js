'use strict';
// Dashboard COLD WH Daily Progress (SAMSUNG SDS): tiến độ Actual / Plan (PCS), thống kê nhanh, Top 5 năng suất.
// Plan nhập ở tab "Plan" của Google Sheet (ô vàng B3 = số lượng PCS). Actual = số PCS đã hoàn thành hôm nay.
// Mở: https://<trang>/tv.html#key=<DASH_KEY>   (nếu proxy đã đặt DASH_KEY thì phải có #key=...)

// Phải giống PROXY_URL trong app.js (đổi proxy thì sửa cả hai chỗ)
const PROXY_URL = 'https://script.google.com/macros/s/AKfycbyV5otbjq-5N00CMUl-7mbyC36Ztqf87C8IIzaIOiRjqwV_HGsKF7akzkFIjBcBO-VZNQ/exec';
const REFRESH_MS = 30000;          // tải lại số liệu mỗi 30 giây
const RELOAD_MS = 6 * 3600 * 1000; // tải lại cả trang mỗi 6 giờ để TV để cả tuần vẫn lấy bản mới

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const KEY = new URLSearchParams(location.hash.replace(/^#/, '')).get('key') || params.get('key') || '';
const BASE = params.get('api') || PROXY_URL;   // ?api=... chỉ để thử
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const fmt = n => Number(n || 0).toLocaleString('vi-VN');

// Vòng tiến độ Actual/Plan (SVG), chỉ tính số lượng PCS. Chưa có plan thì chỉ hiện Actual và nhắc nhập Plan.
function renderRing(actual, plan) {
  const R = 78, C = 2 * Math.PI * R;
  const has = plan > 0;
  const pct = has ? Math.round(actual / plan * 100) : 0;
  const arc = has ? Math.min(pct, 100) / 100 * C : 0;
  $('ring').innerHTML = `<svg viewBox="0 0 200 200">
      <circle class="r-track" cx="100" cy="100" r="${R}"/>
      <circle class="r-bar" cx="100" cy="100" r="${R}" transform="rotate(-90 100 100)" stroke-dasharray="${arc} ${C}"/>
      <text class="r-pct" x="100" y="${has ? 108 : 112}">${has ? pct + '%' : '–'}</text>
      <text class="r-sub" x="100" y="130">${has ? 'ACTUAL / PLAN' : 'CHƯA CÓ PLAN'}</text></svg>
    <div class="r-info">
      <div class="r-row act"><span class="l">ACTUAL</span><span class="v">${fmt(actual)}</span></div>
      <div class="r-row"><span class="l">PLAN</span><span class="v">${has ? fmt(plan) : '–'}</span></div>
      ${has ? `<div class="r-row left"><span class="l">CÒN LẠI</span><span class="v">${fmt(Math.max(plan - actual, 0))}</span></div>`
            : '<div class="r-note">Nhập Plan ở tab "Plan" trong Google Sheet</div>'}</div>`;
}

function render(d) {
  $('date').textContent = d.date || '';
  renderRing(d.actual.qty, d.plan.qty);

  const s = d.stats || {};
  const pd = d.pending;
  $('stPending').textContent = pd ? fmt(pd.total) : '–';
  $('stPendingSub').textContent = pd ? 'PCS · khu A ' + fmt(pd.a) + ' · khu B ' + fmt(pd.b) : 'PCS';
  $('stJoined').textContent = fmt(s.joined);
  $('stItems').textContent = fmt(s.items);
  $('stAvg').textContent = s.workers ? fmt(Math.round(d.actual.qty / s.workers)) : '–';

  // Top 5: biểu đồ cột ngang, mỗi người 2 thanh con. Mỗi loại tính theo thang riêng (người cao nhất của loại đó = thanh dài nhất)
  const top = d.top || [];
  const mq = Math.max(1, ...top.map(t => t.qty)), mi = Math.max(1, ...top.map(t => t.items));
  $('top').innerHTML = top.length ? top.map((t, i) => `<div class="hr">
      <div class="who" title="${esc(t.name)}"><span class="rk">${i + 1}</span><span class="nm">${esc(t.name)}</span></div>
      <div class="hb">
        <div class="bl q"><div class="track"><i style="width:${Math.max(Math.round(t.qty / mq * 100), 1)}%"></i></div><b>${fmt(t.qty)}</b></div>
        <div class="bl m"><div class="track"><i style="width:${Math.max(Math.round(t.items / mi * 100), 1)}%"></i></div><b>${fmt(t.items)}</b></div>
      </div></div>`).join('')
    : '<div class="empty">Chưa có mã nào hoàn thành hôm nay</div>';
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

// Đồng hồ góc phải trên chạy từng giây (giờ của máy đang mở TV)
function tickClock() {
  const d = new Date();
  $('clockTime').textContent = d.toLocaleTimeString('vi-VN', { hour12: false });
  if ($('date').textContent.indexOf('-') >= 0) $('date').textContent = d.toLocaleDateString('vi-VN'); // trước khi có ngày từ server
}
tickClock(); setInterval(tickClock, 1000);

load(); setInterval(load, REFRESH_MS);
setTimeout(() => location.reload(), RELOAD_MS);
