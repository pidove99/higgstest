#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""캐릭터 시트 한 장 → 낱장 스프라이트(투명 PNG).

시트 안의 패널 테두리/라벨 글씨는 무시하고 '덩어리진 그림'만 골라낸다.
방식: 배경색을 코너에서 추정 → 배경이 아닌 픽셀 마스크 → 연결요소 라벨링 →
      크기·채움비율로 스프라이트만 남김 → 읽는 순서(위→아래, 왼→오른쪽)로 이름 부여.

사용:
  python3 slice.py source/pidove-sheet.png -o sprites/ [--debug]
"""

import argparse
import collections
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# 시트에 그려진 순서대로 붙일 이름. 개수가 다르면 sprite_0.. 로 떨어진다.
DEFAULT_NAMES = [
    "front", "three_quarter", "side",
    "back", "expr_neutral", "expr_happy", "expr_excited",
]


def estimate_bg(arr, probe=12):
    """네 모서리에서 가장 흔한 색을 배경으로 본다."""
    h, w = arr.shape[:2]
    corners = np.concatenate([
        arr[:probe, :probe].reshape(-1, 3),
        arr[:probe, -probe:].reshape(-1, 3),
        arr[-probe:, :probe].reshape(-1, 3),
        arr[-probe:, -probe:].reshape(-1, 3),
    ])
    colors, counts = np.unique(corners, axis=0, return_counts=True)
    return colors[counts.argmax()].astype(np.int16)


def open_mask(mask, k):
    """형태학적 열기: k 픽셀보다 가는 구조(패널 테두리·라벨 획)를 지운다.

    그림이 패널 테두리에 닿아 있으면 둘이 한 덩어리로 이어져 액자가 통째로
    스프라이트에 딸려 들어온다. 먼저 선을 끊어놓고 덩어리만 찾는다."""
    if k < 3:
        return mask
    k = k if k % 2 else k + 1
    im = Image.fromarray((mask * 255).astype(np.uint8), "L")
    im = im.filter(ImageFilter.MinFilter(k)).filter(ImageFilter.MaxFilter(k))
    return np.asarray(im) > 127


def regrow(comp, original, r):
    """열기로 깎여나간 가장자리를 원본 마스크 안에서 r 픽셀만큼만 되살린다.

    무제한으로 되살리면 닿아 있던 테두리를 타고 다시 번지므로 반경을 묶어 둔다."""
    if r < 1:
        return comp & original
    im = Image.fromarray((comp * 255).astype(np.uint8), "L")
    im = im.filter(ImageFilter.MaxFilter(r * 2 + 1))
    return (np.asarray(im) > 127) & original


def label_components(mask):
    """8-이웃 연결요소 라벨링. (scipy 없이 BFS)"""
    h, w = mask.shape
    labels = np.zeros((h, w), np.int32)
    cur = 0
    ys, xs = np.nonzero(mask)
    for sy, sx in zip(ys, xs):
        if labels[sy, sx]:
            continue
        cur += 1
        q = collections.deque([(sy, sx)])
        labels[sy, sx] = cur
        while q:
            y, x = q.popleft()
            y0, y1 = max(0, y - 1), min(h, y + 2)
            x0, x1 = max(0, x - 1), min(w, x + 2)
            sub_m = mask[y0:y1, x0:x1]
            sub_l = labels[y0:y1, x0:x1]
            todo = sub_m & (sub_l == 0)
            if not todo.any():
                continue
            sub_l[todo] = cur
            for dy, dx in zip(*np.nonzero(todo)):
                q.append((y0 + dy, x0 + dx))
    return labels, cur


def components(labels, n):
    """라벨별 bbox / 픽셀수 / 채움비율."""
    out = []
    for i in range(1, n + 1):
        ys, xs = np.nonzero(labels == i)
        if not len(ys):
            continue
        y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
        bw, bh = x1 - x0, y1 - y0
        out.append({
            "id": i, "box": (int(x0), int(y0), int(x1), int(y1)),
            "px": int(len(ys)), "w": int(bw), "h": int(bh),
            "fill": float(len(ys)) / float(bw * bh),
        })
    return out


def is_sprite(c, area, min_area_frac, min_fill, min_side):
    """패널 테두리(얇고 넓음)와 라벨 글씨(작음)를 걸러낸다."""
    if c["w"] < min_side or c["h"] < min_side:
        return False
    if c["px"] < area * min_area_frac:
        return False
    return c["fill"] >= min_fill


def merge_nearby(sprites, gap=30, overlap=0.4):
    """세로로 쪼개진 한 캐릭터의 조각들을 하나로 합친다 (--merge-nearby 일 때만).

    기본적으로는 쓰지 않는다. 시트의 디더링 그림자가 본체와 떨어진 별개 덩어리라
    합치지 않아야 투명 배경 스프라이트가 깔끔하게 나오기 때문이다."""
    sprites = sorted(sprites, key=lambda c: -c["px"])
    kept = []
    for c in sprites:
        x0, y0, x1, y1 = c["box"]
        for k in kept:
            kx0, ky0, kx1, ky1 = k["box"]
            ox = min(x1, kx1) - max(x0, kx0)
            if ox <= 0:
                continue
            narrower = min(x1 - x0, kx1 - kx0)
            near = 0 <= (y0 - ky1) <= gap or (y0 < ky1 and y1 > ky0)
            if ox / float(narrower) >= overlap and near:
                k["box"] = (min(x0, kx0), min(y0, ky0), max(x1, kx1), max(y1, ky1))
                k["px"] += c["px"]
                k["ids"] = k.get("ids", [k["id"]]) + c.get("ids", [c["id"]])
                break
        else:
            kept.append(c)
    return kept


def reading_order(sprites, row_tol=0.4):
    """위에서 아래로, 각 줄 안에서는 왼쪽에서 오른쪽으로."""
    if not sprites:
        return []
    heights = [c["box"][3] - c["box"][1] for c in sprites]
    tol = max(heights) * row_tol
    rows, rest = [], sorted(sprites, key=lambda c: c["box"][1])
    for c in rest:
        cy = (c["box"][1] + c["box"][3]) / 2.0
        for row in rows:
            if abs(cy - row["cy"]) <= tol:
                row["items"].append(c)
                row["cy"] = sum((i["box"][1] + i["box"][3]) / 2.0 for i in row["items"]) / len(row["items"])
                break
        else:
            rows.append({"cy": cy, "items": [c]})
    out = []
    for row in sorted(rows, key=lambda r: r["cy"]):
        out.extend(sorted(row["items"], key=lambda c: c["box"][0]))
    return out


def dither_mask(on, density=0.18, win=9):
    """디더링(체커보드) 픽셀을 찾는다.

    체커보드는 켜진 픽셀의 상하좌우가 모두 꺼져 있다는 성질이 있다 — solid 그림에는
    거의 없는 특징이다. 그 '외톨이 픽셀'의 국소 밀도가 높은 곳만 디더링 영역으로 본다.
    (캐릭터 실루엣의 안티에일리어싱 가장자리를 갉아먹지 않으려는 안전장치)"""
    up, dn, lf, rt = (np.zeros_like(on) for _ in range(4))
    up[:-1], dn[1:], lf[:, :-1], rt[:, 1:] = on[1:], on[:-1], on[:, 1:], on[:, :-1]
    lonely = on & ~up & ~dn & ~lf & ~rt
    if not lonely.any():
        return np.zeros_like(on)
    box = Image.fromarray((lonely * 255).astype(np.uint8), "L").filter(
        ImageFilter.BoxBlur(win // 2))
    dense = np.asarray(box).astype(np.float32) / 255.0 >= density
    return lonely & dense


def ensure_margin(img, m=2):
    """그림이 이미지 테두리에 닿아 있으면 투명 여백을 덧댄다.

    닿은 채로 두면 나중에 크기를 줄일 때 그 하드 엣지가 사각 테두리로 번진다."""
    a = np.asarray(img)[:, :, 3]
    if a.size and max(a[0].max(), a[-1].max(), a[:, 0].max(), a[:, -1].max()) == 0:
        return img
    w, h = img.size
    out = Image.new("RGBA", (w + m * 2, h + m * 2), (0, 0, 0, 0))
    out.paste(img, (m, m))
    return out


def cutout(img_rgb, bg, box, pad, key_tol, soft, keep=None, grow=3, strip_dither=True):
    """bbox 를 잘라 배경색을 알파로 뺀다.

    keep 이 주어지면 그 덩어리(연결요소)에 속한 픽셀만 남긴다. 안티에일리어싱된
    가장자리가 살아남도록 마스크를 grow 픽셀만큼 부풀린 뒤 곱한다. 덕분에 시트의
    디더링 그림자나 옆 패널 테두리가 스프라이트에 섞여 들어오지 않는다."""
    x0, y0, x1, y1 = box
    W, H = img_rgb.size
    x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
    x1, y1 = min(W, x1 + pad), min(H, y1 + pad)
    crop = np.asarray(img_rgb.crop((x0, y0, x1, y1))).astype(np.int16)
    dist = np.abs(crop - bg.reshape(1, 1, 3)).max(axis=2)
    alpha = np.clip((dist - key_tol) / float(max(soft, 1)), 0.0, 1.0)

    if strip_dither:
        on = alpha > 0.5
        d = dither_mask(on)
        if d.any():
            # 디더링 점을 지우고, 남은 반쪽짜리 이웃까지 한 번 더 정리
            alpha[d] = 0.0
            on = alpha > 0.5
            alpha[dither_mask(on)] = 0.0

    if keep is not None:
        sub = keep[y0:y1, x0:x1]
        m = Image.fromarray((sub * 255).astype(np.uint8), "L")
        if grow > 0:
            m = m.filter(ImageFilter.MaxFilter(grow * 2 + 1))
        alpha = alpha * (np.asarray(m).astype(np.float32) / 255.0)

    rgba = np.dstack([crop.astype(np.uint8), (alpha * 255).astype(np.uint8)])
    return ensure_margin(Image.fromarray(rgba, "RGBA"), max(2, grow))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sheet")
    ap.add_argument("-o", "--out", default="sprites")
    ap.add_argument("--tol", type=int, default=16, help="배경으로 볼 색 허용 오차")
    ap.add_argument("--key-tol", type=int, default=10, help="알파를 뺄 때의 배경 오차")
    ap.add_argument("--soft", type=int, default=14, help="가장자리 부드러움")
    ap.add_argument("--min-area-frac", type=float, default=0.0015)
    ap.add_argument("--min-fill", type=float, default=0.12)
    ap.add_argument("--min-side", type=int, default=24)
    ap.add_argument("--pad", type=int, default=6, help="bbox 바깥으로 더 잘라올 여백")
    ap.add_argument("--grow", type=int, default=3, help="본체 마스크를 부풀릴 픽셀 (가장자리 보존)")
    ap.add_argument("--open", type=int, default=7,
                    help="이보다 가는 선(패널 테두리·라벨)은 무시. 0이면 끄기")
    ap.add_argument("--keep-shadow", action="store_true",
                    help="디더링 그림자를 지우지 않고 그대로 둔다")
    ap.add_argument("--merge-nearby", action="store_true",
                    help="세로로 쪼개진 조각을 한 캐릭터로 합침")
    ap.add_argument("--names", default=",".join(DEFAULT_NAMES))
    ap.add_argument("--debug", action="store_true", help="검출 결과를 그린 미리보기 저장")
    a = ap.parse_args()

    img = Image.open(a.sheet).convert("RGB")
    arr = np.asarray(img).astype(np.int16)
    bg = estimate_bg(arr)
    mask = np.abs(arr - bg.reshape(1, 1, 3)).max(axis=2) > a.tol

    opened = open_mask(mask, a.open)
    labels, n = label_components(opened)
    comps = components(labels, n)
    area = float(mask.size)
    sprites = [c for c in comps if is_sprite(c, area, a.min_area_frac, a.min_fill, a.min_side)]
    if a.merge_nearby:
        sprites = merge_nearby(sprites)
    sprites = reading_order(sprites)

    os.makedirs(a.out, exist_ok=True)
    names = [s.strip() for s in a.names.split(",") if s.strip()]
    manifest = {"sheet": os.path.basename(a.sheet), "bg": bg.tolist(), "sprites": []}

    for i, c in enumerate(sprites):
        name = names[i] if i < len(names) else "sprite_%d" % i
        # 열기로 찾은 덩어리를 원본 마스크 안에서 조금만 되살려 실제 실루엣을 얻는다
        keep = regrow(np.isin(labels, c.get("ids", [c["id"]])), mask, a.open // 2 + a.grow)
        ys, xs = np.nonzero(keep)
        box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
        sp = cutout(img, bg, box, a.pad, a.key_tol, a.soft, keep, a.grow,
                    strip_dither=not a.keep_shadow)
        path = os.path.join(a.out, name + ".png")
        sp.save(path)
        manifest["sprites"].append(
            {"name": name, "file": os.path.basename(path),
             "box": list(box), "size": list(sp.size)})
        print("  %-14s %4dx%-4d  px=%-7d fill=%.2f  -> %s"
              % (name, sp.size[0], sp.size[1], c["px"], c["fill"], path))

    with open(os.path.join(a.out, "sprites.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    if a.debug:
        dbg = img.copy()
        d = ImageDraw.Draw(dbg)
        for c in comps:
            keep = c in sprites
            d.rectangle(c["box"], outline=(0, 190, 0) if keep else (230, 60, 60), width=2)
        p = os.path.join(a.out, "_debug.png")
        dbg.save(p)
        print("  디버그 미리보기: %s (초록=채택, 빨강=버림)" % p)

    print("\n스프라이트 %d개 추출 (배경색 rgb%s)" % (len(sprites), tuple(bg.tolist())))
    if len(sprites) != len(names):
        print("!! 기대한 %d개와 다릅니다. --debug 로 확인하고 --min-fill/--min-area-frac 을 조절하세요."
              % len(names), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
