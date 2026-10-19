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
const LOG_SHEET = 'Log';         // tab nhật ký (tự tạo)

// Chỉ cho đi qua các API tra cứu đã biết, giá trị là số giây cache (bảo vệ server kho).
// MỌI API ở đây đều bắt buộc có nhân viên hợp lệ.
const ALLOW = {
  'GET /sftp/getAssortingPending': 15,
  'POST /pda/itemPending': 10,
  'POST /pda/location': 10,
  'POST /pda/storeAssorted': 10,
};

// API nào được GHI LOG và tên hành động ghi trong sheet.
// API không có ở đây (vd: danh sách hàng chờ tự tải mỗi phút) chỉ kiểm tra nhân viên, không ghi log.
const LOG_ACTION = {
  'POST /pda/itemPending': 'ĐIỀU HÀNG',
  'POST /pda/storeAssorted': 'KIỂM HÀNG',
  'POST /pda/location': 'GHÉP PAXD',
};

/**
 * Chạy hàm này MỘT LẦN trong trình chỉnh sửa (chọn "testSetup" ở ô chọn hàm > Chạy)
 * để cấp quyền Google Sheet và kiểm tra cấu hình. Kết quả xem ở "Nhật ký thực thi".
 */
function testSetup() {
  const n = Object.keys(empMap_(true)).length;
  logSs_(); // kiểm tra file nhật ký mở được
  console.log('OK: đọc được ' + n + ' nhân viên từ Google Sheet.');
  return n;
}

function doGet() { return out({ ok: true, allow: Object.keys(ALLOW) }); }

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);

    if (req.action === 'login') return out(login_(req.emp));
    if (req.action === 'logout') return out(logout_(req.emp, req.note));
    if (req.action === 'suggest') return out(suggestEmp_(req.q));

    const method = String(req.method || 'GET').toUpperCase();
    const path = String(req.path || '');
    const key = method + ' ' + path;
    if (!(key in ALLOW)) return out({ __error: 'Đường dẫn không được phép: ' + key });

    const emp = findEmp_(req.emp);
    if (!emp) return out({ __error: 'NO_EMP: Chưa đăng nhập hoặc mã nhân viên không có trong danh sách.' });

    const body = method === 'POST' ? JSON.stringify(req.body || {}) : '';
    const r = fetchUpstream_(method, path, body, key, ALLOW[key]);

    // Ghi log kể cả khi kết quả lấy từ cache, để không sót lượt nào
    if (LOG_ACTION[key]) logAction_(emp, LOG_ACTION[key], req.body, r);

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

// ---------- Nhật ký ----------
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
