'use strict';
// Bảng NĂNG SUẤT sorting (dữ liệu từ server kho qua proxy Apps Script, xem proxy/Code.gs).
// Mở: https://<trang>/sorting.html#key=<DASH_KEY>      (DASH_KEY đặt trong Script properties của proxy)
// Chọn ngôn ngữ: ô chọn trên thanh công cụ, hoặc thêm ?lang=vi|en|ko vào địa chỉ.
// Trang này có mã nhân viên và dữ liệu giao hàng => chỉ gửi địa chỉ có #key cho người được phép xem.

const PROXY_URL = 'https://script.google.com/macros/s/AKfycbwlsdDJd7GGRSIB9PMv_lV7BAhATWSfbUTy4uvjMugrm0t9pFSJYJq3uEMHmt1q5ixAEg/exec';
const REFRESH_MS = 30000;            // làm mới mỗi 30 giây (chỉ khi đang xem ngày hôm nay)
const RELOAD_MS = 6 * 3600 * 1000;   // tải lại cả trang mỗi 6 giờ để màn hình để lâu vẫn lấy bản mới
const TIMEOUT_MS = 60000;            // cả ngày ~20.000 dòng, proxy có thể mất vài giây

// ===================== BẢNG DỊCH: sửa chữ ở đây =====================
// Mỗi ngôn ngữ có cùng một bộ khoá. {t} {n} {s} là chỗ chèn giá trị, giữ nguyên khi sửa.
const I18N = {
  vi: {
    locale: 'vi-VN', name: 'Tiếng Việt',
    title: 'BẢNG NĂNG SUẤT SORTING',
    date: 'Ngày', today: 'Hôm nay', xlsx: 'Tải Excel', xlsxBusy: 'Đang tạo file…', live: '● Trực tiếp',
    sLines: 'TỔNG TASK', sQty: 'TỔNG SL', sStores: 'CỬA HÀNG', sItems: 'MÃ HÀNG', sPeople: 'NHÂN VIÊN', sLast: 'GIỜ CUỐI',
    thWorker: 'NHÂN VIÊN', thLines: 'TASK', thQty: 'SL', thPerHour: 'SL/GIỜ', thAvg: 'TG TB/TASK',
    hourTitle: 'SẢN LƯỢNG THEO GIỜ (SL)', zoneTitle: 'THEO ZONE / LINE', thZone: 'ZONE', thLine: 'LINE',
    hourSuffix: 'h', empty: 'Chưa có dữ liệu cho ngày này',
    loading: 'Đang tải…', updated: 'Cập nhật lúc {t}', autoOn: ' · tự làm mới mỗi {n} giây', autoOff: ' · ngày cũ, không tự làm mới',
    errPrefix: 'Không tải được: ', errTimeout: 'quá thời gian chờ', errNoKey: 'Thiếu khoá: thêm #key=... vào cuối địa chỉ',
    errNoLib: 'Chưa tải được thư viện Excel (cần Internet để tải xlsx.full.min.js)',
    // Excel
    shPeople: 'Nhân viên', shHour: 'Theo giờ', shZone: 'Zone-Line', shDetail: 'Chi tiết',
    xPeople: ['#', 'Work ID', 'Tên', 'Họ tên đầy đủ', 'Số task', 'Tổng SL', 'SL/giờ', 'TG TB/task (giây)', 'Bắt đầu', 'Kết thúc', 'SL theo Zone'],
    xHour: ['Giờ', 'Số task', 'Tổng SL'], xZone: ['Zone', 'Line', 'Số task', 'Tổng SL'],
  },
  en: {
    locale: 'en-US', name: 'English',
    title: 'SORTING PRODUCTIVITY BOARD',
    date: 'Date', today: 'Today', xlsx: 'Download Excel', xlsxBusy: 'Creating file…', live: '● Live',
    sLines: 'TOTAL TASKS', sQty: 'TOTAL QTY', sStores: 'STORES', sItems: 'ITEMS', sPeople: 'WORKERS', sLast: 'LAST ACTIVITY',
    thWorker: 'WORKER', thLines: 'TASKS', thQty: 'QTY', thPerHour: 'QTY/HR', thAvg: 'AVG TIME',
    hourTitle: 'QTY BY HOUR', zoneTitle: 'BY ZONE / LINE', thZone: 'ZONE', thLine: 'LINE',
    hourSuffix: 'h', empty: 'No data for this day',
    loading: 'Loading…', updated: 'Updated at {t}', autoOn: ' · auto-refresh every {n} s', autoOff: ' · past date, no auto-refresh',
    errPrefix: 'Could not load: ', errTimeout: 'request timed out', errNoKey: 'Missing key: add #key=... to the end of the address',
    errNoLib: 'Excel library failed to load (Internet is required to fetch xlsx.full.min.js)',
    shPeople: 'Workers', shHour: 'By hour', shZone: 'Zone-Line', shDetail: 'Details',
    xPeople: ['#', 'Work ID', 'Name', 'Full name', 'Tasks', 'Total qty', 'Qty/hr', 'Avg time/task (sec)', 'Start', 'End', 'Qty by Zone'],
    xHour: ['Hour', 'Tasks', 'Total qty'], xZone: ['Zone', 'Line', 'Tasks', 'Total qty'],
  },
  ko: {
    locale: 'ko-KR', name: '한국어',
    title: '소팅 생산성 현황판',
    date: '날짜', today: '오늘', xlsx: '엑셀 다운로드', xlsxBusy: '파일 생성 중…', live: '● 실시간',
    sLines: '총 태스크', sQty: '총 수량', sStores: '점포', sItems: '상품', sPeople: '작업자', sLast: '마지막 시각',
    thWorker: '작업자', thLines: '태스크', thQty: '수량', thPerHour: '수량/시간', thAvg: '태스크당 평균',
    hourTitle: '시간대별 수량', zoneTitle: '존 / 라인별', thZone: '존', thLine: '라인',
    hourSuffix: '시', empty: '해당 날짜의 데이터가 없습니다',
    loading: '불러오는 중…', updated: '{t} 업데이트', autoOn: ' · {n}초마다 자동 갱신', autoOff: ' · 지난 날짜, 자동 갱신 안 함',
    errPrefix: '불러오지 못했습니다: ', errTimeout: '응답 시간 초과', errNoKey: '키가 없습니다: 주소 끝에 #key=... 를 추가하세요',
    errNoLib: '엑셀 라이브러리를 불러오지 못했습니다 (xlsx.full.min.js를 받으려면 인터넷이 필요합니다)',
    shPeople: '작업자', shHour: '시간대별', shZone: '존-라인', shDetail: '상세',
    xPeople: ['#', 'Work ID', '이름', '전체 이름', '태스크 수', '총 수량', '수량/시간', '태스크당 평균(초)', '시작', '종료', '존별 수량'],
    xHour: ['시간', '태스크 수', '총 수량'], xZone: ['존', '라인', '태스크 수', '총 수량'],
  },
};
// ====================================================================

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
// Đọc mỗi lần gọi (không lưu cố định): thêm #key=... rồi nhấn Enter thì trình duyệt không tải lại trang, nên phải đọc lại.
const getKey = () => new URLSearchParams(location.hash.replace(/^#/, '')).get('key') || params.get('key') || '';
const BASE = params.get('api') || PROXY_URL;   // ?api=... chỉ để thử
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

// ---------- Ngôn ngữ ----------
let LANG = 'vi';
try { const s = localStorage.getItem('lang'); if (I18N[s]) LANG = s; } catch (e) { /* trình duyệt chặn lưu thì dùng mặc định */ }
if (I18N[params.get('lang')]) LANG = params.get('lang');
const T = () => I18N[LANG];
const tr = (k, v) => String(T()[k] ?? k).replace(/\{(\w+)\}/g, (_, x) => v && v[x] != null ? v[x] : '');
const fmt = n => Number(n || 0).toLocaleString(T().locale);
const mmss = sec => { const s = Math.max(0, Math.round(sec)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
const hhmm = iso => iso ? String(iso).slice(11, 16) : '–';
const hhmmss = iso => iso ? String(iso).slice(11, 19) : '';
const pad = n => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };

let loading = false, last = null;
let st = { kind: 'loading' };                       // trạng thái thanh dưới cùng, vẽ lại khi đổi ngôn ngữ

function setStatus() {
  let text = '';
  if (st.kind === 'loading') text = tr('loading');
  else if (st.kind === 'ok') text = tr('updated', { t: st.time }) + (st.auto ? tr('autoOn', { n: REFRESH_MS / 1000 }) : tr('autoOff'));
  else text = tr('errPrefix') + st.msg;
  $('status').textContent = text;
  $('dot').classList.toggle('err', st.kind === 'err');
  $('live').textContent = st.kind === 'ok' && st.auto ? tr('live') : '';
}
const errText = e => e && e.name === 'AbortError' ? tr('errTimeout') : (e && e.code === 'NOKEY' ? tr('errNoKey') : String((e && e.message) || e));

function applyLang() {
  document.documentElement.lang = LANG;
  document.title = tr('title');
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = tr(el.dataset.i18n); });
  $('lang').value = LANG;
  if (!$('btnXlsx').disabled) $('btnXlsx').textContent = tr('xlsx');
  if (last) render(last);
  setStatus();
}

// Gọi proxy. text/plain để trình duyệt không gửi preflight (Apps Script không trả được CORS cho OPTIONS).
async function call(action, date) {
  const KEY = getKey();
  if (!KEY) { const e = new Error('no key'); e.code = 'NOKEY'; throw e; }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BASE, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, key: KEY, date }), signal: ctl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    if (d.__error) throw new Error(d.__error);
    return d;
  } finally { clearTimeout(timer); }
}

function render(d) {
  const t = d.total;
  $('sLines').textContent = fmt(t.lines);
  $('sQty').textContent = fmt(t.qty);
  $('sStores').textContent = fmt(t.stores);
  $('sItems').textContent = fmt(t.items);
  $('sPeople').textContent = fmt(d.people.length);
  $('sLast').textContent = hhmm(t.last);

  // Bảng nhân viên: thanh tiến độ = SL so với người làm nhiều nhất (người nhiều nhất = 100%)
  const max = Math.max(1, ...d.people.map(p => p.qty));
  $('rows').innerHTML = d.people.length ? d.people.map((p, i) => {
    const pct = Math.round(p.qty / max * 100);
    return `<div class="tr"><div class="c-no">${i + 1}</div>
      <div class="c-name" title="${esc(p.full || p.name || p.id)}">${esc(p.name || p.id)}<span class="sub">${p.name ? esc(p.id) + ' · ' : ''}${hhmm(p.first)} → ${hhmm(p.last)}</span></div>
      <div class="c-n">${fmt(p.lines)}</div><div class="c-n">${fmt(p.qty)}</div>
      <div class="c-n">${fmt(p.qtyPerHour)}</div><div class="c-n">${p.avgSec ? mmss(p.avgSec) : '–'}</div>
      <div class="c-bar"><div class="pct">${pct}%</div><div class="track"><i style="width:${pct}%"></i></div></div></div>`;
  }).join('') : `<div class="empty">${esc(tr('empty'))}</div>`;

  // SL theo giờ: từ giờ sớm nhất có dữ liệu đến giờ muộn nhất (hoặc giờ hiện tại nếu đang xem hôm nay)
  const byHour = {}; d.hourly.forEach(x => { byHour[x.h] = x.qty; });
  const hs = d.hourly.map(x => x.h);
  const isToday = d.from === todayStr();
  const nowH = new Date().getHours();
  const from = hs.length ? Math.min(...hs) : 6;
  const to = Math.min(23, Math.max(from + 5, ...(hs.length ? hs : [from]), isToday ? nowH : 0));
  const hmax = Math.max(1, ...Object.values(byHour));
  let html = '';
  for (let h = from; h <= to; h++) {
    const n = byHour[h] || 0;
    html += `<div class="hb ${isToday && h === nowH ? 'now' : ''}"><div class="n">${n ? fmt(n) : ''}</div>
      <div class="b" style="height:${n ? Math.max(Math.round(n / hmax * 100), 3) : 0}%"></div><div class="h">${h}${esc(tr('hourSuffix'))}</div></div>`;
  }
  $('hbars').innerHTML = html;

  $('zrows').innerHTML = d.zones.map(z =>
    `<div class="zr"><div>${esc(z.zone)}</div><div>${esc(z.line)}</div><div class="c-n">${fmt(z.lines)}</div><div class="c-n">${fmt(z.qty)}</div></div>`).join('')
    || '<div class="empty">–</div>';
}

async function load() {
  if (loading) return;                      // lần trước chưa xong thì bỏ lượt này, không chạy chồng
  loading = true;
  try {
    const date = $('date').value || todayStr();
    const d = await call('summary', date);
    last = d;
    render(d);
    st = { kind: 'ok', time: new Date().toLocaleTimeString(T().locale, { hour12: false }), auto: date === todayStr() };
  } catch (e) {
    st = { kind: 'err', msg: errText(e) };
  } finally { loading = false; setStatus(); }
}

// ---------- Tải Excel ----------
async function downloadXlsx() {
  if (typeof XLSX === 'undefined') { alert(tr('errNoLib')); return; }
  const btn = $('btnXlsx'), date = $('date').value || todayStr();
  btn.disabled = true; btn.textContent = tr('xlsxBusy');
  try {
    const [jobs, sum] = await Promise.all([call('jobs', date), call('summary', date)]);
    const L = T();

    // Sheet chi tiết: giữ tên cột tiếng Anh, cùng thứ tự với file JobAssignment tải tay (để đối chiếu/nhập lại được)
    const detail = [['ID', 'Work Date', 'Zone', 'Line', 'Location Name', 'Store Code', 'Layout Code', 'Item Code', 'Item Name', 'Sorting Qty', 'Work ID', 'Scanned Time', 'Confirmed Time']]
      .concat(jobs.rows.map((r, i) => [i + 1, date, r.z, r.l, r.loc, r.st, r.lay, r.it, r.nm, r.q, r.w, r.sc.replace('T', ' '), r.cf.replace('T', ' ')]));

    const people = [L.xPeople].concat(sum.people.map((p, i) => [i + 1, p.id, p.name || '', p.full || '', p.lines, p.qty, p.qtyPerHour, p.avgSec, hhmmss(p.first), hhmmss(p.last),
      Object.keys(p.zones).sort().map(z => z + ': ' + p.zones[z]).join(', ')]));
    const hourly = [L.xHour].concat(sum.hourly.map(h => [h.h + L.hourSuffix, h.lines, h.qty]));
    const zones = [L.xZone].concat(sum.zones.map(z => [z.zone, z.line, z.lines, z.qty]));

    const wb = XLSX.utils.book_new();
    const add = (name, rows, widths) => {
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = widths.map(w => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws, name);
    };
    add(L.shPeople, people, [4, 14, 16, 26, 9, 9, 9, 18, 10, 10, 30]);
    add(L.shHour, hourly, [8, 10, 10]);
    add(L.shZone, zones, [8, 10, 10, 10]);
    add(L.shDetail, detail, [6, 12, 6, 8, 14, 11, 12, 16, 38, 11, 13, 20, 20]);
    XLSX.writeFile(wb, 'SortingProductivity_' + date + '.xlsx');
  } catch (e) {
    alert(tr('errPrefix') + errText(e));
  } finally { btn.disabled = false; btn.textContent = tr('xlsx'); }
}

$('date').value = todayStr();
$('date').max = todayStr();
$('date').addEventListener('change', load);
$('btnToday').addEventListener('click', () => { $('date').value = todayStr(); load(); });
$('btnXlsx').addEventListener('click', downloadXlsx);
$('lang').addEventListener('change', e => {
  LANG = e.target.value;
  try { localStorage.setItem('lang', LANG); } catch (err) { /* không lưu được thì thôi */ }
  applyLang();
});
window.addEventListener('hashchange', load);   // đổi/thêm #key=... thì tải lại số liệu ngay

applyLang();
load();
setInterval(() => { if (($('date').value || todayStr()) === todayStr()) load(); }, REFRESH_MS);
setTimeout(() => location.reload(), RELOAD_MS);
