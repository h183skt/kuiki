"""Googleマップのスクリーンショットに黒線・黒数字を描いた区域図用（登戸区域_161-175）"""
import sys, cv2, numpy as np

src, out = sys.argv[1], sys.argv[2]
im = cv2.imdecode(np.fromfile(src, np.uint8), 1)
H, W = im.shape[:2]
hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV)
g = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)

# 真っ黒（暗くて色みのない）画素だけ
black = ((g < 70) & (hsv[..., 1] < 60)).astype(np.uint8) * 255

n, lab, st, _ = cv2.connectedComponentsWithStats(black, 8)
big = 1 + int(np.argmax(st[1:, 4]))  # 一番大きい塊＝区域線の網
net = (lab == big).astype(np.uint8) * 255

# 区域線の外形（凸包）の内側だけを対象にする（検索欄やボタンなどを除く）
pts = cv2.findNonZero(net)
hull = cv2.convexHull(pts)
area = np.zeros((H, W), np.uint8)
cv2.fillConvexPoly(area, hull, 255)
area = cv2.dilate(area, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))

keep = net.copy()
digits = np.zeros_like(net)
for i in range(1, n):
    if i == big:
        continue
    x, y, w, h, a = st[i]
    if a < 30 or not area[y + h // 2, x + w // 2]:
        continue
    comp = (lab == i)
    if max(w, h) >= 150:
        keep[comp] = 255  # 網から切れた区域線
    elif 20 <= h <= 60:
        digits[comp] = 255  # 番号の数字

# 数字は並んで現れる。近くに他の数字がない孤立した塊は除く
nd, ld, sd, cd = cv2.connectedComponentsWithStats(digits, 8)
for i in range(1, nd):
    near = sum(1 for j in range(1, nd) if j != i and abs(cd[j][0] - cd[i][0]) < 70 and abs(cd[j][1] - cd[i][1]) < 20)
    if near == 0:
        digits[ld == i] = 0

rgba = np.zeros((H, W, 4), np.uint8)
# 数字の周りに白い縁取り（地図の上でも読めるように）
halo = cv2.dilate(digits, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (13, 13)))
rgba[halo > 0] = (255, 255, 255, 255)
rgba[keep > 0] = (0, 0, 0, 255)
rgba[digits > 0] = (0, 0, 0, 255)

ok, buf = cv2.imencode('.webp', rgba, [cv2.IMWRITE_WEBP_QUALITY, 90])
buf.tofile(out)
print('digits comps:', cv2.connectedComponents(digits)[0] - 1)
