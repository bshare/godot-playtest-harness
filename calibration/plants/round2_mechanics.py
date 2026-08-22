#!/usr/bin/env python3
"""Round 2 plant set — four defects across four independent code paths.

Subject: Godot's official `role_playing_game` demo (godot-demo-projects).
Usage:   python3 round2_mechanics.py /path/to/subject-copy

Every plant here was verified APPLIED (diff vs clean), verified to MANIFEST
(observed against a clean control), and checked for independence. See
../README.md for the protocol and ../../CALIBRATION.md for what each round found.

KNOWN LIMITATION, recorded rather than fixed: P5 sits on a gateway interaction —
the only route into both dialogue and combat — so it suppresses P2 and P3 for any
role that does not retry a bump. Do not use all four together to test a Critic.
"""
import sys, pathlib

root = pathlib.Path(sys.argv[1])


def patch(rel, old, new, tag):
    p = root / rel
    s = p.read_text()
    assert old in s, f"{tag}: anchor not found in {rel} — subject may have changed upstream"
    p.write_text(s.replace(old, new, 1))
    print(f"  applied {tag}  ({rel})")


# P1 — moving UP passes through any wall. Scoped to exclude OBJECT/ACTOR so it
# cannot mask P5, which lives on the OBJECT/ACTOR branch.
patch("grid_movement/grid/grid.gd",
      "\tvar cell_tile_id := get_cell_source_id(cell_target)\n\tmatch cell_tile_id:",
      "\tvar cell_tile_id := get_cell_source_id(cell_target)\n"
      "\tif direction == Vector2i.UP and cell_tile_id != -1 \\\n"
      "\t\t\tand cell_tile_id != CellType.OBJECT and cell_tile_id != CellType.ACTOR:\n"
      "\t\tcell_tile_id = -1\n\tmatch cell_tile_id:",
      "P1 up-moves ignore walls")

# P5 — dialogue only opens on the SECOND bump of a cell.
patch("grid_movement/grid/grid.gd", "@export var dialogue_ui: Node",
      "@export var dialogue_ui: Node\n\nvar _bumps: Dictionary = {}", "P5 (state)")
patch("grid_movement/grid/grid.gd",
      '\t\t\tdialogue_ui.show_dialogue(pawn, target_pawn.get_node(^"DialoguePlayer"))',
      "\t\t\t_bumps[cell_target] = _bumps.get(cell_target, 0) + 1\n"
      "\t\t\tif _bumps[cell_target] < 2:\n\t\t\t\treturn Vector2i.ZERO\n\n"
      '\t\t\tdialogue_ui.show_dialogue(pawn, target_pawn.get_node(^"DialoguePlayer"))',
      "P5 two-bump dialogue")

# P2 — damage subtracted twice per hit.
patch("combat/combatants/health.gd",
      "\tlife = life - damage + armor", "\tlife = life - damage - damage + armor",
      "P2 doubled damage")

# P3 — dialogue NAME panel collapsed; the speaker name spills onto the world.
patch("dialogue/interface/interface.tscn",
      "offset_right = 312.698\noffset_bottom = 82.95",
      "offset_right = 92.0\noffset_bottom = -6.0",
      "P3 name panel collapsed")

print("round 2 plants applied. NOW VERIFY: export, run scenarios/verify_round2.json against")
print("this subject AND a clean control, and diff. A plant you cannot demonstrate is not ground truth.")
