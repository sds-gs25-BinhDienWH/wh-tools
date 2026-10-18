/**
 * Proxy HTTPS -> server kho (HTTP) cho web app trên GitHub Pages.
 * Triển khai: script.google.com > Dự án mới > dán file này > Triển khai > Ứng dụng web
 *   Thực thi dưới tên: Tôi | Ai có quyền truy cập: Bất kỳ ai
 * Dán địa chỉ .../exec vào Cài đặt của web app.
 */
const UPSTREAM = 'http://119.15.179.186:8081/api';

// Chỉ cho đi qua các API tra cứu đã biết, giá trị là số giây cache (bảo vệ server kho).
const ALLOW = {
  'GET /sftp/getAssortingPending': 15,
  'POST /pda/itemPending': 10,
  'POST /pda/location': 10,
  'POST /pda/storeAssorted': 10,
};

function doGet() { return out({ ok: true, allow: Object.keys(ALLOW) }); }

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    const method = String(req.method || 'GET').toUpperCase();
    const path = String(req.path || '');
    const key = method + ' ' + path;
    if (!(key in ALLOW)) return out({ __error: 'Đường dẫn không được phép: ' + key });

    const body = method === 'POST' ? JSON.stringify(req.body || {}) : '';
    const ttl = ALLOW[key];
    const cache = CacheService.getScriptCache();
    const ck = hex(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, key + '|' + body));
    const hit = ttl ? cache.get(ck) : null;
    if (hit) return raw(hit);

    const opt = { method: method.toLowerCase(), muteHttpExceptions: true, followRedirects: true };
    if (method === 'POST') { opt.contentType = 'application/json'; opt.payload = body; }
    const res = UrlFetchApp.fetch(UPSTREAM + path, opt);
    const text = res.getContentText('UTF-8');
    const code = res.getResponseCode();
    if (code < 200 || code >= 300) return out({ __error: 'HTTP ' + code + ': ' + text.slice(0, 200) });
    if (ttl && text.length < 90000) cache.put(ck, text, ttl);
    return raw(text);
  } catch (err) {
    return out({ __error: String(err && err.message || err) });
  }
}

function raw(text) { return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON); }
function out(obj) { return raw(JSON.stringify(obj)); }
function hex(bytes) { return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join(''); }
