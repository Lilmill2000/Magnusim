#!/usr/bin/env python3
"""Screenshot a project STL from the standard CAD Home (isometric, fit-to-bounds)."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--stl', default=None)
    ap.add_argument('--vtp', default=None)
    ap.add_argument('--edges', default=None)
    ap.add_argument('--out', required=True)
    ap.add_argument('--width', type=int, default=640)
    ap.add_argument('--height', type=int, default=400)
    args = ap.parse_args()

    os.environ.setdefault('PYVISTA_OFF_SCREEN', 'true')

    try:
        import pyvista as pv
    except Exception as e:
        print('PYVISTA_FAIL', e, file=sys.stderr)
        return 2

    src = Path(args.vtp) if args.vtp else Path(args.stl) if args.stl else None
    if src is None or not src.is_file():
        print('GEO_MISSING', src, file=sys.stderr)
        return 3

    mesh = pv.read(str(src))
    if mesh is None or mesh.n_points < 3:
        print('EMPTY_STL', file=sys.stderr)
        return 4

    try:
        mesh = mesh.extract_surface(algorithm='dataset_surface').triangulate()
    except Exception:
        pass
    try:
        mesh.compute_normals(inplace=True, auto_orient_normals=True)
    except Exception:
        pass

    pv.OFF_SCREEN = True
    pl = pv.Plotter(off_screen=True, window_size=(int(args.width), int(args.height)))
    pl.set_background('#eef0f4')
    pl.add_mesh(
        mesh,
        color='#8d96a3',
        smooth_shading=True,
        specular=0.35,
        specular_power=25,
        ambient=0.22,
        diffuse=0.78,
        show_edges=False,
    )
    if args.edges:
        edge_path = Path(args.edges)
        if edge_path.is_file():
            try:
                pl.add_mesh(pv.read(str(edge_path)), color='#1a1d24', line_width=1.2)
            except Exception:
                pass
    try:
        pl.enable_anti_aliasing('ssaa')
    except Exception:
        pass

    # CAD Home: isometric, +Z up, fitted to the model bounds.
    pl.camera_position = 'iso'
    pl.reset_camera()
    try:
        pl.camera.elevation(8)
        pl.camera.azimuth(12)
    except Exception:
        pass
    pl.reset_camera_clipping_range()
    try:
        pl.camera.zoom(1.08)
    except Exception:
        pass

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    pl.show(screenshot=str(out))
    pl.close()

    if not out.is_file() or out.stat().st_size < 64:
        print('THUMB_MISSING', out, file=sys.stderr)
        return 5

    bounds = [float(x) for x in mesh.bounds]
    print(
        'THUMB_OK',
        json.dumps(
            {
                'out': str(out),
                'n_points': int(mesh.n_points),
                'n_cells': int(mesh.n_cells),
                'bounds': bounds,
                'camera': 'iso_home',
            }
        ),
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main() or 0)
