'use strict';
// Dashboard SAMSUNG SDS: tiến độ Actual / Plan hôm nay + Top 5 năng suất.
// Plan nhập ở tab "Plan" của Google Sheet (ô vàng B3 = số lượng, B4 = số mã). Actual = số đã hoàn thành hôm nay.
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

// Vòng tiến độ Actual/Plan (SVG). Chưa có plan thì chỉ hiện Actual và nhắc nhập Plan.
function ring(el, name, actual, plan) {
  const R = 78, C = 2 * Math.PI * R;
  const has = plan > 0;
  const pct = has ? Math.round(actual / plan * 100) : 0;
  const arc = has ? Math.min(pct, 100) / 100 * C : 0;
  el.innerHTML = `<svg viewBox="0 0 200 200">
      <circle class="r-track" cx="100" cy="100" r="${R}"/>
      <circle class="r-bar" cx="100" cy="100" r="${R}" transform="rotate(-90 100 100)" stroke-dasharray="${arc} ${C}"/>
      <text class="r-pct" x="100" y="${has ? 108 : 112}">${has ? pct + '%' : '–'}</text>
      <text class="r-sub" x="100" y="130">${has ? 'ACTUAL / PLAN' : 'CHƯA CÓ PLAN'}</text></svg>
    <div class="r-info"><div class="r-name">${name}</div>
      <div class="r-row act"><span class="l">ACTUAL</span><span class="v">${fmt(actual)}</span></div>
      <div class="r-row"><span class="l">PLAN</span><span class="v">${has ? fmt(plan) : '–'}</span></div>
      ${has ? `<div class="r-row left"><span class="l">CÒN LẠI</span><span class="v">${fmt(Math.max(plan - actual, 0))}</span></div>`
            : '<div class="r-note">Nhập Plan ở tab "Plan" trong Google Sheet</div>'}</div>`;
}

function render(d) {
  $('date').textContent = d.date || '';
  ring($('ringQty'), 'SỐ LƯỢNG (QTY)', d.actual.qty, d.plan.qty);
  ring($('ringItems'), 'SỐ ITEMCODE', d.actual.items, d.plan.items);

  // Top 5: mỗi người 2 thanh con. Mỗi loại thanh tính theo thang riêng (người cao nhất của loại đó = thanh cao nhất)
  const top = d.top || [];
  const mq = Math.max(1, ...top.map(t => t.qty)), mi = Math.max(1, ...top.map(t => t.items));
  $('top').innerHTML = top.length ? top.map((t, i) => `<div class="grp">
      <div class="bars">
        <div class="bw q"><div class="n">${fmt(t.qty)}</div><div class="b" style="height:${Math.max(Math.round(t.qty / mq * 100), 2)}%"></div></div>
        <div class="bw m"><div class="n">${fmt(t.items)}</div><div class="b" style="height:${Math.max(Math.round(t.items / mi * 100), 2)}%"></div></div>
      </div>
      <div class="gn" title="${esc(t.name)}"><span class="rk">${i + 1}</span>${esc(t.name)}</div></div>`).join('')
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

load(); setInterval(load, REFRESH_MS);
setTimeout(() => location.reload(), RELOAD_MS);
