"""Generate the small, dependency-free GIF used by staff repair status."""
import math
import pathlib
import struct

width, height, frames = 144, 96, 24
output = pathlib.Path(__file__).resolve().parents[1] / "artifacts/crm-dashboard/public/images/repair-gears.gif"
output.parent.mkdir(parents=True, exist_ok=True)
palette = bytes([248, 250, 252, 26, 48, 94, 104, 137, 185, 227, 235, 246])
data = bytearray(b"GIF89a" + struct.pack("<HH", width, height) + bytes([0x91, 0, 0]) + palette)
data += b"\x21\xff\x0bNETSCAPE2.0\x03\x01\x00\x00\x00"
for frame in range(frames):
    pixels = bytearray(width * height)
    theta = frame * 2 * math.pi / (12 * frames)
    for y in range(height):
        for x in range(width):
            for cx, cy, turn, color in [(48, 48, theta, 1), (94, 48, -theta + math.pi / 12, 2)]:
                dx, dy = x + 0.5 - cx, y + 0.5 - cy
                radius = math.hypot(dx, dy)
                phase = ((math.atan2(dy, dx) - turn) * 12 / (2 * math.pi)) % 1
                outer = 26 if 0.23 < phase < 0.77 else 20
                if 8 <= radius <= outer:
                    pixels[y * width + x] = color
    # Literal codes, regularly cleared, keep the GIF dictionary at 3..7 bits.
    # Minimum LZW code size 2: clear=4/end=5, clear every 2 pixels => always 3 bits.
    codes = []
    for at in range(0, len(pixels), 2):
        codes.append(4)
        codes.extend(pixels[at:at + 2])
    codes.append(5)
    packed = bytearray()
    accumulator = bits = 0
    for code in codes:
        accumulator |= code << bits
        bits += 3
        while bits >= 8:
            packed.append(accumulator & 255)
            accumulator >>= 8
            bits -= 8
    if bits:
        packed.append(accumulator & 255)
    data += b"\x21\xf9\x04\x04\x05\x00\x00\x00"
    data += b"\x2c" + struct.pack("<HHHH", 0, 0, width, height) + b"\x00\x02"
    for start in range(0, len(packed), 255):
        block = packed[start:start + 255]
        data += bytes([len(block)]) + block
    data += b"\x00"
data += b"\x3b"
output.write_bytes(data)
print(f"Generated {width}x{height}, {frames} frame GIF ({len(data)} bytes)")
