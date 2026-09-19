#!/usr/bin/env python3
"""生成应用图标母图（1024x1024，4x 超采样抗锯齿）。

生成结果 src-tauri/app-icon.png 已随仓库提交，改设计时才需要重跑：
    python3 scripts/make-icon.py && npx tauri icon src-tauri/app-icon.png
依赖 Pillow（brew install pillow 或 pip install pillow）。
"""
from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
SS = 4  # 超采样倍数
CANVAS = SIZE * SS
S = lambda v: int(round(v * SS))

EMERALD = (52, 211, 153)
AZURE = (56, 189, 248)
BG_TOP = (18, 32, 42)
BG_BOT = (8, 12, 16)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def squircle_path(radius_px):
    """近似 macOS 的连续曲率圆角矩形（用三段圆弧 + 直线拼，够用于绘制）。"""
    r = S(radius_px)
    w = CANVAS
    box = (0, 0, w, w)
    return box, r


def draw_tile(size, top, bottom):
    """带竖向渐变和圆角遮罩的底板。"""
    grad = Image.new("RGB", (size, size))
    gd = ImageDraw.Draw(grad)
    for y in range(size):
        t = y / (size - 1)
        # 上亮下暗，底部再压一点，做出玻璃感
        k = t**1.25
        gd.line([(0, y), (size, y)], fill=lerp(top, bottom, k))
    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    r = int(size * 0.2237)  # macOS 图标圆角比例
    md.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    out = grad.convert("RGBA")
    out.putalpha(mask)  # 只有圆角内部不透明
    return out


def draw_waves(size, ss_scale):
    """信号弧 + 源点，画在独立图层上以便做外发光。"""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    u = size / 1024.0
    cx, cy = 512 * u, 690 * u

    arcs = [
        (150, 46, EMERALD),
        (250, 40, lerp(EMERALD, AZURE, 0.5)),
        (350, 34, AZURE),
    ]
    for radius, width, color in arcs:
        box = [cx - radius * u, cy - radius * u, cx + radius * u, cy + radius * u]
        d.arc(box, start=205, end=335, fill=color + (255,), width=int(width * u))
        # 端点做圆头
        for ang in (205, 335):
            import math

            ex = cx + radius * u * math.cos(math.radians(ang))
            ey = cy + radius * u * math.sin(math.radians(ang))
            rr = width * u / 2
            d.ellipse([ex - rr, ey - rr, ex + rr, ey + rr], fill=color + (255,))

    # 源点：外环 + 内芯
    d.ellipse([cx - 78 * u, cy - 78 * u, cx + 78 * u, cy + 78 * u], fill=lerp(EMERALD, AZURE, 0.35) + (255,))
    d.ellipse([cx - 40 * u, cy - 40 * u, cx + 40 * u, cy + 40 * u], fill=(10, 16, 20, 255))
    return layer


def main():
    from PIL import ImageChops

    tile = draw_tile(CANVAS, BG_TOP, BG_BOT)
    alpha_mask = tile.split()[3]

    # 顶部高光：一条很淡的弧形反光，裁进圆角内
    gloss = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    gd = ImageDraw.Draw(gloss)
    gd.ellipse(
        [-CANVAS * 0.25, -CANVAS * 0.62, CANVAS * 1.25, CANVAS * 0.42],
        fill=(255, 255, 255, 26),
    )
    gloss.putalpha(ImageChops.multiply(gloss.split()[3], alpha_mask))

    waves = draw_waves(CANVAS, SS)
    waves.putalpha(ImageChops.multiply(waves.split()[3], alpha_mask))
    glow = waves.filter(ImageFilter.GaussianBlur(radius=S(26)))
    glow.putalpha(ImageChops.multiply(glow.split()[3], alpha_mask).point(lambda v: int(v * 0.6)))

    out = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    out = Image.alpha_composite(out, tile)
    out = Image.alpha_composite(out, gloss)
    out = Image.alpha_composite(out, glow)
    out = Image.alpha_composite(out, waves)

    # 描边：让图标在浅色 Dock 上也有边界
    border = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    bd = ImageDraw.Draw(border)
    r = int(CANVAS * 0.2237)
    bd.rounded_rectangle(
        [S(2), S(2), CANVAS - S(2) - 1, CANVAS - S(2) - 1],
        radius=r,
        outline=(255, 255, 255, 34),
        width=S(3),
    )
    out = Image.alpha_composite(out, border)

    out = out.resize((SIZE, SIZE), Image.LANCZOS)
    out.save("src-tauri/app-icon.png")
    print("已生成 src-tauri/app-icon.png (1024x1024)")


if __name__ == "__main__":
    main()
