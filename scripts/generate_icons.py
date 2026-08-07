"""PWA用アイコンを生成する(1回限りの手作業スクリプト、CIには組み込まない)。

デザイン: 紺色の角丸背景に、白い「紙面」+見出し線+本文線のシンプルな新聞アイコン。
白い紙面のまわりに紺の余白を広めに取り、圧迫感のない見た目にしている
(maskable用の安全余白としても機能する: OSの円形マスクで切れない)。
"""
from PIL import Image, ImageDraw

BRAND = (26, 42, 74)  # #1a2a4a (紺)
WHITE = (255, 255, 255)


def rounded_rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def make_icon(size, out_path, safe_margin_ratio=0.30):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    rounded_rect(draw, (0, 0, size, size), radius=int(size * 0.22), fill=BRAND)

    margin = int(size * safe_margin_ratio)
    paper_box = (margin, margin, size - margin, size - margin)
    px0, py0, px1, py1 = paper_box
    paper_w = px1 - px0
    paper_h = py1 - py0

    rounded_rect(draw, paper_box, radius=int(paper_w * 0.06), fill=WHITE)

    line_x0 = px0 + int(paper_w * 0.16)
    line_x1 = px1 - int(paper_w * 0.16)

    headline_y0 = py0 + int(paper_h * 0.22)
    headline_y1 = headline_y0 + int(paper_h * 0.09)
    rounded_rect(draw, (line_x0, headline_y0, line_x1, headline_y1), radius=int(paper_h * 0.03), fill=BRAND)

    body_line_h = int(paper_h * 0.05)
    gap = int(paper_h * 0.045)
    y = headline_y1 + int(paper_h * 0.12)
    widths = [1.0, 1.0, 0.62]
    for w in widths:
        x1 = line_x0 + int((line_x1 - line_x0) * w)
        rounded_rect(draw, (line_x0, y, x1, y + body_line_h), radius=int(body_line_h * 0.4), fill=BRAND)
        y += body_line_h + gap

    img.save(out_path)
    print(f"saved: {out_path} ({size}x{size})")


if __name__ == "__main__":
    make_icon(512, "icons/icon-512.png")
    make_icon(192, "icons/icon-192.png")
    make_icon(180, "icons/apple-touch-icon.png", safe_margin_ratio=0.26)
    make_icon(32, "favicon.png", safe_margin_ratio=0.22)
