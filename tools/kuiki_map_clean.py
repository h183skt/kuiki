import sys, cv2, numpy as np

src, out = sys.argv[1], sys.argv[2]
OPEN = int(sys.argv[3]) if len(sys.argv) > 3 else 7

im = cv2.imdecode(np.fromfile(src, np.uint8), 1)
g = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
H, W = g.shape

# 照明ムラを除去（背景を大きくぼかして割る）
bg = cv2.morphologyEx(g, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (41, 41)))
norm = cv2.divide(g, bg, scale=255)
dark = (norm < 110).astype(np.uint8) * 255

# 太線だけ残す（細い住宅地図の線は消える）
k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (OPEN, OPEN))
thick = cv2.morphologyEx(dark, cv2.MORPH_OPEN, k)
# 芯が真っ黒な線だけ残す（灰色の線路の帯などを除く）
core = cv2.morphologyEx((norm < 50).astype(np.uint8) * 255, cv2.MORPH_OPEN,
                        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
thick = cv2.bitwise_and(thick, cv2.dilate(core, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))))
# 小さな塊（黒塗り建物など）を除去
n, lab, st, _ = cv2.connectedComponentsWithStats(thick, 8)
cand = []
for i in range(1, n):
    x, y, w, h, a = st[i]
    if max(w, h) < 60:
        continue
    if x <= 2 or y <= 2 or x + w >= W - 2 or y + h >= H - 2:
        continue  # 写真の端
    if w > 0.93 * W and h > 0.85 * H and a < 0.02 * W * H:
        continue  # 印刷の外枠
    m = (lab[y:y + h, x:x + w] == i).astype(np.uint8)
    cs, _ = cv2.findContours(m, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    per = sum(cv2.arcLength(c, True) for c in cs)
    cand.append((i, 2.0 * a / max(per, 1), a))  # 平均の太さ
# 区域線の標準の太さ（面積で重み付けした中央値）
ts = sorted((t, a) for _, t, a in cand)
tot = sum(a for _, a in ts); acc = 0; TL = 10.0
for t, a in ts:
    acc += a
    if acc >= tot / 2:
        TL = t
        break
lines = np.zeros_like(thick)
for i, t, a in cand:
    if t > 1.7 * TL:
        continue  # 線より太い塊（川の土手・黒塗りの建物など）
    lines[lab == i] = 255
lines = cv2.dilate(lines, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))

# 番号ラベル（点線の四角）を検出
dark2 = (norm < 140).astype(np.uint8) * 255
def variants():
    for n in (5, 7, 9):
        yield cv2.morphologyEx(dark2, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (n, n)))
    for n in (11, 15):
        hc = cv2.morphologyEx(dark2, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (n, 1)))
        vc = cv2.morphologyEx(dark2, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (1, n)))
        yield cv2.bitwise_or(hc, vc)
    # 長い縦横の線だけで枠を作る（文字が枠に近い地名ラベル用）
    for hk, hl in ((15, 60), (11, 150)):
        hc = cv2.morphologyEx(dark2, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (hk, 1)))
        hc = cv2.morphologyEx(hc, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (hl, 1)))
        vc = cv2.morphologyEx(dark2, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (1, 15)))
        vc = cv2.morphologyEx(vc, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, 45)))
        yield cv2.dilate(cv2.bitwise_or(hc, vc), cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5)))
def border_ok(x, y, w, h, th=0.45):
    # 四辺それぞれに点線（暗い画素）があるか
    b = 10
    x0, y0 = max(0, x - 4), max(0, y - 4)
    x1, y1 = min(W, x + w + 4), min(H, y + h + 4)
    sides = [dark2[y0:y0 + b, x0:x1], dark2[y1 - b:y1, x0:x1],
             dark2[y0:y1, x0:x0 + b], dark2[y0:y1, x1 - b:x1]]
    for sd in sides:
        prof = (sd > 0).any(axis=0 if sd.shape[1] > sd.shape[0] else 1)
        if prof.mean() < th:
            return False
    return True

boxes = []
frags = []  # 文字で上下に分断された枠の断片
for closed in variants():
    cnts, _ = cv2.findContours(closed, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    for c in cnts:
        x, y, w, h = cv2.boundingRect(c)
        if 40 <= w <= 400 and 12 <= h <= 120 and w / h >= 1.5:
            if cv2.contourArea(c) >= 0.6 * w * h and (norm[y + 3:y + h - 3, x + 6:x + w - 6] > 170).mean() >= 0.6:
                frags.append((x, y, w, h))
        if not (40 <= w <= 1000 and 30 <= h <= 220):
            continue
        wide = w / h >= 2.5
        if cv2.contourArea(c) < 0.8 * w * h and not (wide and cv2.contourArea(cv2.convexHull(c)) >= 0.85 * w * h):
            continue
        inner = norm[y + 8:y + h - 8, x + 8:x + w - 8]
        if inner.size == 0:
            continue
        # 中身は白地に太字 → 明るい画素が多い
        if (inner > 170).mean() < (0.3 if wide else 0.5):
            continue
        boxes.append((x, y, w, h))
boxes = list(set(boxes))

# 番号枠の標準の高さを推定（地図ごとに縮尺が違うため）
hs = [h for x, y, w, h in boxes if 1.1 <= w / h <= 2.6 and h <= 120 and border_ok(x, y, w, h)]
HM = float(np.median(hs)) if hs else 42.0

def ink(x, y, w, h):
    # 枠の中央部分の文字（黒い画素）の割合
    return (norm[y + h // 4:y + 3 * h // 4, x + w // 4:x + 3 * w // 4] < 120).mean()

# 上下に分断された番号枠を復元（「236-238」のように文字が横いっぱいの枠）
frags = sorted(set(frags))
for i, a in enumerate(frags):
    for c in frags[i + 1:]:
        if c[0] - a[0] > 10:
            break
        if abs((a[0] + a[2]) - (c[0] + c[2])) > 10:
            continue
        top, bot = (a, c) if a[1] < c[1] else (c, a)
        gap = bot[1] - (top[1] + top[3])
        if gap <= 0 or gap > 0.8 * HM:
            continue
        x0 = min(a[0], c[0]); x1 = max(a[0] + a[2], c[0] + c[2])
        m = (x0, top[1], x1 - x0, bot[1] + bot[3] - top[1])
        if not (0.75 * HM <= m[3] <= 1.4 * HM and 1.0 <= m[2] / m[3] <= 3.2):
            continue
        if lines[top[1] + top[3]:bot[1], x0 + 6:x1 - 6].any():
            continue
        if border_ok(*m) and ink(*m) >= 0.05:
            boxes.append(m)

def standalone_num(b):
    x, y, w, h = b
    return 0.75 * HM <= h <= 1.3 * HM and 1.0 <= w / h <= 3.2 and border_ok(*b) and ink(*b) >= 0.05

# 同じ高さで横に並ぶ断片を結合（文字で枠内が分断された地名ラベル）
changed = True
while changed:
    changed = False
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            a, c = boxes[i], boxes[j]
            if abs(a[1] - c[1]) > 0.35 * HM or abs(a[3] - c[3]) > 0.35 * HM:
                continue
            gap = max(a[0], c[0]) - min(a[0] + a[2], c[0] + c[2])
            if gap > 8 * HM:
                continue
            if standalone_num(a) or standalone_num(c):
                continue  # 完結した番号枠は結合しない
            x0, y0 = min(a[0], c[0]), min(a[1], c[1])
            x1, y1 = max(a[0] + a[2], c[0] + c[2]), max(a[1] + a[3], c[1] + c[3])
            m = (x0, y0, x1 - x0, y1 - y0)
            if m[2] / m[3] < 2.8 or m[3] < 0.9 * HM or m[3] > 2.0 * HM:
                continue
            if gap > 0:
                gx0 = min(a[0] + a[2], c[0] + c[2]); gx1 = max(a[0], c[0])
                if lines[y0 + 6:y1 - 6, gx0:gx1].any():
                    continue  # 間に区域線がある＝別々の枠
                if not border_ok(*m, th=0.3):
                    continue
            boxes = [b for k, b in enumerate(boxes) if k not in (i, j)] + [m]
            changed = True
            break
        if changed:
            break

def runs(prof):
    # 黒い区間の長さの一覧
    r = []; n = 0
    for v in prof:
        if v:
            n += 1
        elif n:
            r.append(n); n = 0
    if n:
        r.append(n)
    return r

def dashed_line(band):
    # 帯の中のどれかの行（または列）が点線になっているか
    for prof in band:
        if not (0.35 <= prof.mean() <= 0.98):
            continue
        r = runs(prof)
        if len(r) < max(2, len(prof) / (1.0 * HM)):
            continue
        if 0.08 * HM <= float(np.median(r)) <= 0.6 * HM:
            return True
    return False

def dashed(x, y, w, h, sides=False):
    # 上下の辺が左右それぞれの半分で点線になっているか（写真の傾きに対応）
    for yy in (y, y + h):
        for x0, x1 in ((x, x + w // 2), (x + w // 2, x + w)):
            band = dark2[max(0, yy - 9):yy + 10, x0:x1] > 0
            if band.size == 0 or not dashed_line(band):
                return False
    if sides:
        # 左右の辺に縦線があり、そのすぐ内側（文字との間の余白）が白いか
        m = max(5, int(0.12 * h))
        for xx, x0, x1 in ((x, x + 8, x + 8 + m), (x + w, x + w - 8 - m, x + w - 8)):
            band = (dark2[y:y + h, max(0, xx - 9):xx + 10] > 0).T
            if band.size == 0 or band.mean(axis=1).max() < 0.5:
                return False
            if (norm[y + 10:y + h - 10, x0:x1] < 120).mean() > 0.04:
                return False
    return True

def kind(x, y, w, h):
    r = w / h
    if h < 2.2 * HM and ink(x, y, w, h) < 0.05:
        return None  # 文字がない＝番号枠ではない
    if 0.75 * HM <= h <= 1.4 * HM and 1.2 <= r <= 3.2:
        # 番号は枠の中央にあり、上下の余白には何もない
        t = norm[y + 8:y + h // 4 + 2, x + 8:x + w - 8]
        btm = norm[y + 3 * h // 4 - 2:y + h - 8, x + 8:x + w - 8]
        if (t < 120).mean() <= 0.03 and (btm < 120).mean() <= 0.03:
            return 'num'
    if 0.75 * HM <= h <= 2.0 * HM and r >= 2.2:
        if not dashed(x, y, w, h, sides=True):
            return None
        return 'place'
    if h >= 1.8 * HM and w >= 3 * HM:
        # 表題の枠は中がほぼ真っ白
        if (norm[y + 15:y + h - 15, x + 15:x + w - 15] > 230).mean() >= 0.5:
            return 'title'
    return None

def trim(b):
    # 横長の候補について、点線の枠の四辺を探し直す
    # （左右に余計な部分がついた候補・傾いていて小さく取れた候補の両方に対応）
    x, y, w, h = b
    if w / h < 2.2 or not (0.55 * HM <= h <= 2.0 * HM):
        return None
    e = int(0.6 * HM)
    ex0, ex1 = max(0, x - e), min(W, x + w + e)
    cov = (dark2[y + 5:y + h - 5, ex0:ex1] > 0).mean(axis=0)
    cols = [i for i in range(ex1 - ex0) if cov[i] >= 0.5]
    lefts = [c for k, c in enumerate(cols) if k == 0 or c - cols[k - 1] > 3][:12]
    rights = [c for k, c in enumerate(cols) if k == len(cols) - 1 or cols[k + 1] - c > 3][::-1][:12]
    d = int(0.5 * HM)
    for L in lefts:
        for R in rights:
            if R - L < 2.2 * 0.75 * HM:
                continue
            seg = dark2[:, ex0 + L:ex0 + R + 1] > 0
            rc = seg.mean(axis=1)
            t0 = max(0, y - d); top = t0 + int(rc[t0:y + d].argmax())
            b0 = max(0, y + h - d); bot = b0 + int(rc[b0:min(H, y + h + d)].argmax())
            nb = (ex0 + L, top, R - L + 1, bot - top)
            if nb[3] > 0 and nb[2] / nb[3] >= 2.2 and kind(*nb) == 'place':
                return nb
    return None

extra = []
for b in boxes:
    if kind(*b) is None:
        t = trim(b)
        if t:
            extra.append(t)
boxes = boxes + extra

boxes = [b for b in boxes if kind(*b) and border_ok(*b, th=0.3 if kind(*b) == 'place' else 0.45)]
print("HM", HM)
import os
if os.environ.get("DBG"):
    [print("B", b, kind(*b), round((norm[b[1]+8:b[1]+b[3]-8, b[0]+8:b[0]+b[2]-8] < 120).mean(), 3), round((norm[b[1]+8:b[1]+b[3]-8, b[0]+8:b[0]+b[2]-8] > 200).mean(), 3)) for b in boxes]

# 入れ子を除去（外側の箱だけ残す）
boxes.sort(key=lambda b: -b[2] * b[3])
keep = []
for b in boxes:
    x, y, w, h = b
    def inter(X, Y, W2, H2):
        return max(0, min(x + w, X + W2) - max(x, X)) * max(0, min(y + h, Y + H2) - max(y, Y))
    if any(inter(*k) > 0.25 * w * h for k in keep):
        continue  # 入れ子・大きく重なる枠
    keep.append(b)

# ---- 引き出し線：地名ラベルの縁から黒丸まで、元画像で途切れずに続く直線を探して描き直す ----
darkp = cv2.dilate((norm < 120).astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))) > 0
dt = cv2.distanceTransform((norm < 90).astype(np.uint8), cv2.DIST_L2, 5)
nd_, ld_, sd_, _ = cv2.connectedComponentsWithStats((dt >= 0.9 * TL).astype(np.uint8), 8)
dots = []
for i in range(1, nd_):
    x, y, w, h, a = sd_[i]
    if max(w, h) > 1.2 * HM:
        continue  # 大きすぎる塊（黒塗りの建物など）
    sub = np.where(ld_[y:y + h, x:x + w] == i, dt[y:y + h, x:x + w], 0)
    yy, xx = np.unravel_index(sub.argmax(), sub.shape)
    dots.append((x + xx, y + yy, float(sub.max())))

def perimeter(b, step=4):
    x, y, w, h = b
    p = [(xx, y) for xx in range(x, x + w, step)] + [(xx, y + h) for xx in range(x, x + w, step)]
    p += [(x, yy) for yy in range(y, y + h, step)] + [(x + w, yy) for yy in range(y, y + h, step)]
    return np.array(p, float)

pairs = []
places = [b for b in keep if kind(*b) == 'place']
for li, b in enumerate(places):
    per = perimeter(b)
    for di, (cx, cy, r) in enumerate(dots):
        if b[0] - 2 <= cx <= b[0] + b[2] + 2 and b[1] - 2 <= cy <= b[1] + b[3] + 2:
            continue
        v = per - (cx, cy)
        L = np.hypot(v[:, 0], v[:, 1])
        if L.min() > 18 * HM:
            continue
        t = np.linspace(0, 1, 120)
        # 黒丸の縁からラベルの手前までを調べる
        t0 = (r + 3) / np.maximum(L, 1); t1 = 1 - 4 / np.maximum(L, 1)
        tt = t0[:, None] + (t1 - t0)[:, None] * t[None, :]
        px = np.clip((cx + v[:, 0:1] * tt).round().astype(int), 0, W - 1)
        py = np.clip((cy + v[:, 1:2] * tt).round().astype(int), 0, H - 1)
        cov = darkp[py, px].mean(axis=1)
        cov[L < 1.0 * HM] = 0
        k = int(np.argmax(cov - L / (1000 * HM)))
        if cov[k] >= 0.93:
            pairs.append((float(cov[k]), li, di, tuple(per[k].astype(int))))
pairs.sort(reverse=True)
used_l, used_d, pointers = set(), set(), []
for c, li, di, pt in pairs:
    if li in used_l or di in used_d:
        continue
    used_l.add(li); used_d.add(di)
    pointers.append((dots[di], pt))
print('pointers:', len(pointers), '/', len(places))

rgba = np.zeros((H, W, 4), np.uint8)
# 区域線の網から離れた切れ端（線路・池など）を除く。地名ラベルにつながる引き出し線は残す
n2, lab2, st2, _ = cv2.connectedComponentsWithStats(lines, 8)
if n2 > 1:
    big = st2[1:, 4].max()
    m = int(0.5 * HM)
    for i in range(1, n2):
        x, y, w, h, a = st2[i]
        if a >= 0.03 * big:
            continue
        touch = any(x - m < X + W2 and X < x + w + m and y - m < Y + H2 and Y < y + h + m
                    for X, Y, W2, H2 in keep)
        if not touch:
            lines[lab2 == i] = 0
# 引き出し線に沿って残った元の線の切れ端（区域線の網とつながらないもの）を消す
if pointers:
    corr = np.zeros((H, W), np.uint8)
    for (cx, cy, r), (px_, py_) in pointers:
        cv2.line(corr, (int(cx), int(cy)), (int(px_), int(py_)), 255, int(1.2 * HM))
    n3, lab3, st3, _ = cv2.connectedComponentsWithStats(lines, 8)
    big3 = 1 + int(np.argmax(st3[1:, 4])) if n3 > 1 else -1
    for i in range(1, n3):
        if i == big3:
            continue
        comp = lab3 == i
        if (corr[comp] > 0).mean() >= 0.7:
            lines[comp] = 0
    # 網とつながっていても、引き出し線に沿って長く伸びる部分は元の引き出し線の名残なので消す
    for (cx, cy, r), (px_, py_) in pointers:
        nc = np.zeros((H, W), np.uint8)
        cv2.line(nc, (int(cx), int(cy)), (int(px_), int(py_)), 255, int(3 * TL))
        seg = ((lines > 0) & (nc > 0)).astype(np.uint8)
        n4, lab4, st4, _ = cv2.connectedComponentsWithStats(seg, 8)
        for i in range(1, n4):
            if st4[i, 4] / (3 * TL) > 2.0 * HM:
                lines[lab4 == i] = 0
    rgba[...] = 0
    for x, y, w, h in keep:
        pad = 3
        x0, y0, x1, y1 = max(0, x - pad), max(0, y - pad), min(W, x + w + pad), min(H, y + h + pad)
        patch = norm[y0:y1, x0:x1]
        rgba[y0:y1, x0:x1] = (255, 255, 255, 255)
        rgba[y0:y1, x0:x1][patch < 120] = (0, 0, 0, 255)
rgba[lines > 0] = (0, 0, 0, 255)
pw = max(3, int(round(0.45 * TL)))
for (cx, cy, r), (px_, py_) in pointers:
    cv2.line(rgba, (int(cx), int(cy)), (int(px_), int(py_)), (0, 0, 0, 255), pw, cv2.LINE_AA)
    cv2.circle(rgba, (int(cx), int(cy)), int(round(r)) + 1, (0, 0, 0, 255), -1, cv2.LINE_AA)
for x, y, w, h in keep:
    pad = 3
    x0, y0, x1, y1 = max(0, x - pad), max(0, y - pad), min(W, x + w + pad), min(H, y + h + pad)
    patch = norm[y0:y1, x0:x1]
    txt = (patch < 120)
    rgba[y0:y1, x0:x1] = (255, 255, 255, 255)
    rgba[y0:y1, x0:x1][txt] = (0, 0, 0, 255)

print("labels:", len(keep)); [print(b) for b in sorted(keep, key=lambda b:b[3])]
ext = out.rsplit('.', 1)[-1].lower()
params = [cv2.IMWRITE_WEBP_QUALITY, 90] if ext == 'webp' else []
ok, buf = cv2.imencode('.' + ext, rgba, params)
buf.tofile(out)
# 確認用：白背景に合成
prev = np.full((H, W, 3), 255, np.uint8)
a = rgba[..., 3:4] / 255.0
prev = (prev * (1 - a) + rgba[..., :3] * a).astype(np.uint8)
cv2.imencode('.png', prev)[1].tofile(out.rsplit('.', 1)[0] + '_preview.png')
