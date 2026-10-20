/**
 * Proxy HTTPS -> server kho (HTTP) cho web app trên GitHub Pages
 * + xác thực nhân viên (Google Sheet) + ghi nhật ký "ai đã làm gì, lúc nào".
 *
 * Cài đặt một lần:
 *   Project Settings (bánh răng) > Script properties > Add:
 *     SHEET_ID      = ID Google Sheet danh sách nhân viên (đoạn giữa /d/ và /edit trong địa chỉ)
 *     LOG_SHEET_ID  = (tuỳ chọn) ID file để ghi nhật ký. Không đặt thì ghi chung file danh sách.
 * Tab nhật ký (LOG_SHEET) được script tự tạo ở lần ghi đầu tiên.
 */
const UPSTREAM = 'http://119.15.179.186:8081/api';

// ---- Google Sheet ----
const EMP_SHEET = 'Trang tính1'; // tên tab danh sách nhân viên (không tìm thấy thì dùng tab đầu tiên)
const EMP_ID_COL = 3;            // cột chứa Employee ID   (A=1, B=2, C=3)
const EMP_NAME_COL = 2;          // cột chứa họ tên        (cột B: Full Name)
const LOG_SHEET = 'Log';         // tab nhật ký chung: đăng nhập, đăng xuất, quét sai... (tự tạo)
const JOB_SHEET = 'Điều hàng';   // tab điều hàng: MỖI MÃ HÀNG MỘT DÒNG, có giờ bắt đầu và kết thúc (tự tạo)

// Chỉ cho đi qua các API tra cứu đã biết, giá trị là số giây cache (bảo vệ server kho).
// MỌI API ở đây đều bắt buộc có nhân viên hợp lệ.
const ALLOW = {
  'GET /sftp/getAssortingPending': 15,
  'POST /pda/itemPending': 10,
  'POST /pda/location': 10,
  'POST /pda/storeAssorted': 10,
};

// Điều hàng (tra một mã hàng) có cách ghi riêng: mỗi mã một dòng ở tab JOB_SHEET (xem logItemScan_ / closeJob_).
const ITEM_KEY = 'POST /pda/itemPending';

// Các API khác được ghi vào tab Log chung, kèm tên hành động.
// API không có ở đây (vd: danh sách hàng chờ tự tải mỗi phút) chỉ kiểm tra nhân viên, không ghi log.
const LOG_ACTION = {
  'POST /pda/storeAssorted': 'KIỂM HÀNG',
  'POST /pda/location': 'GHÉP PAXD',
};

/**
 * Chạy hàm này MỘT LẦN trong trình chỉnh sửa (chọn "testSetup" ở ô chọn hàm > Chạy)
 * để cấp quyền Google Sheet và kiểm tra cấu hình. Kết quả xem ở "Nhật ký thực thi".
 */
function testSetup() {
  const n = Object.keys(empMap_(true)).length;
  const book = logSs_();
  jobSheet_();                                   // tạo tab "Điều hàng" nếu chưa có
  planSheet_();                                  // tạo tab "Plan" (2 ô vàng để nhập Plan) nếu chưa có
  appendLog_([new Date(), 'TEST', 'Chạy thử testSetup', 'THỬ GHI LOG', '', '', 'OK', '', '', 'Dòng thử, xoá được']); // tạo tab "Log" + 1 dòng thử
  console.log('OK: đọc được ' + n + ' nhân viên. Nhật ký được ghi vào FILE: "' + book.getName() + '"\n' + book.getUrl() +
    '\nCác tab: "' + LOG_SHEET + '" (đăng nhập, quét sai...), "' + JOB_SHEET + '" (mỗi mã hàng một dòng) và "' + PLAN_SHEET + '" (nhập Plan ở ô vàng B3, B4).');
  return n;
}

// Mở địa chỉ .../exec của proxy trên trình duyệt sẽ thấy dòng version này: cho biết proxy đang chạy bản nào.
const VERSION = '2026-10-21c · dashboard COLD WH Daily Progress: Plan/Actual (PCS) + hàng chờ còn lại + Top 5 năng suất';
function doGet() { return out({ ok: true, version: VERSION, allow: Object.keys(ALLOW) }); }

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);

    if (req.action === 'login') return out(login_(req.emp));
    if (req.action === 'logout') return out(logout_(req.emp, req.note));
    if (req.action === 'suggest') return out(suggestEmp_(req.q));
    if (req.action === 'complete') return out(complete_(req));
    if (req.action === 'dashboard') return out(dashboard_(req.key));
    if (req.action === 'productivity') return out(productivity_(req.key));

    const method = String(req.method || 'GET').toUpperCase();
    const path = String(req.path || '');
    const key = method + ' ' + path;
    if (!(key in ALLOW)) return out({ __error: 'Đường dẫn không được phép: ' + key });

    const emp = findEmp_(req.emp);
    if (!emp) return out({ __error: 'NO_EMP: Chưa đăng nhập hoặc mã nhân viên không có trong danh sách.' });

    const body = method === 'POST' ? JSON.stringify(req.body || {}) : '';
    const r = fetchUpstream_(method, path, body, key, ALLOW[key]);

    // Ghi log kể cả khi kết quả lấy từ cache, để không sót lượt nào
    if (key === ITEM_KEY) {
      const job = logItemScan_(emp, req.body, r);
      if (job && r.ok) {
        // Trả kèm mã phiên (Họ tên_Mã hàng_giờ bắt đầu) để app gửi lại lúc Hoàn thành
        try { const o = JSON.parse(r.text); o.__job = job; return out(o); } catch (e) { /* trả nguyên văn bên dưới */ }
      }
    } else if (LOG_ACTION[key]) logAction_(emp, LOG_ACTION[key], req.body, r);

    if (!r.ok) return out({ __error: r.error });
    return raw(r.text);
  } catch (err) {
    return out({ __error: String(err && err.message || err) });
  }
}

// ---------- Gọi server kho (có cache ngắn) ----------
function fetchUpstream_(method, path, body, key, ttl) {
  const cache = CacheService.getScriptCache();
  const ck = hex(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, key + '|' + body));
  const hit = ttl ? cache.get(ck) : null;
  if (hit) return { ok: true, text: hit };

  const opt = { method: method.toLowerCase(), muteHttpExceptions: true, followRedirects: true };
  if (method === 'POST') { opt.contentType = 'application/json'; opt.payload = body; }
  const res = UrlFetchApp.fetch(UPSTREAM + path, opt);
  const text = res.getContentText('UTF-8');
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) return { ok: false, error: 'HTTP ' + code + ': ' + text.slice(0, 200) };
  if (ttl && text.length < 90000) cache.put(ck, text, ttl);
  return { ok: true, text: text };
}

// ---------- Nhân viên ----------
// Chuẩn hoá mã nhân viên. Thẻ quét ra "WK10600143" -> bỏ tiền tố WK còn "10600143".
// Dùng cho cả mã quét lên và mã trong sheet nên hai bên luôn khớp.
const normId_ = v => String(v == null ? '' : v).trim().toUpperCase().replace(/^WK[\s\-_:]*(?=\d)/, '');

function login_(id) {
  const emp = findEmp_(id);
  if (!emp) return { __error: 'Không tìm thấy mã nhân viên: ' + normId_(id) };
  safeLog_([new Date(), emp.id, emp.name, 'ĐĂNG NHẬP', '', '', '', '', '', '']);
  return { id: emp.id, name: emp.name };
}

function logout_(id, note) {
  const emp = findEmp_(id);
  if (emp) safeLog_([new Date(), emp.id, emp.name, 'ĐĂNG XUẤT', '', '', '', '', '', String(note || '').slice(0, 200)]);
  return { ok: true };
}

// Công nhân bấm "Hoàn thành" (hoặc "Huỷ mã") một mã hàng ở Điều hàng: đóng dòng đã mở lúc quét.
// req = { emp, job (mã phiên do proxy trả về lúc quét), itemCode, itemName, startedAt, endedAt (ms, giờ máy PDA, chỉ dùng
//         khi không tìm thấy dòng lúc quét), done:[{l,q}] (các line đã chốt, dùng để cộng số lượng đã điều),
//         cancel (true nếu huỷ), reason ('cancel' | 'timeout' = quá 1 giờ | 'other' = người khác đăng nhập) }
function complete_(req) {
  const emp = findEmp_(req.emp);
  if (!emp) return { __error: 'NO_EMP: Chưa đăng nhập hoặc mã nhân viên không có trong danh sách.' };
  const done = Array.isArray(req.done) ? req.done.slice(0, 14) : [];
  const cancel = !!req.cancel;
  const status = cancel
    ? (req.reason === 'timeout' ? 'QUÁ 1 GIỜ' : (req.reason === 'other' ? 'NGƯỜI KHÁC VÀO' : 'ĐÃ HUỶ'))
    : 'XONG ĐỦ'; // app bắt buộc chốt đủ mọi line mới cho hoàn thành
  const qty = cancel ? '' : done.reduce(function (s, d) { return s + (Number(d.q) || 0); }, 0); // huỷ thì chưa tính là đã điều
  try {
    closeJob_(emp, req, status, qty);
  } catch (e) {
    console.error('Đóng dòng điều hàng lỗi: ' + e); // không chặn công nhân
  }
  return { ok: true };
}

// ---------- Dashboard SAMSUNG SDS: Plan so với Actual hôm nay + Top 5 năng suất ----------
// Trang tv.html gọi action "dashboard". Nếu có Script property DASH_KEY thì phải gửi đúng khoá mới xem được.
// Plan: nhập tay ở tab PLAN_SHEET (ô vàng B3 = Plan số lượng, B4 = Plan số mã). Actual: đếm từ tab "Điều hàng" (mã XONG ĐỦ hôm nay).
const PLAN_SHEET = 'Plan';

function planSheet_() {
  const book = logSs_();
  let sh = book.getSheetByName(PLAN_SHEET);
  if (!sh) {
    sh = book.insertSheet(PLAN_SHEET);
    sh.getRange('A1').setValue('SAMSUNG SDS · PLAN HÔM NAY').setFontWeight('bold').setFontSize(14);
    sh.getRange('A3:A4').setValues([['Plan số lượng (SL)'], ['Plan số mã (itemcode)']]).setFontWeight('bold');
    sh.getRange('B3:B4').setBackground('#FFF2CC').setNumberFormat('#,##0').setFontWeight('bold').setFontSize(14)
      .setHorizontalAlignment('center').setBorder(true, true, true, true, true, true);
    sh.getRange('A6').setValue('Nhập số vào ô VÀNG (B3, B4). Dashboard tự lấy làm Plan. Để trống = không hiện % tiến độ phần đó.').setFontStyle('italic');
    sh.setColumnWidth(1, 240); sh.setColumnWidth(2, 150);
  }
  return sh;
}

function dashboard_(key) {
  const need = PropertiesService.getScriptProperties().getProperty('DASH_KEY');
  if (need && String(key || '') !== need) return { __error: 'Sai khoá xem bảng (DASH_KEY)' };
  const cache = CacheService.getScriptCache();
  const hit = cache.get('dash4');
  if (hit) return JSON.parse(hit);                 // nhiều TV cùng mở thì chỉ tính một lần mỗi 20 giây

  const fmt = function (d, p) { return Utilities.formatDate(d, TZ, p); };
  const res = { at: Date.now(), date: fmt(new Date(), 'dd/MM/yyyy'), plan: { qty: 0, items: 0 }, actual: { qty: 0, items: 0 }, top: [],
    pending: { a: 0, b: 0, total: 0 }, stats: { joined: 0, workers: 0, items: 0 } };

  // Plan: hai ô vàng trong tab "Plan"
  try {
    const pl = planSheet_();
    res.plan.qty = Number(pl.getRange('B3').getValue()) || 0;
    res.plan.items = Number(pl.getRange('B4').getValue()) || 0;
  } catch (e) { console.error('Dashboard: lỗi đọc Plan: ' + e); }

  // Actual + Top 5: đếm từ tab "Điều hàng" (chỉ mã XONG ĐỦ có giờ bắt đầu là hôm nay)
  try {
    const sh = logSs_().getSheetByName(JOB_SHEET);
    if (sh && sh.getLastRow() > 1) {
      const n = Math.min(sh.getLastRow() - 1, 5000), first = sh.getLastRow() - n + 1;
      const vals = sh.getRange(first, 1, n, 11).getValues();             // cột A..K
      const today = fmt(new Date(), 'yyyyMMdd');
      const people = {};
      vals.forEach(function (v) {
        if (!(v[0] instanceof Date) || fmt(v[0], 'yyyyMMdd') !== today) return;
        if (String(v[7]) !== 'XONG ĐỦ') return;
        const q = Number(v[10]) || 0, id = String(v[3]);
        res.actual.qty += q; res.actual.items++;
        const p = people[id] || (people[id] = { name: String(v[4]), qty: 0, items: 0 });
        p.qty += q; p.items++;
      });
      res.top = Object.keys(people).map(function (id) { return people[id]; })
        .sort(function (a, b) { return b.qty - a.qty || b.items - a.items; }).slice(0, 5);
      res.stats = { joined: Object.keys(people).length, workers: Object.keys(people).length, items: res.actual.items };
    }
  } catch (e) { console.error('Dashboard: lỗi đọc tiến độ: ' + e); }

  // Hàng chờ còn lại: tổng khu A + khu B đang chờ điều, lấy từ server kho (cache 15 giây trong fetchUpstream_)
  try {
    const r = fetchUpstream_('GET', '/sftp/getAssortingPending', '', 'GET /sftp/getAssortingPending', 15);
    if (r.ok) {
      const j = JSON.parse(r.text);
      const rows = Array.isArray(j.data) ? j.data : [];            // hết hàng chờ: data = null
      const LN = ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'B08', 'B09', 'B10', 'B11', 'B12', 'B13', 'B14'];
      rows.forEach(function (it) {
        LN.forEach(function (l) {
          const q = Number(it[l]) || 0;
          if (l.charAt(0) === 'A') res.pending.a += q; else res.pending.b += q;
        });
      });
      res.pending.total = res.pending.a + res.pending.b;
    }
  } catch (e) { console.error('Dashboard: lỗi lấy hàng chờ: ' + e); }

  cache.put('dash4', JSON.stringify(res), 20);
  return res;
}
// ---------- Bảng NĂNG SUẤT: có TÊN NGƯỜI và THỜI GIAN làm việc nên BẮT BUỘC có DASH_KEY ----------
// Trang productivity.html gọi action "productivity". Chỉ nên mở ở màn hình công nhân không nhìn thấy.
function productivity_(key) {
  const need = PropertiesService.getScriptProperties().getProperty('DASH_KEY');
  if (!need) return { __error: 'Cần đặt DASH_KEY trong Script properties để xem bảng năng suất (bảng này có tên và thời gian từng người)' };
  if (String(key || '') !== need) return { __error: 'Sai khoá xem bảng (DASH_KEY)' };
  const cache = CacheService.getScriptCache();
  const hit = cache.get('prod');
  if (hit) return JSON.parse(hit);

  const res = { at: Date.now(), total: { jobs: 0, qty: 0, avgSec: 0, doing: 0, cancel: 0 }, people: [], hourly: [] };
  const sh = logSs_().getSheetByName(JOB_SHEET);
  if (sh && sh.getLastRow() > 1) {
    const n = Math.min(sh.getLastRow() - 1, 5000), first = sh.getLastRow() - n + 1;
    const vals = sh.getRange(first, 1, n, 11).getValues();              // cột A..K
    const fmt = function (d, p) { return Utilities.formatDate(d, TZ, p); };
    const today = fmt(new Date(), 'yyyyMMdd'), recent = Date.now() - 70 * 60000;
    const people = {}, hourly = {};
    let secSum = 0, secN = 0;
    vals.forEach(function (v) {
      const start = v[0];
      if (!(start instanceof Date) || fmt(start, 'yyyyMMdd') !== today) return;
      const id = String(v[3]), status = String(v[7]);
      const p = people[id] || (people[id] = { name: String(v[4]), jobs: 0, qty: 0, secSum: 0, secN: 0, cancel: 0, doing: 0 });
      if (status === 'XONG ĐỦ') {
        p.jobs++; p.qty += Number(v[10]) || 0;
        const sec = Number(v[2]);
        if (isFinite(sec) && v[2] !== '') { p.secSum += sec; p.secN++; secSum += sec; secN++; }
        res.total.jobs++; res.total.qty += Number(v[10]) || 0;
        if (v[1] instanceof Date) { const h = Number(fmt(v[1], 'H')); hourly[h] = (hourly[h] || 0) + 1; }
      } else if (status === JOB_OPEN) {
        if (start.getTime() > recent) { p.doing++; res.total.doing++; }
      } else if (status === 'ĐÃ HUỶ' || status === 'QUÁ 1 GIỜ' || status === 'BỎ DỞ (KHÔNG BÁO)') {
        p.cancel++; res.total.cancel++;
      }
    });
    res.total.avgSec = secN ? Math.round(secSum / secN) : 0;
    res.people = Object.keys(people).map(function (id) {
      const p = people[id];
      return { name: p.name, jobs: p.jobs, qty: p.qty, avgSec: p.secN ? Math.round(p.secSum / p.secN) : 0, cancel: p.cancel, doing: p.doing };
    }).filter(function (p) { return p.jobs > 0 || p.doing > 0; })
      .sort(function (a, b) { return b.jobs - a.jobs || b.qty - a.qty; }).slice(0, 30);
    res.hourly = Object.keys(hourly).map(function (h) { return { h: Number(h), n: hourly[h] }; });
  }
  cache.put('prod', JSON.stringify(res), 30);
  return res;
}

// Gợi ý khi nhân viên nhập tay: khớp theo tên (không dấu) hoặc mã. Tối thiểu 2 ký tự, tối đa 8 kết quả.
// Đặt SUGGEST_EMP = false nếu không muốn trả danh sách tên/mã ra ngoài.
const SUGGEST_EMP = true;
function suggestEmp_(q) {
  if (!SUGGEST_EMP) return [];
  const fold = function (s) {
    s = String(s == null ? '' : s);
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) {}
    return s.replace(/đ/gi, 'd').toLowerCase().trim();
  };
  const needle = fold(String(q || '').slice(0, 30));
  if (needle.length < 2) return [];
  const map = empMap_(false);
  const res = [];
  for (const id in map) {
    if (fold(map[id]).indexOf(needle) >= 0 || id.toLowerCase().indexOf(needle) >= 0) {
      res.push({ id: id, name: map[id] });
      if (res.length >= 8) break;
    }
  }
  return res;
}

function findEmp_(id) {
  const k = normId_(id);
  if (!k) return null;
  let map = empMap_(false);
  if (map[k]) return { id: k, name: map[k] };
  // Có thể mới thêm nhân viên vào sheet: đọc lại một lần, nhưng không quá 1 lần / 20 giây
  const cache = CacheService.getScriptCache();
  if (!cache.get('emp_miss')) {
    cache.put('emp_miss', '1', 20);
    map = empMap_(true);
    if (map[k]) return { id: k, name: map[k] };
  }
  return null;
}

function empMap_(force) {
  const cache = CacheService.getScriptCache();
  if (!force) {
    const c = cache.get('emp_map');
    if (c) return JSON.parse(c);
  }
  const book = ss_();
  const sh = book.getSheetByName(EMP_SHEET) || book.getSheets()[0];
  if (!sh) throw new Error('Google Sheet danh sách nhân viên không có tab nào');
  const rows = sh.getDataRange().getValues();
  const map = {};
  rows.forEach(function (row) {
    const id = normId_(row[EMP_ID_COL - 1]);
    const name = String(row[EMP_NAME_COL - 1] == null ? '' : row[EMP_NAME_COL - 1]).trim();
    if (!id || /^(EMPLOYEE\s*ID|EMPLOYEE_ID|ID|MÃ\s*NV|MÃ NHÂN VIÊN)$/.test(id)) return; // bỏ dòng tiêu đề
    map[id] = name || id;
  });
  const text = JSON.stringify(map);
  if (text.length < 90000) cache.put('emp_map', text, 300);
  return map;
}

// ---------- Điều hàng: mỗi mã hàng MỘT dòng (tab JOB_SHEET) ----------
// Cột: A Bắt đầu | B Kết thúc | C Thời lượng (giây) | D Mã NV | E Họ tên | F Mã hàng | G Tên hàng | H Trạng thái
//      | I Chờ khu A | J Chờ khu B | K SL đã điều | L Mã phiên
// Mã phiên = Họ_tên + "_" + Mã_hàng + "_" + giờ bắt đầu (yyyyMMddHHmmss, giờ Việt Nam), dấu cách đổi thành "_". Proxy tạo lúc quét và trả về cho app
// để lúc Hoàn thành app gửi lại đúng mã này, proxy tìm đúng dòng mà đóng.
// Trạng thái: ĐANG LÀM -> XONG ĐỦ | ĐÃ HUỶ | QUÁ 1 GIỜ | NGƯỜI KHÁC VÀO | BỎ DỞ (KHÔNG BÁO)
// (App bắt buộc chốt đủ mọi line mới cho hoàn thành, nên không còn cột "Line đã xong / chưa xong".)
const JOB_OPEN = 'ĐANG LÀM';
const TZ = 'Asia/Ho_Chi_Minh';

function jobSheet_() {
  const book = logSs_();
  let sh = book.getSheetByName(JOB_SHEET);
  if (!sh) {
    sh = book.insertSheet(JOB_SHEET);
    sh.appendRow(['Bắt đầu', 'Kết thúc', 'Thời lượng (giây)', 'Mã NV', 'Họ tên', 'Mã hàng', 'Tên hàng', 'Trạng thái',
      'Chờ khu A', 'Chờ khu B', 'SL đã điều', 'Mã phiên']);
    sh.setFrozenRows(1);
    sh.getRange('A:B').setNumberFormat('dd/MM/yyyy HH:mm:ss');
    ['D:D', 'F:F', 'L:L'].forEach(function (r) { sh.getRange(r).setNumberFormat('@'); }); // giữ nguyên số 0 đầu, không thành số khoa học
  } else if (sh.getLastColumn() >= 14 && String(sh.getRange(1, 14).getValue()) === 'Mã phiên') {
    // Tab tạo từ bản cũ (có 2 cột "Line đã xong", "Line chưa xong" ở K, L): xoá 2 cột đó, dữ liệu còn lại tự dịch sang trái
    sh.deleteColumns(11, 2);
  }
  return sh;
}

// Gọi mỗi lần tra một mã hàng ở Điều hàng. Chỉ mã có hàng chờ thật mới mở một dòng ĐANG LÀM.
// Trả về { id } (mã phiên) nếu đã mở dòng, ngược lại null.
function logItemScan_(emp, body, r) {
  try {
    const itemCode = body && body.ItemCode ? String(body.ItemCode).slice(0, 60) : '';
    const logOther = function (action, result, note) {
      safeLog_([new Date(), emp.id, emp.name, action, itemCode, '', result, '', '', note || '']);
      return null;
    };
    if (!r.ok) return logOther('QUÉT LỖI', 'LỖI', String(r.error || '').slice(0, 200));
    const j = JSON.parse(r.text);
    if (!Array.isArray(j.Details)) return logOther('QUÉT KHÔNG TÌM THẤY', 'KHÔNG TÌM THẤY', '');   // vd: quét nhầm đường link
    let a = 0, b = 0;
    j.Details.forEach(function (d) {
      const q = Number(d.Quantity) || 0;
      if (String(d.Line).indexOf('A') === 0) a += q; else if (String(d.Line).indexOf('B') === 0) b += q;
    });
    if (a + b <= 0) return logOther('QUÉT HẾT HÀNG CHỜ', 'KHÔNG CÒN HÀNG', String(j.ItemName || '').slice(0, 100));
    const now = new Date();
    // Mã phiên không có dấu cách: "Phan Thi My Huyen" -> "Phan_Thi_My_Huyen"
    const id = (String(emp.name).trim().replace(/\s+/g, '_') + '_' + itemCode.replace(/\s+/g, '_') + '_' +
      Utilities.formatDate(now, TZ, 'yyyyMMddHHmmss')).slice(0, 120);
    const lock = LockService.getScriptLock();
    lock.waitLock(5000);
    try {
      jobSheet_().appendRow([now, '', '', emp.id, emp.name, itemCode, String(j.ItemName || '').slice(0, 100),
        JOB_OPEN, a, b, '', id]);
    } finally { lock.releaseLock(); }
    closeStaleJobs_();
    return { id: id };
  } catch (e) {
    console.error('Ghi dòng điều hàng lỗi: ' + e); // không chặn việc tra cứu của công nhân
    return null;
  }
}

// Dọn dòng ĐANG LÀM bị bỏ quên (PDA hỏng/tắt app, không bao giờ báo lại): quá 70 phút thì đổi trạng thái.
// Chạy tối đa 10 phút một lần, nhân dịp có người quét mã; chỉ xét 2000 dòng cuối cho nhẹ.
function closeStaleJobs_() {
  const cache = CacheService.getScriptCache();
  if (cache.get('stale_run')) return;
  cache.put('stale_run', '1', 600);
  const sh = jobSheet_();
  const last = sh.getLastRow();
  if (last < 2) return;
  const n = Math.min(last - 1, 2000), first = last - n + 1;
  const vals = sh.getRange(first, 1, n, 8).getValues(); // cột A..H
  const cutoff = Date.now() - 70 * 60000;
  vals.forEach(function (v, i) {
    if (String(v[7]) === JOB_OPEN && v[0] instanceof Date && v[0].getTime() < cutoff) {
      sh.getRange(first + i, 8).setValue('BỎ DỞ (KHÔNG BÁO)');
    }
  });
}

// Đóng dòng đã mở lúc quét (điền giờ kết thúc, thời lượng, trạng thái, số lượng đã điều).
// Giờ bắt đầu/kết thúc đều là giờ của server nên không phụ thuộc đồng hồ PDA.
function closeJob_(emp, req, status, qty) {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const sh = jobSheet_();
    const jobId = String(req.job || '').slice(0, 120);
    let row = 0;
    if (jobId) {
      const hit = sh.getRange('L:L').createTextFinder(jobId).matchEntireCell(true).findNext();
      if (hit) row = hit.getRow();
    }
    const now = new Date();
    if (row) {
      if (String(sh.getRange(row, 8).getValue()) !== JOB_OPEN) return; // đã đóng rồi (bấm/gửi lại): bỏ qua, không ghi đè
      const start = sh.getRange(row, 1).getValue();
      const sec = start instanceof Date ? Math.round((now - start) / 1000) : '';
      sh.getRange(row, 2, 1, 2).setValues([[now, sec]]);                          // B Kết thúc, C Thời lượng
      sh.getRange(row, 8).setValue(status);                                       // H Trạng thái
      sh.getRange(row, 11).setValue(qty);                                         // K SL đã điều
    } else {
      // Không thấy dòng lúc quét (ghi lúc quét bị lỗi, hoặc app bản cũ): ghi một dòng đầy đủ bằng giờ máy PDA
      const s = new Date(Number(req.startedAt)), e = new Date(Number(req.endedAt));
      const ok = !isNaN(s) && !isNaN(e) && e >= s;
      sh.appendRow([ok ? s : now, ok ? e : now, ok ? Math.round((e - s) / 1000) : '', emp.id, emp.name,
        String(req.itemCode || '').slice(0, 60), String(req.itemName || '').slice(0, 100), status, '', '', qty, jobId]);
    }
  } finally { lock.releaseLock(); }
}
// ---------- Nhật ký chung (tab Log): đăng nhập, đăng xuất, quét sai, kiểm hàng, ghép PAXD ----------
// Cột: Thời gian | Mã NV | Họ tên | Hành động | Mã hàng | Tên hàng | Kết quả | Chờ khu A | Chờ khu B | Ghi chú
function logAction_(emp, action, body, r) {
  try {
    const itemCode = body && body.ItemCode ? String(body.ItemCode) : '';
    let itemName = '', result = r.ok ? 'OK' : 'LỖI', a = '', b = '', note = '';
    if (r.ok && itemCode) {
      const j = JSON.parse(r.text);
      itemName = j.ItemName || '';
      if (Array.isArray(j.Details)) {
        a = 0; b = 0;
        j.Details.forEach(function (d) {
          const q = Number(d.Quantity) || 0;
          if (String(d.Line).indexOf('A') === 0) a += q; else if (String(d.Line).indexOf('B') === 0) b += q;
        });
      } else { result = 'KHÔNG TÌM THẤY'; }
    } else if (!itemCode && body) {
      note = JSON.stringify(body).slice(0, 200); // vd: mã cửa hàng, ngày
    }
    if (!r.ok) note = String(r.error || '').slice(0, 200);
    safeLog_([new Date(), emp.id, emp.name, action, itemCode, itemName, result, a, b, note]);
  } catch (e) {
    console.error('Ghi log lỗi: ' + e); // không chặn việc tra cứu của công nhân
  }
}

function safeLog_(row) {
  try { appendLog_(row); } catch (e) { console.error('Ghi log lỗi: ' + e); }
}

function appendLog_(row) {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const book = logSs_();
    let sh = book.getSheetByName(LOG_SHEET);
    if (!sh) {
      sh = book.insertSheet(LOG_SHEET);
      sh.appendRow(['Thời gian', 'Mã NV', 'Họ tên', 'Hành động', 'Mã hàng', 'Tên hàng', 'Kết quả', 'Chờ khu A', 'Chờ khu B', 'Ghi chú']);
      sh.setFrozenRows(1);
      sh.getRange('A:A').setNumberFormat('dd/MM/yyyy HH:mm:ss');
      sh.getRange('B:B').setNumberFormat('@');
      sh.getRange('E:E').setNumberFormat('@');
    }
    sh.appendRow(row);
  } finally { lock.releaseLock(); }
}

// File danh sách nhân viên (do leader cập nhật): Script property SHEET_ID
function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('Chưa cấu hình SHEET_ID trong Script properties');
  return SpreadsheetApp.openById(id);
}

// File ghi nhật ký: Script property LOG_SHEET_ID (tuỳ chọn). Không đặt thì ghi chung file danh sách.
function logSs_() {
  const id = PropertiesService.getScriptProperties().getProperty('LOG_SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : ss_();
}

function raw(text) { return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON); }
function out(obj) { return raw(JSON.stringify(obj)); }
function hex(bytes) { return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join(''); }
