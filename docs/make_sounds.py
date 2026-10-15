"""Render sounds/done.wav and sounds/attention.wav: two short chimes, made
here so the plugin ships no third-party audio. Standard library only.

    python3 docs/make_sounds.py sounds
"""
import math
import struct
import sys
import wave


def tone(path, notes, gap=0.03):
    rate, out = 44100, []
    for freq, dur in notes:
        n = int(rate * dur)
        for i in range(n):
            t = i / rate
            env = min(1, t / 0.008) * math.exp(-5.5 * t / dur)
            s = math.sin(2 * math.pi * freq * t) + 0.25 * math.sin(4 * math.pi * freq * t)
            out.append(int(9000 * env * s))
        out += [0] * int(rate * gap)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<h", v) for v in out))


d = sys.argv[1]
tone(d + "/done.wav", [(1046.5, 0.16), (1318.5, 0.32)])                  # C6 then E6: rising, finished
tone(d + "/attention.wav", [(880, 0.14), (880, 0.14), (1174.7, 0.3)])    # A5 A5 D6: a knock
