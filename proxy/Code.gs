/**
 * Proxy HTTPS -> server kho (HTTP) cho web app trên GitHub Pages
 * + xác thực nhân viên (Google Sheet) + ghi nhật ký "ai đã tra mã nào" ở tính năng Điều hàng.
 *
 * Cài đặt một lần (xem hướng dẫn):
 *   Project Settings (bánh răng) > Script properties > Add: SHEET_ID = <ID của Google Sheet>
 *   (ID là đoạn giữa /d/ và /edit trong địa chỉ Google Sheet).
 * Sheet cần có tab danh sách nhân viên (tên tab: EMP_SHEET bên dưới).
 * Tab nhật ký (LOG_SHEET) được script tự tạo ở lần ghi đầu tiên.
 */
const UPSTREAM = 'http://119.15.179.186:8081/api';

// ---- Google Sheet ----
const EMP_SHEET = 'Employees';   // tên tab danh sách nhân viên
const EMP_ID_COL = 1;            // cột chứa Employee ID   (A = 1)
const EMP_NAME_COL = 2;          // cột chứa họ tên        (B = 2)
const LOG_SHEET = 'Log';         // tab nhật ký (tự tạo)

// Chỉ cho đi qua các API tra cứu đã biết, giá trị là số giây cache (bảo vệ server kho).
const ALLOW = {
  'GET /sftp/getAssortingPending': 15,
  'POST /pda/itemPending': 10,
  'POST /pda/location': 10,
  'POST /pda/storeAssorted': 10,
};

// API nào BẮT BUỘC có nhân viên (và được ghi log). Giá trị = tên hành động ghi trong sheet.
const NEED_EMP = {
  'POST /pda/itemPending': 'ĐIỀU HÀNG',
};

function doGet() { return out({ ok: true, allow: Object.keys(ALLOW) }); }

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);

    if (req.action === 'login') return out(login_(req.emp));

    const method = String(req.method || 'GET').toUpperCase();
    const path = String(req.path || '');
    const key = method + ' ' + path;
    if (!(key in ALLOW)) return out({ __error: 'Đường dẫn không được phép: ' + key });

    let emp = null;
    if (NEED_EMP[key]) {
      emp = findEmp_(req.emp);
      if (!emp) return out({ __error: 'NO_EMP: Chưa quét thẻ nhân viên hoặc mã không có trong danh sách.' });
    }

    const body = method === 'POST' ? JSON.stringify(req.body || {}) : '';
    const r = fetchUpstream_(method, path, body, key, ALLOW[key]);

    // Ghi log kể cả khi kết quả lấy từ cache, để không sót lượt quét nào
    if (emp) logLookup_(emp, NEED_EMP[key], req.body, r);

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
const normId_ = v => String(v == null ? '' : v).trim().toUpperCase();

function login_(id) {
  const emp = findEmp_(id);
  if (!emp) return { __error: 'Không tìm thấy mã nhân viên: ' + normId_(id) };
  try { appendLog_([new Date(), emp.id, emp.name, 'ĐĂNG NHẬP', '', '', '', '', '']); } catch (e) { console.error('Log lỗi: ' + e); }
  return { id: emp.id, name: emp.name };
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
  const sh = ss_().getSheetByName(EMP_SHEET);
  if (!sh) throw new Error('Không thấy tab "' + EMP_SHEET + '" trong Google Sheet');
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
function logLookup_(emp, action, body, r) {
  try {
    const itemCode = body && body.ItemCode ? String(body.ItemCode) : '';
    let itemName = '', result = r.ok ? 'OK' : 'LỖI', a = '', b = '';
    if (r.ok) {
      const j = JSON.parse(r.text);
      itemName = j.ItemName || '';
      if (Array.isArray(j.Details)) {
        a = 0; b = 0;
        j.Details.forEach(function (d) {
          const q = Number(d.Quantity) || 0;
          if (String(d.Line).indexOf('A') === 0) a += q; else if (String(d.Line).indexOf('B') === 0) b += q;
        });
      } else { result = 'KHÔNG TÌM THẤY'; }
    }
    appendLog_([new Date(), emp.id, emp.name, action, itemCode, itemName, result, a, b]);
  } catch (e) {
    console.error('Ghi log lỗi: ' + e); // không chặn việc tra cứu của công nhân
  }
}

function appendLog_(row) {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    let sh = ss_().getSheetByName(LOG_SHEET);
    if (!sh) {
      sh = ss_().insertSheet(LOG_SHEET);
      sh.appendRow(['Thời gian', 'Mã NV', 'Họ tên', 'Hành động', 'Mã hàng', 'Tên hàng', 'Kết quả', 'Chờ khu A', 'Chờ khu B']);
      sh.setFrozenRows(1);
      sh.getRange('A:A').setNumberFormat('dd/MM/yyyy HH:mm:ss');
      sh.getRange('B:B').setNumberFormat('@');
      sh.getRange('E:E').setNumberFormat('@');
    }
    sh.appendRow(row);
  } finally { lock.releaseLock(); }
}

function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('Chưa cấu hình SHEET_ID trong Script properties');
  return SpreadsheetApp.openById(id);
}

function raw(text) { return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON); }
function out(obj) { return raw(JSON.stringify(obj)); }
function hex(bytes) { return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join(''); }
