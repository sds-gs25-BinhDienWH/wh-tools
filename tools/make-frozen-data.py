# Dùng: python tools/make-frozen-data.py "PO_FROZEN_xx.xx.xlsx"  -> ghi frozen-data.json (không có giá)
import sys, json, re, openpyxl
wb = openpyxl.load_workbook(sys.argv[1], data_only=True)
head = {r[0]: r for r in wb['PO list'].iter_rows(min_row=2, values_only=True) if r[0]}
pos = {}
date = ''
for r in wb['PO detail'].iter_rows(min_row=2, values_only=True):
    if not r[0]: continue
    if r[0] not in pos:
        # Cửa hàng thường: VN0052 -> 0052. Đơn Wholesales (VN9997): số cửa hàng nằm ngay sau mã trong mã PO, vd VN99970407... -> 0407
        d = ''.join(ch for ch in str(r[3]) if ch.isdigit())
        m = re.match(r'^' + re.escape(str(r[3])) + r'(\d{4})', str(r[0])) if d.startswith('9997') else None
        pos[r[0]] = {'po': r[0], 'store': r[3], 'num': m.group(1) if m else d, 'storeName': r[4], 'items': []}
    p = pos[r[0]]
    p['items'].append([str(r[6]).strip(), r[7], int(r[8])])
    date = date or str(r[5])
out = {'date': date, 'pos': sorted(pos.values(), key=lambda p: (p['num'], p['po']))}
json.dump(out, open('frozen-data.json', 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print(len(out['pos']), 'PO', sum(len(p['items']) for p in out['pos']), 'dòng')
