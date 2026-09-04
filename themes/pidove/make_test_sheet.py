#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""파이프라인 검증용 합성 캐릭터 시트.

진짜 시트와 같은 구조(크림 배경 · 얇은 회색 패널 테두리 · 좌상단 라벨 ·
디더링 그림자)를 흉내내서 slice.py 의 검출을 시험한다.
"""
import sys
from PIL import Image, ImageDraw

BG = (242, 240, 234)
BORDER = (200, 198, 192)
LABEL = (70, 70, 78)
BODY = (150, 152, 158)
BELLY = (196, 196, 198)
GREEN = (108, 168, 138)
PURPLE = (150, 132, 178)
BEAK = (214, 156, 118)
FOOT = (198, 130, 106)


def dither_shadow(d, cx, cy, rx, ry):
    for y in range(cy - ry, cy + ry + 1):
        for x in range(cx - rx, cx + rx + 1):
            if ((x - cx) / float(rx)) ** 2 + ((y - cy) / float(ry)) ** 2 <= 1.0:
                if (x + y) % 2 == 0:
                    d.point((x, y), fill=(214, 212, 206))


def bird(d, cx, base, s, view="front", eyes="open"):
    """아주 대충 그린 비둘기. 검출기만 속이면 된다."""
    bw, bh = int(s * 1.15), int(s * 1.3)
    dither_shadow(d, cx, base + int(s * 0.06), int(bw * 0.55), max(3, int(s * 0.08)))
    top = base - bh
    d.ellipse([cx - bw // 2, top, cx + bw // 2, base], fill=BODY)
    d.chord([cx - bw // 2, top + int(bh * 0.30), cx + bw // 2, base], 0, 180, fill=BELLY)
    d.chord([cx - bw // 2, top + int(bh * 0.24), cx + bw // 2, base - int(bh * 0.30)], 0, 180, fill=GREEN)
    d.chord([cx - bw // 2, top + int(bh * 0.34), cx + bw // 2, base - int(bh * 0.26)], 0, 180, fill=PURPLE)

    if view == "back":
        for i in range(3):
            yy = base - int(bh * 0.28) + i * max(2, s // 22)
            d.line([cx - bw // 3, yy, cx + bw // 3, yy], fill=(96, 100, 112), width=max(2, s // 40))
        return
    if view == "side":
        d.polygon([(cx + bw // 2 - 4, base - int(bh * 0.42)),
                   (cx + bw, base - int(bh * 0.16)),
                   (cx + bw // 2 - 4, base - int(bh * 0.22))], fill=(112, 116, 128))

    ex = int(bw * (0.13 if view == "side" else 0.19))
    ey = top + int(bh * 0.28)
    er = max(3, s // 16)
    for sx in ((-1, 1) if view != "side" else (-1,)):
        if eyes == "closed":
            d.arc([cx + sx * ex - er, ey - er, cx + sx * ex + er, ey + er], 200, 340,
                  fill=(24, 24, 28), width=max(2, er // 2))
        else:
            d.ellipse([cx + sx * ex - er, ey - er, cx + sx * ex + er, ey + er], fill=(24, 24, 28))
            d.ellipse([cx + sx * ex - er // 2, ey - er, cx + sx * ex, ey - er // 3], fill=(250, 250, 250))
    d.polygon([(cx - er, ey + int(er * 1.4)), (cx + er, ey + int(er * 1.4)),
               (cx, ey + int(er * 3.0))], fill=BEAK)
    if view != "side":
        for sx in (-1, 1):
            fx = cx + sx * int(bw * 0.17)
            d.line([fx, base - 2, fx, base + max(4, s // 14)], fill=FOOT, width=max(3, s // 26))


def panel(d, box, label):
    d.rectangle(box, outline=BORDER, width=3)
    d.text((box[0] + 22, box[1] + 16), label, fill=LABEL)


def main(out="themes/pidove/source/_test-sheet.png"):
    W, H = 2000, 1300
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    top = [(14, 10, 680, 640), (700, 10, 1300, 640), (1320, 10, 1986, 640)]
    for box, lab, view in zip(top, ["FRONT", "THREE-QUARTER", "SIDE"],
                              ["front", "three_quarter", "side"]):
        panel(d, box, lab)
        bird(d, (box[0] + box[2]) // 2 - (40 if view == "side" else 0), box[3] - 90,
             290 if view == "side" else 330, view=view)

    b = (14, 660, 600, 1290)
    panel(d, b, "BACK")
    bird(d, (b[0] + b[2]) // 2, b[3] - 90, 330, view="back")

    e = (620, 660, 1986, 1290)
    panel(d, e, "EXPRESSION")
    for i, eyes in enumerate(["open", "closed", "open"]):
        bird(d, e[0] + 250 + i * 400, e[3] - 110, 250, view="front", eyes=eyes)

    img.save(out)
    print("합성 시트 저장:", out, img.size)


if __name__ == "__main__":
    main(*sys.argv[1:])
