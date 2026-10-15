"""Render docs/notify.gif: clawd-notify while you are away from the terminal.

Claude works through a long turn; when it ends, a desktop notification
slides in with the first line of the answer, a chime plays, and the phone
gets the push too, the turn having run past two minutes. Then Claude wants to
run a deploy: the permission dialog waits in the terminal, and the desktop
and the phone say so. The texts are the ones hooks/notes.ts writes (title,
gist and duration; the ntfy title and tag). Needs Pillow, the DejaVu fonts
and Noto Color Emoji (paths below are Debian/Ubuntu).

    python3 docs/notify_gif.py docs/notify.gif
"""
import sys
import textwrap
from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1]
FONTS = "/usr/share/fonts/truetype/dejavu/"
EMOJI = "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf"
SIZE = 20

DESK = (22, 24, 30)
BG = (30, 30, 34)
BAR = (44, 44, 50)
TEXT = (220, 220, 220)
DIM = (120, 120, 128)
BORDER = (90, 90, 98)
YELLOW = (229, 192, 123)
GREEN = (120, 200, 120)
ACCENT = (215, 119, 87)
CARD = (48, 50, 58)
CARD_EDGE = (78, 80, 90)
PHONE = (12, 12, 14)
PHONE_EDGE = (70, 70, 78)
LOCK = (34, 40, 58)

mono = ImageFont.truetype(FONTS + "DejaVuSansMono.ttf", SIZE)
mono_bold = ImageFont.truetype(FONTS + "DejaVuSansMono-Bold.ttf", SIZE)
sans = ImageFont.truetype(FONTS + "DejaVuSans.ttf", 17)
sans_small = ImageFont.truetype(FONTS + "DejaVuSans.ttf", 14)
sans_bold = ImageFont.truetype(FONTS + "DejaVuSans-Bold.ttf", 17)
clock_font = ImageFont.truetype(FONTS + "DejaVuSans.ttf", 46)
title_font = ImageFont.truetype(FONTS + "DejaVuSans-Bold.ttf", 15)
asc, desc = mono.getmetrics()
CW = round(mono.getlength("M"))
CH = asc + desc

COLS, ROWS = 74, 17           # the terminal, in cells
PAD = 24
TERM_X, TERM_Y = PAD, PAD + 34
TERM_W, TERM_H = COLS * CW + 24, ROWS * CH + 20
PHONE_W, PHONE_H = 300, 470
PHONE_X = TERM_X + TERM_W + 36
PHONE_Y = PAD + 4
W = PHONE_X + PHONE_W + PAD
H = max(TERM_Y + TERM_H, PHONE_Y + PHONE_H) + PAD + 34


def emoji(ch, height):
    font = ImageFont.truetype(EMOJI, 109)
    img = Image.new("RGBA", (160, 160), (0, 0, 0, 0))
    ImageDraw.Draw(img).text((0, 0), ch, font=font, embedded_color=True)
    img = img.crop(img.getbbox())
    return img.resize((round(img.width * height / img.height), height), Image.LANCZOS)


ICONS = {"done": emoji("✅", 20), "permission": emoji("✋", 20)}


def wrap(text, font, width):
    lines, line = [], ""
    for word in text.split(" "):
        test = (line + " " + word).strip()
        if font.getlength(test) <= width:
            line = test
        else:
            lines.append(line)
            line = word
    return lines + [line]


# ---------- the terminal ----------

def corner(draw, x, top, colour):
    """`⎿`, which the font lacks: a corner from the top to the right."""
    mx, my = x + CW // 2, top + CH // 2
    draw.rectangle([mx, top, mx + 1, my + 1], fill=colour)
    draw.rectangle([mx, my, x + CW, my + 1], fill=colour)


def terminal(draw, rows):
    draw.rounded_rectangle([TERM_X, TERM_Y - 30, TERM_X + TERM_W, TERM_Y + TERM_H], 10, fill=BG, outline=BORDER)
    draw.rounded_rectangle([TERM_X, TERM_Y - 30, TERM_X + TERM_W, TERM_Y], 10, fill=BAR)
    draw.rectangle([TERM_X, TERM_Y - 10, TERM_X + TERM_W, TERM_Y], fill=BAR)
    for i, colour in enumerate([(237, 106, 94), (245, 191, 79), (98, 197, 84)]):
        draw.ellipse([TERM_X + 14 + i * 20, TERM_Y - 21, TERM_X + 26 + i * 20, TERM_Y - 9], fill=colour)
    draw.text((TERM_X + TERM_W / 2, TERM_Y - 15), "~/work/app — claude", font=sans_small, fill=DIM, anchor="mm")
    for r, line in enumerate(rows[-ROWS:]):
        col = 0
        for text, colour, is_bold in line:
            for ch in text:
                x, top = TERM_X + 12 + col * CW, TERM_Y + 10 + r * CH
                if ch == "⎿":
                    corner(draw, x, top, colour)
                elif ch == "─":
                    draw.rectangle([x, top + CH // 2, x + CW, top + CH // 2 + 1], fill=colour)
                elif ch != " ":
                    draw.text((x, top + asc), ch, font=mono_bold if is_bold else mono, fill=colour, anchor="ls")
                col += 1


# ---------- the desktop notification ----------

def desktop_card(img, draw, note, slide):
    """A desktop notification, sliding in."""
    w = 400
    body = wrap(note["body"], sans, w - 40)[:3]
    h = 62 + 22 * len(body)
    # Over the terminal's top-right corner, where the desktop puts it.
    x = TERM_X + TERM_W - w - 14 + round((1 - slide) * 70)
    y = TERM_Y + 8
    draw.rounded_rectangle([x, y, x + w, y + h], 12, fill=CARD, outline=CARD_EDGE)
    draw.text((x + 18, y + 14), "Claude Code", font=sans_small, fill=DIM)
    draw.text((x + w - 18, y + 14), "now", font=sans_small, fill=DIM, anchor="ra")
    draw.text((x + 18, y + 34), note["title"], font=sans_bold, fill=TEXT)
    for i, line in enumerate(body):
        draw.text((x + 18, y + 58 + i * 22), line, font=sans, fill=(200, 200, 205))


# ---------- the phone ----------

def phone(img, draw, pushes, clock):
    x, y = PHONE_X, PHONE_Y
    draw.rounded_rectangle([x, y, x + PHONE_W, y + PHONE_H], 36, fill=PHONE, outline=PHONE_EDGE, width=3)
    draw.rounded_rectangle([x + 10, y + 10, x + PHONE_W - 10, y + PHONE_H - 10], 28, fill=LOCK)
    draw.rounded_rectangle([x + PHONE_W / 2 - 40, y + 18, x + PHONE_W / 2 + 40, y + 34], 8, fill=PHONE)
    draw.text((x + PHONE_W / 2, y + 92), clock, font=clock_font, fill=TEXT, anchor="mm")
    draw.text((x + PHONE_W / 2, y + 128), "Wednesday 15 October", font=sans_small, fill=(170, 175, 190), anchor="mm")
    top = y + 158
    for push in reversed(pushes):
        cw = PHONE_W - 36
        lines = wrap(push["body"], sans_small, cw - 28)[:4]
        h = 58 + 18 * len(lines)
        cx = x + 18
        draw.rounded_rectangle([cx, top, cx + cw, top + h], 14, fill=(58, 62, 76))
        draw.text((cx + 12, top + 10), "ntfy · claude-7f3k9q2m8x", font=sans_small, fill=(170, 175, 190))
        draw.text((cx + cw - 12, top + 10), "now", font=sans_small, fill=(170, 175, 190), anchor="ra")
        icon = ICONS[push["kind"]]
        img.paste(icon, (cx + 12, top + 31), icon)
        title = push["title"]
        while title_font.getlength(title) > cw - 50:
            title = title[:-2] + "…"
        draw.text((cx + 38, top + 30), title, font=title_font, fill=TEXT)
        for i, line in enumerate(lines):
            draw.text((cx + 12, top + 54 + i * 18), line, font=sans_small, fill=(215, 218, 228))
        top += h + 10


# ---------- the story ----------

state = dict(rows=[], card=None, slide=0.0, pushes=[], clock="14:30", caption="", chime=False)
frames, durations = [], []


def add(ms):
    img = Image.new("RGB", (W, H), DESK)
    draw = ImageDraw.Draw(img)
    terminal(draw, state["rows"])
    phone(img, draw, state["pushes"], state["clock"])
    if state["card"] is not None:
        desktop_card(img, draw, state["card"], state["slide"])
    caption = state["caption"]
    if state["chime"]:
        caption = "♪  " + caption
    draw.text((TERM_X, H - PAD - 4), caption, font=sans, fill=(170, 175, 190), anchor="ls")
    frames.append(img)
    durations.append(ms)


def rule():
    return [("─" * COLS, BORDER, False)]


def screen(transcript, prompt="", working=None, dialog=None):
    rows = list(transcript)
    if dialog is not None:
        rows += dialog
    else:
        rows += [[]] if working is None else [[("✻ ", ACCENT, False), (working, ACCENT, False)]]
        rows += [rule(), [("> ", TEXT, False), (prompt, TEXT, False)], rule()]
    state["rows"] = [[]] * max(0, ROWS - len(rows)) + rows


ASK = "fix the flaky login test and run the whole suite"
history = []
for i in range(0, len(ASK) + 1, 4):
    screen(history, ASK[:i])
    state["caption"] = "You ask Claude for something that takes a while…"
    add(60)
screen(history, ASK)
add(700)

history = [[("> ", DIM, False), (ASK, DIM, False)], []]
state["caption"] = "…and go make coffee. Claude works; nothing pings you yet."
steps = [
    ("Read", "tests/LoginTest.php"), ("Read", "src/Auth/Session.php"), ("Edit", "src/Auth/Session.php"),
    ("Bash", "vendor/bin/phpunit --filter LoginTest"), ("Bash", "vendor/bin/phpunit"),
]
elapsed = 0
for n, (tool, arg) in enumerate(steps):
    history += [[("● ", GREEN, False), (tool, TEXT, True), (f"({arg})", TEXT, False)]]
    for _ in range(3):
        elapsed += 9
        m, s = divmod(elapsed, 60)
        screen(history, working=f"Fixing the flaky login test… ({m}m {s:02d}s · esc to interrupt)")
        state["clock"] = f"14:{30 + elapsed // 60:02d}"
        add(260)
    result = "Tests: 214, Assertions: 655, OK" if n == len(steps) - 1 else "done"
    history += [[("  ⎿  ", DIM, False), (result, DIM, False)]]
elapsed = 134
state["clock"] = "14:32"

ANSWER = "Fixed the race in LoginTest: the session now waits for the token write. All 214 tests pass."
first, *rest = textwrap.wrap(ANSWER, COLS - 4)
history += [[], [("● ", TEXT, False), (first, TEXT, False)]] + [[("  ", TEXT, False), (line, TEXT, False)] for line in rest]
screen(history)
state["caption"] = ""
add(500)

done = {"kind": "done", "title": "Claude is done · app", "body": f"{ANSWER} (2m 14s)"}
state["card"] = done
state["caption"] = "The turn ran 2m 14s: a notification, a chime, and your phone."
for slide in (0.35, 0.7, 1.0):
    state["slide"] = slide
    add(70)
state["chime"] = True
state["pushes"] = [{"kind": "done", "title": "Claude is done - app", "body": done["body"]}]
add(3200)
state["chime"] = False
for slide in (0.6, 0.2, 0.0):
    state["slide"] = slide
    add(70)
state["card"] = None

DEPLOY = "deploy it to staging"
history = history[-6:]
for i in range(0, len(DEPLOY) + 1, 4):
    screen(history, DEPLOY[:i])
    state["caption"] = "Later, from the couch: one more ask."
    add(60)
history += [[], [("> ", DIM, False), (DEPLOY, DIM, False)], [],
            [("● ", GREEN, False), ("Bash", TEXT, True), ("(./deploy.sh staging)", TEXT, False)]]
dialog = [
    [("╭" + "─" * (COLS - 2) + "╮", ACCENT, False)],
    [("│ ", ACCENT, False), ("Bash command".ljust(COLS - 4), ACCENT, True), (" │", ACCENT, False)],
    [("│ ", ACCENT, False), ("  ./deploy.sh staging".ljust(COLS - 4), TEXT, False), (" │", ACCENT, False)],
    [("│ ", ACCENT, False), ("Do you want to proceed?".ljust(COLS - 4), TEXT, False), (" │", ACCENT, False)],
    [("│ ", ACCENT, False), ("❯ 1. Yes".ljust(COLS - 4), ACCENT, True), (" │", ACCENT, False)],
    [("│ ", ACCENT, False), ("  2. No".ljust(COLS - 4), TEXT, False), (" │", ACCENT, False)],
    [("╰" + "─" * (COLS - 2) + "╯", ACCENT, False)],
]
screen(history, dialog=dialog)
state["clock"] = "14:47"
state["caption"] = ""
add(700)

ask = {"kind": "permission", "title": "Claude needs your approval · app", "body": "Claude needs your permission to use Bash"}
state["card"] = ask
state["caption"] = "Claude is waiting on you: the knock chime, and a high-priority push."
for slide in (0.35, 0.7, 1.0):
    state["slide"] = slide
    add(70)
state["chime"] = True
state["pushes"].append({"kind": "permission", "title": "Claude needs your approval - app", "body": ask["body"]})
add(4200)

# Each frame to its own palette with no dithering: dithered grey turns the
# frame's lines into dashes.
frames = [f.quantize(colors=160, dither=Image.Dither.NONE) for f in frames]
frames[0].save(OUT, save_all=True, append_images=frames[1:], duration=durations, loop=0,
               optimize=True, disposal=1)
print(OUT, frames[0].size, len(frames), "frames", sum(durations) / 1000, "s")
