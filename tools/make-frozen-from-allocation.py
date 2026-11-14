# Dùng: python tools/make-frozen-from-allocation.py "Frozen Allocation RP dd.mm.xlsx"
# Lấy sheet Detail, số lượng = Allocation Qty, BỎ dòng không có allocation (không có tồn). Tên cửa hàng lấy từ frozen-data.json hiện có.
import sys, json, re, openpyxl
old = {p['po']: p for p in json.load(open('frozen-data.json', encoding='utf-8'))['pos']}
wb = openpyxl.load_workbook(sys.argv[1], data_only=True)
pos, date, dropped = {}, '', 0
for r in wb['Detail'].iter_rows(min_row=2, values_only=True):
    if not r[0]: continue
    do, qty = str(r[2]), int(r[7] or 0)
    m = re.search(r'(\d\d)(\d\d)(\d\d)(?:WH34)?$', do)  # ...261113 -> 13/11/2026
    if m and not date: date = '%s/%s/20%s' % (m.group(3), m.group(2), m.group(1))
    if qty <= 0: dropped += 1; continue
    if do not in pos:
        o = old.get(do)
        if o: store, num, name = o['store'], o['num'], o['storeName']
        else:
            sm = re.match(r'VN(\d{4})', do); store, num, name = 'VN' + sm.group(1), sm.group(1), ''
            if sm.group(1) == '9997': num = do[6:10]
        pos[do] = {'po': do, 'store': store, 'num': num, 'storeName': name, 'items': []}
    pos[do]['items'].append([str(r[0]).strip(), r[4], qty])
out = {'date': date, 'pos': sorted(pos.values(), key=lambda p: (p['num'], p['po']))}
with open('frozen-data.json', 'w', encoding='utf-8') as f: json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
sys.stdout.reconfigure(encoding='utf-8'); print(date, len(out['pos']), 'PO', sum(len(p['items']) for p in out['pos']), 'dòng, bỏ', dropped, 'dòng không allocation')
