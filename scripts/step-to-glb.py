# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
"""
step-to-glb.py - convert a STEP file to a Y-up GLB, natively (no browser memory limit).

Why this exists: the in-browser STEP importer runs OpenCASCADE as WebAssembly, whose memory is capped at
4 GB. Large assemblies (a few hundred MB of STEP) do not fit. This script uses the native OpenCASCADE
build shipped in the `cascadio` package, which is limited only by the PC's RAM. Import the resulting
GLB through the Import dialog's "GLB File" tab, or with the MCP tool `web_editor_import_glb`.

    python -m pip install cascadio numpy
    python scripts/step-to-glb.py machine.stp machine.glb --quality draft

cascadio writes metres (mm in the STEP become m) and keeps part names, but leaves the model Z-up. glTF
and this viewer are Y-up, so the root nodes are rotated -90 degrees about X after conversion; the model
then stands upright, like the in-browser importer's result.

Quality sets the tessellation tolerances (the numbers are our own choice, not a standard):
  draft     relative linear 0.02,  angular 0.8 rad   fastest, lightest
  standard  relative linear 0.005, angular 0.5 rad
  fine      relative linear 0.001, angular 0.25 rad
"""

import argparse
import json
import math
import struct
import sys
import time
from pathlib import Path

QUALITY = {
    "draft": (0.02, 0.8),
    "standard": (0.005, 0.5),
    "fine": (0.001, 0.25),
}


def _read_glb(path: Path):
    data = path.read_bytes()
    magic, version, _length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF" or version != 2:
        raise ValueError("not a glTF 2.0 binary file")
    json_len, json_type = struct.unpack_from("<II", data, 12)
    if json_type != 0x4E4F534A:
        raise ValueError("first chunk is not JSON")
    doc = json.loads(data[20:20 + json_len].decode("utf-8"))
    rest = data[20 + json_len:]          # remaining chunks (BIN), untouched
    return doc, rest


def _write_glb(path: Path, doc: dict, rest: bytes) -> None:
    blob = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    blob += b" " * (-len(blob) % 4)      # JSON chunk is padded with spaces to 4 bytes
    total = 12 + 8 + len(blob) + len(rest)
    path.write_bytes(
        struct.pack("<4sII", b"glTF", 2, total)
        + struct.pack("<II", len(blob), 0x4E4F534A)
        + blob
        + rest
    )


def _quat_mul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ]


def rotate_roots_to_y_up(path: Path) -> int:
    """Rotate every scene root -90 deg about X (Z-up -> Y-up). Returns the number of roots changed."""
    doc, rest = _read_glb(path)
    s = math.sqrt(0.5)
    z_to_y = [-s, 0.0, 0.0, s]
    changed = 0
    for scene in doc.get("scenes", []):
        for index in scene.get("nodes", []):
            node = doc["nodes"][index]
            if "matrix" in node:
                raise ValueError("a root node carries a matrix; refusing to guess how to combine it")
            node["rotation"] = _quat_mul(z_to_y, node.get("rotation", [0.0, 0.0, 0.0, 1.0]))
            changed += 1
    _write_glb(path, doc, rest)
    return changed


def main() -> int:
    ap = argparse.ArgumentParser(description="Convert STEP to a Y-up GLB natively (OpenCASCADE via cascadio).")
    ap.add_argument("input", type=Path, help="input .stp / .step file")
    ap.add_argument("output", type=Path, help="output .glb file")
    ap.add_argument("--quality", choices=sorted(QUALITY), default="draft")
    ap.add_argument("--no-y-up", action="store_true", help="keep the converter's Z-up orientation")
    args = ap.parse_args()

    try:
        import cascadio
    except ImportError:
        print("cascadio is missing: python -m pip install cascadio numpy", file=sys.stderr)
        return 2
    if not args.input.is_file():
        print(f"input not found: {args.input}", file=sys.stderr)
        return 2

    linear, angular = QUALITY[args.quality]
    t0 = time.time()
    rc = cascadio.step_to_glb(
        str(args.input), str(args.output),
        tol_linear=linear, tol_angular=angular, tol_relative=True,
        merge_primitives=True, use_parallel=True,
    )
    if rc != 0 or not args.output.is_file():
        print(f"conversion failed (cascadio returned {rc})", file=sys.stderr)
        return 1
    roots = 0 if args.no_y_up else rotate_roots_to_y_up(args.output)
    mb = args.output.stat().st_size / 1e6
    print(f"ok: {args.output} ({mb:.1f} MB) in {time.time() - t0:.1f} s, quality={args.quality}, roots rotated={roots}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
