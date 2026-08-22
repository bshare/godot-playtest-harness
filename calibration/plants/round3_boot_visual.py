#!/usr/bin/env python3
"""Round 3 plant set — two visual defects on the FIRST interactive frame.

Usage: python3 round3_boot_visual.py /path/to/subject-copy

Both are visible before any interaction, so nothing can gate them. Apply to a
CLEAN copy — do not combine with round 2, whose gateway plant would hide these.

V1 is an INTRINSIC defect (placeholder text) — findable from a single frame.
V2 is a COMPARATIVE defect (wrong scale) — only wrong relative to a control, and
a docs-blind critic correctly declines to guess at it. Use V2 only when you are
also supplying a control build to diff against.
"""
import sys, pathlib

root = pathlib.Path(sys.argv[1])


def patch(rel, old, new, tag):
    p = root / rel
    s = p.read_text()
    assert old in s, f"{tag}: anchor not found in {rel}"
    p.write_text(s.replace(old, new, 1))
    print(f"  applied {tag}  ({rel})")


# V1 — dialogue UI never hidden at boot; leaks its design-time placeholders
# ("NAME" / "Dialogue Text") over the map before any input.
patch("dialogue/interface/interface.gd",
      "func _ready() -> void:\n\tvisible = false",
      "func _ready() -> void:\n\tvisible = true",
      "V1 dialogue visible at boot")

# V2 — the key object rendered at 2.6x, overlapping neighbouring tiles.
patch("grid_movement/exploration.tscn",
      '[node name="Object" type="Node2D" parent="Grid" unique_id=1438057093]\nposition = Vector2(544, 288)',
      '[node name="Object" type="Node2D" parent="Grid" unique_id=1438057093]\n'
      'position = Vector2(544, 288)\nscale = Vector2(2.6, 2.6)',
      "V2 key at 2.6x scale")

print("round 3 plants applied. NOW VERIFY: export and capture a boot frame; both must be")
print("visible in it before any role runs.")
