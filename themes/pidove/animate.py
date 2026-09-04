#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""낱장 스프라이트 → clawd-on-desk 테마(APNG 상태 애니메이션 + theme.json).

한 장짜리 정지 그림만 있어도, 이동·스쿼시·회전·흔들림과 말풍선 글리프를
조합해서 상태별 애니메이션을 만들어낸다.

사용:
  python3 animate.py sprites/ -o build/ --name Pidove
"""

import argparse
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

INK = (58, 62, 74)      # 글리프 본색
HALO = (255, 255, 255)  # 어떤 배경에서도 보이도록 두르는 테두리


# ---------------------------------------------------------------- 픽셀아트 유틸

def guess_module(sprite, lo=1, hi=16):
    """업스케일된 픽셀아트의 '한 픽셀'이 몇 배로 커져 있는지 추정.

    불투명 영역의 가로 런렝스를 모아 최대공약수를 본다."""
    a = np.asarray(sprite)[:, :, 3] > 128
    runs = []
    for row in a[:: max(1, a.shape[0] // 64)]:
        idx = np.flatnonzero(np.diff(np.concatenate(([0], row.view(np.int8), [0]))))
        runs.extend((idx[1::2] - idx[::2]).tolist())
    runs = [r for r in runs if r >= lo]
    if len(runs) < 8:
        return 1
    g = 0
    for r in runs:
        g = math.gcd(g, int(r))
        if g == 1:
            return 1
    return max(1, min(hi, g))


def downscale(sprite, target_h, module="auto"):
    """스프라이트를 목표 높이로 줄인다. 픽셀아트면 격자를 살려서."""
    if module == "auto":
        module = guess_module(sprite)
    if isinstance(module, int) and module > 1:
        w, h = sprite.size
        sprite = sprite.resize((max(1, w // module), max(1, h // module)), Image.NEAREST)
    w, h = sprite.size
    if h == target_h:
        return sprite
    scale = target_h / float(h)
    nw, nh = max(1, int(round(w * scale))), target_h
    # 확대는 픽셀 유지(NEAREST), 축소는 부드럽게(BOX)
    return sprite.resize((nw, nh), Image.NEAREST if scale >= 1 else Image.BOX)


def despeckle(img, floor=8):
    """리샘플링(확대·축소·회전) 뒤 남는 아주 옅은 알파를 0으로 눌러 준다.

    이걸 안 하면 스프라이트 경계선이 배경 위에 옅은 사각 테두리로 보인다."""
    a = np.asarray(img).copy()
    a[:, :, 3][a[:, :, 3] < floor] = 0
    return Image.fromarray(a, "RGBA")


def tinted(img, rgb, amount):
    if amount <= 0:
        return img
    base = np.asarray(img).astype(np.float32)
    lay = np.array(rgb, np.float32).reshape(1, 1, 3)
    base[:, :, :3] = base[:, :, :3] * (1 - amount) + lay * amount
    return Image.fromarray(base.astype(np.uint8), "RGBA")


# ---------------------------------------------------------------- 프레임 합성

class Stage(object):
    """모든 상태가 같은 캔버스·같은 바닥선을 쓰도록 묶는 무대."""

    def __init__(self, sprites, body_h, canvas, baseline):
        self.sprites = sprites
        self.body_h = body_h
        self.W, self.H = canvas
        self.baseline = baseline

    def frame(self):
        return Image.new("RGBA", (self.W, self.H), (0, 0, 0, 0))

    def draw(self, name, dx=0.0, dy=0.0, sx=1.0, sy=1.0, rot=0.0,
             tint=None, flip=False, canvas=None):
        img = canvas if canvas is not None else self.frame()
        sp = self.sprites[name]
        if flip:
            sp = sp.transpose(Image.FLIP_LEFT_RIGHT)
        if sx != 1.0 or sy != 1.0:
            w, h = sp.size
            sp = sp.resize((max(1, int(round(w * sx))), max(1, int(round(h * sy)))),
                           Image.BICUBIC)
        if rot:
            sp = sp.rotate(rot, resample=Image.BICUBIC, expand=True)
        if sx != 1.0 or sy != 1.0 or rot:
            sp = despeckle(sp)      # 리샘플링이 남긴 유령 알파 제거
        if tint:
            sp = tinted(sp, tint[0], tint[1])
        w, h = sp.size
        x = int(round((self.W - w) / 2.0 + dx))
        y = int(round(self.baseline - h + dy))
        img.alpha_composite(sp, (x, y))
        return img


def glyph(img, kind, cx, cy, size, alpha=1.0):
    """머리 위에 띄우는 작은 기호. 어떤 배경에서도 읽히도록 흰 테두리를 두른다."""
    lay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    s = size
    if kind == "dot":
        d.ellipse([cx - s, cy - s, cx + s, cy + s], fill=INK + (255,))
    elif kind == "bang":
        d.rectangle([cx - s * 0.35, cy - s * 1.6, cx + s * 0.35, cy + s * 0.5],
                    fill=INK + (255,))
        d.ellipse([cx - s * 0.42, cy + s * 0.9, cx + s * 0.42, cy + s * 1.74],
                  fill=INK + (255,))
    elif kind == "z":
        d.line([(cx - s, cy - s), (cx + s, cy - s), (cx - s, cy + s), (cx + s, cy + s)],
               fill=INK + (255,), width=max(2, int(s * 0.45)), joint="curve")
    elif kind == "dash":
        d.line([(cx - s, cy), (cx + s, cy)], fill=INK + (255,), width=max(2, int(s * 0.5)))

    halo = lay.filter(ImageFilter.MaxFilter(5))
    halo = Image.composite(Image.new("RGBA", img.size, HALO + (255,)),
                           Image.new("RGBA", img.size, (0, 0, 0, 0)), halo.split()[3])
    if alpha < 1.0:
        for im in (halo, lay):
            a = im.split()[3].point(lambda v: int(v * alpha))
            im.putalpha(a)
    img.alpha_composite(halo)
    img.alpha_composite(lay)
    return img


# ---------------------------------------------------------------- 상태별 연출

def ease(t):
    return 0.5 - 0.5 * math.cos(2 * math.pi * t)


def build_states(st, has):
    """상태 이름 -> (프레임 리스트, 프레임 간격 ms)"""
    full = "front" if has("front") else list(st.sprites)[0]
    tq = "three_quarter" if has("three_quarter") else full
    side = "side" if has("side") else tq
    back = "back" if has("back") else full
    excited = "expr_excited" if has("expr_excited") else full
    happy = "expr_happy" if has("expr_happy") else excited

    head_y = st.baseline - st.body_h
    gx, gy, gs = st.W // 2, max(8, head_y - st.body_h * 0.16), max(3, st.body_h * 0.055)
    out = {}

    # 유휴: 숨쉬기
    fr = []
    for i in range(8):
        t = ease(i / 8.0)
        fr.append(st.draw(full, dy=-1.2 * t, sy=1.0 + 0.018 * t, sx=1.0 - 0.010 * t))
    out["idle"] = (fr, 170)

    # 생각 중: 고개 갸웃 + 점 세 개
    fr = []
    for i in range(9):
        t = i / 9.0
        f = st.draw(tq, rot=-3.5 * math.sin(2 * math.pi * t), dy=-1.0 * ease(t))
        for k in range(3):
            if i % 9 >= (k + 1) * 2:
                glyph(f, "dot", gx + (k - 1) * gs * 2.6, gy, gs)
        fr.append(f)
    out["thinking"] = (fr, 150)

    # 작업 중: 빠른 상하 + 속도선
    fr = []
    for i in range(6):
        t = i / 6.0
        f = st.draw(side, dy=-3.0 * ease(t), sy=1.0 + 0.02 * ease(t))
        if i % 2 == 0:
            glyph(f, "dash", gx - st.body_h * 0.42, gy + gs, gs * 1.1)
            glyph(f, "dash", gx - st.body_h * 0.34, gy + gs * 3.4, gs * 0.8)
        fr.append(f)
    out["working"] = (fr, 95)

    # 서브에이전트 2개: 좌우로 부산하게
    fr = []
    for i in range(8):
        t = i / 8.0
        fr.append(st.draw(tq, dx=3.5 * math.sin(2 * math.pi * t),
                          dy=-4.0 * abs(math.sin(2 * math.pi * t)), flip=(i >= 4)))
    out["juggling"] = (fr, 90)

    # 서브에이전트 3개 이상: 등 돌리고 몰두
    fr = []
    for i in range(6):
        t = i / 6.0
        f = st.draw(back, dy=-2.5 * ease(t), sx=1.0 + 0.015 * ease(t))
        if i % 2:
            glyph(f, "dash", gx + st.body_h * 0.40, gy + gs * 2, gs)
        fr.append(f)
    out["building"] = (fr, 100)

    # 하품: 크게 기지개 켜며 눈 감기
    fr = []
    for i in range(8):
        t = i / 7.0
        s_ = math.sin(math.pi * t)
        f = st.draw(happy, sy=1.0 + 0.13 * s_, sx=1.0 - 0.05 * s_, dy=-3.0 * s_)
        if 0.25 < t < 0.85:
            glyph(f, "dot", gx + st.body_h * 0.26, gy + gs, gs * (0.7 + s_))
        fr.append(f)
    out["yawning"] = (fr, 190)

    # 꾸벅꾸벅: 고개가 천천히 떨어졌다 올라온다
    fr = []
    for i in range(10):
        t = i / 10.0
        nod = ease(t)
        fr.append(st.draw(happy, rot=-4.0 * nod, dy=1.2 * nod, sy=1.0 - 0.03 * nod))
    out["dozing"] = (fr, 230)

    # 주저앉기: 수면 자세로 내려앉는 한 방향 전환
    fr = []
    for i in range(8):
        t = i / 7.0
        fr.append(st.draw(happy, sy=1.0 - 0.07 * t, sx=1.0 + 0.04 * t, dy=1.5 * t))
    out["collapsing"] = (fr, 130)

    # 수면: 납작하게 + zZ
    fr = []
    for i in range(10):
        t = i / 10.0
        f = st.draw(full, sy=0.93 + 0.02 * ease(t), sx=1.04, dy=1.5)
        rise = t * st.body_h * 0.30
        glyph(f, "z", gx + st.body_h * 0.30, gy - rise + gs, gs * (0.8 + 0.5 * t),
              alpha=max(0.0, 1.0 - t))
        # 두 번째 z 는 반 박자 뒤에
        t2 = (t + 0.5) % 1.0
        glyph(f, "z", gx + st.body_h * 0.22, gy - t2 * st.body_h * 0.30,
              gs * (0.7 + 0.4 * t2), alpha=max(0.0, 1.0 - t2) * 0.8)
        fr.append(f)
    out["sleeping"] = (fr, 210)

    # 깨어남: 기지개
    fr = []
    for i in range(7):
        t = i / 6.0
        s = math.sin(math.pi * t)
        fr.append(st.draw(full, sy=0.94 + 0.16 * s, sx=1.03 - 0.06 * s, dy=1.5 - 4.0 * s))
    out["waking"] = (fr, 110)

    # 주목/완료: 신나서 통통
    fr = []
    for i in range(8):
        t = i / 8.0
        h = abs(math.sin(math.pi * t * 2))
        fr.append(st.draw(excited, dy=-st.body_h * 0.14 * h,
                          sy=1.0 - 0.05 * (1 - h), sx=1.0 + 0.04 * (1 - h)))
    out["attention"] = (fr, 95)

    # 알림: 느낌표 깜빡
    fr = []
    for i in range(8):
        t = i / 8.0
        f = st.draw(excited, dy=-st.body_h * 0.10 * abs(math.sin(math.pi * t * 2)))
        if i % 4 < 3:
            glyph(f, "bang", gx, gy, gs * 1.5)
        fr.append(f)
    out["notification"] = (fr, 110)

    # 오류: 부르르 + 붉은 기
    fr = []
    for i in range(8):
        fr.append(st.draw(full, dx=[-3, 3, -2, 2, -1, 1, 0, 0][i],
                          tint=((214, 96, 88), 0.20)))
    out["error"] = (fr, 70)

    # 기쁨: 눈 감고 배시시
    fr = []
    for i in range(8):
        t = ease(i / 8.0)
        fr.append(st.draw(happy, dy=-2.5 * t, sy=1.0 + 0.03 * t))
    out["happy"] = (fr, 130)

    return out


# ---------------------------------------------------------------- 저장

def save_apng(frames, path, duration):
    """APNG 저장.

    disposal=1(다음 프레임 전에 영역을 투명으로 지움) + blend=0(알파 합성이 아니라
    픽셀 교체)이어야 한다. disposal=2(PREVIOUS)를 쓰면 Pillow 의 프레임 최적화와
    맞물려 '앞 프레임과 같은 부분'이 통째로 지워진 채 복원된다."""
    frames[0].save(path, format="PNG", save_all=True, append_images=frames[1:],
                   duration=duration, loop=0, disposal=1, blend=0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sprites")
    ap.add_argument("-o", "--out", default="build")
    ap.add_argument("--name", default="Pidove")
    ap.add_argument("--author", default="pidove99")
    ap.add_argument("--version", default="1.0.0")
    ap.add_argument("--body", type=int, default=104, help="캐릭터 키(px)")
    ap.add_argument("--module", default="auto", help="픽셀아트 배율: auto | off | 정수")
    ap.add_argument("--expr-ratio", type=float, default=0.92,
                    help="표정 컷을 전신 대비 몇 배 크기로 맞출지 (발이 없어 기본 0.92)")
    a = ap.parse_args()

    mani_path = os.path.join(a.sprites, "sprites.json")
    if os.path.exists(mani_path):
        with open(mani_path, encoding="utf-8") as f:
            names = [s["name"] for s in json.load(f)["sprites"]]
    else:
        names = sorted(os.path.splitext(f)[0] for f in os.listdir(a.sprites)
                       if f.endswith(".png") and not f.startswith("_"))

    module = a.module if a.module == "auto" else (
        1 if a.module == "off" else int(a.module))

    raw = {}
    for n in names:
        p = os.path.join(a.sprites, n + ".png")
        if os.path.exists(p):
            raw[n] = Image.open(p).convert("RGBA")
    if not raw:
        print("스프라이트를 못 찾았습니다: %s" % a.sprites, file=sys.stderr)
        return 1

    # 전신 뷰 기준으로 키를 맞추고, 표정 컷은 같은 비율로 함께 줄인다
    body_keys = [k for k in ("front", "three_quarter", "side", "back") if k in raw]
    ref_h = max(raw[k].size[1] for k in body_keys) if body_keys else \
        max(im.size[1] for im in raw.values())
    # 전신 뷰끼리는 시트에 그려진 비율을 유지하고, 표정 컷(발이 없어 더 작다)은
    # 상태가 바뀔 때 크기가 튀지 않도록 본체 키에 맞춰 따로 재운다.
    sprites = {}
    for n, im in raw.items():
        if n in body_keys:
            h = a.body * im.size[1] / float(ref_h)
        else:
            h = a.body * a.expr_ratio
        sprites[n] = downscale(im, max(8, int(round(h))), module)

    body_h = max(sprites[k].size[1] for k in body_keys) if body_keys else a.body
    maxw = max(im.size[0] for im in sprites.values())
    W = int(maxw * 1.55) // 2 * 2      # 짝수여야 2배 내보내기가 딱 떨어진다
    H = int(body_h * 1.60) // 2 * 2
    stage = Stage(sprites, body_h, (W, H), baseline=int(H * 0.94))

    assets = os.path.join(a.out, "assets")
    os.makedirs(assets, exist_ok=True)
    states = build_states(stage, lambda k: k in sprites)

    files = {}
    for state, (frames, dur) in states.items():
        fn = "%s.png" % state
        save_apng(frames, os.path.join(assets, fn), dur)
        files[state] = fn
        print("  %-13s %2d프레임 %3dms  %s" % (state, len(frames), dur, fn))

    def hitbox(state):
        """해당 상태 프레임들의 실제 그림 범위 -> viewBox 단위 클릭 영역."""
        xs0, ys0, xs1, ys1 = W, H, 0, 0
        for f in states[state][0]:
            b = f.getbbox()
            if b:
                xs0, ys0 = min(xs0, b[0]), min(ys0, b[1])
                xs1, ys1 = max(xs1, b[2]), max(ys1, b[3])
        return {"x": round(xs0 / 2.0, 2), "y": round(ys0 / 2.0, 2),
                "w": round((xs1 - xs0) / 2.0, 2), "h": round((ys1 - ys0) / 2.0, 2)}

    theme = {
        "schemaVersion": 1,
        "name": a.name,
        "version": a.version,
        "description": "%s — 픽셀 비둘기 데스크톱 펫" % a.name,
        "viewBox": {"x": 0, "y": 0, "width": round(W / 2.0, 2), "height": round(H / 2.0, 2)},
        "eyeTracking": {"enabled": False, "states": []},
        "sleepSequence": {"mode": "full"},
        "states": {
            "idle": [files["idle"]],
            "thinking": [files["thinking"]],
            "working": [files["working"]],
            "yawning": [files["yawning"]],
            "dozing": [files["dozing"]],
            "collapsing": [files["collapsing"]],
            "sleeping": [files["sleeping"]],
            "waking": [files["waking"]],
            "attention": [files["attention"]],
            "notification": [files["notification"]],
            "error": [files["error"]],
            "happy": [files["happy"]],
        },
        "workingTiers": [
            {"minSessions": 3, "file": files["building"]},
            {"minSessions": 2, "file": files["juggling"]},
            {"minSessions": 1, "file": files["working"]},
        ],
        "hitBoxes": {"default": hitbox("idle"), "sleeping": hitbox("sleeping")},
        "sleepingHitboxFiles": [files["sleeping"]],
        "timings": {"minDisplay": {"attention": 4000, "error": 5000, "working": 1000}},
        "miniMode": {"supported": False},
    }
    if a.author:
        theme["author"] = a.author

    with open(os.path.join(a.out, "theme.json"), "w", encoding="utf-8") as f:
        json.dump(theme, f, ensure_ascii=False, indent=2)

    print("\n테마 완성: %s  (캔버스 %dx%d, viewBox %.0fx%.0f)"
          % (a.out, W, H, W / 2.0, H / 2.0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
