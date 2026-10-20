'use strict';
// Bảng trạng thái kho trên TV. Chỉ hiện số liệu CHUNG của cả kho: không tên người, không thời gian làm việc.
// Mở: https://<trang>/tv.html#key=<DASH_KEY>   (nếu proxy đã đặt DASH_KEY thì phải có #key=...)

// Phải giống PROXY_URL trong app.js (đổi proxy thì sửa cả hai chỗ)
const PROXY_URL = 'https://script.google.com/macros/s/AKfycbyV5otbjq-5N00CMUl-7mbyC36Ztqf87C8IIzaIOiRjqwV_HGsKF7akzkFIjBcBO-VZNQ/exec';
const REFRESH_MS = 30000;          // tải lại số liệu mỗi 30 giây
const RELOAD_MS = 6 * 3600 * 1000; // tải lại cả trang mỗi 6 giờ để TV để cả tuần vẫn lấy bản mới
const LINES_B = ['B08','B09','B10','B11','B12','B13','B14'];
const LINES_A = ['A01','A02','A03','A04','A05','A06','A07'];

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const KEY = new URLSearchParams(location.hash.replace(/^#/, '')).get('key') || params.get('key') || '';
const BASE = params.get('api') || PROXY_URL;   // ?api=... chỉ để thử
const fmt = n => Number(n || 0).toLocaleString('vi-VN');
const label = l => l[0] + '-' + l.slice(1);    // B08 -> B-08, đúng kiểu bảng cũ

function rowsHtml(names, lines, max) {
  return names.map(l => {
    const q = lines[l] || 0, pct = Math.round(q / max * 100);
    return `<div class="tr"><div>${label(l)}</div><div class="n">${fmt(q)}</div>
      <div class="pb"><div class="pct">${pct}%</div><div class="track"><i style="width:${pct}%"></i></div></div></div>`;
  }).join('');
}

function render(d) {
  const p = d.pending;
  $('sTotal').textContent = p ? fmt(p.a + p.b) : '–';
  $('sItems').textContent = p ? fmt(p.items) : '–';
  $('sDone').textContent = fmt(d.today.done);
  $('sDoing').textContent = fmt(d.today.doing);
  $('sA').textContent = p ? fmt(p.a) : '–';
  $('sB').textContent = p ? fmt(p.b) : '–';

  const lines = p ? p.lines : {};
  const max = Math.max(1, ...[...LINES_A, ...LINES_B].map(l => lines[l] || 0)); // tỉ lệ so với line nhiều nhất
  $('rowsB').innerHTML = rowsHtml(LINES_B, lines, max);
  $('rowsA').innerHTML = rowsHtml(LINES_A, lines, max);
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
