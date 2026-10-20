'use strict';
// Bảng NĂNG SUẤT điều hàng hôm nay (có tên người và thời gian => chỉ mở ở màn hình công nhân không nhìn thấy).
// Mở: https://<trang>/productivity.html#key=<DASH_KEY>      (DASH_KEY đặt trong Script properties của proxy)

// Phải giống PROXY_URL trong app.js (đổi proxy thì sửa cả hai chỗ)
const PROXY_URL = 'https://script.google.com/macros/s/AKfycbyV5otbjq-5N00CMUl-7mbyC36Ztqf87C8IIzaIOiRjqwV_HGsKF7akzkFIjBcBO-VZNQ/exec';
const REFRESH_MS = 30000;          // tải lại số liệu mỗi 30 giây
const RELOAD_MS = 6 * 3600 * 1000; // tải lại cả trang mỗi 6 giờ để màn hình để cả tuần vẫn lấy bản mới
const MAX_ROWS = 10;               // số nhân viên hiện trên màn hình

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const KEY = new URLSearchParams(location.hash.replace(/^#/, '')).get('key') || params.get('key') || '';
const BASE = params.get('api') || PROXY_URL;   // ?api=... chỉ để thử
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const fmt = n => Number(n || 0).toLocaleString('vi-VN');
const mmss = sec => { const s = Math.max(0, Math.round(sec)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };

function render(d) {
  const t = d.total;
  $('sJobs').textContent = fmt(t.jobs);
  $('sQty').textContent = fmt(t.qty);
  $('sAvg').textContent = t.jobs ? mmss(t.avgSec) : '–';
  $('sDoing').textContent = fmt(t.doing);
  $('sCancel').textContent = fmt(t.cancel);

  // Bảng nhân viên: thanh tiến độ = số mã so với người làm nhiều nhất (người nhiều nhất = 100%)
  const people = d.people.slice(0, MAX_ROWS);
  const max = Math.max(1, ...d.people.map(p => p.jobs));
  $('rows').innerHTML = people.length ? people.map((p, i) => {
    const pct = Math.round(p.jobs / max * 100);
    return `<div class="tr"><div class="c-no">${i + 1}</div>
      <div class="c-name">${esc(p.name)}${p.doing ? '<span class="doing" title="đang làm"></span>' : ''}</div>
      <div class="c-n">${fmt(p.jobs)}</div><div class="c-n">${fmt(p.qty)}</div><div class="c-n">${p.jobs ? mmss(p.avgSec) : '–'}</div>
      <div class="c-bar"><div class="pct">${pct}%</div><div class="track"><i style="width:${pct}%"></i></div></div></div>`;
  }).join('') : '<div class="empty">Chưa có mã nào hoàn thành hôm nay</div>';

  // Số mã hoàn thành theo giờ (từ 6h, hoặc sớm hơn nếu có dữ liệu sớm hơn, tới giờ hiện tại)
  const byHour = {};
  d.hourly.forEach(x => { byHour[x.h] = x.n; });
  const nowH = new Date().getHours();
  const hs = d.hourly.map(x => x.h);
  const from = Math.min(6, ...(hs.length ? hs : [6]));
  const to = Math.min(23, Math.max(nowH, ...(hs.length ? hs : [nowH]), from + 7));
  const hmax = Math.max(1, ...Object.values(byHour));
  let html = '';
  for (let h = from; h <= to; h++) {
    const n = byHour[h] || 0;
    html += `<div class="hb ${h === nowH ? 'now' : ''}"><div class="n">${n || ''}</div>
      <div class="b" style="height:${n ? Math.max(Math.round(n / hmax * 100), 3) : 0}%"></div><div class="h">${h}h</div></div>`;
  }
  $('hbars').innerHTML = html;
}

async function load() {
  try {
    if (!KEY) throw new Error('Thiếu khoá: thêm #key=... vào cuối địa chỉ');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    const res = await fetch(BASE, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'productivity', key: KEY }), signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    if (d.__error) throw new Error(d.__error);
    render(d);
    $('dot').classList.remove('err');
    $('status').textContent = 'Cập nhật lúc ' + new Date().toLocaleTimeString('vi-VN', { hour12: false }) + ' · tự làm mới mỗi ' + REFRESH_MS / 1000 + ' giây';
  } catch (e) {
    $('dot').classList.add('err');
    $('status').textContent = 'Không tải được: ' + (e.message || e);
  }
}

load(); setInterval(load, REFRESH_MS);
setTimeout(() => location.reload(), RELOAD_MS);
