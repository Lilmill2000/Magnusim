"""Export a finished run's result frames as VTK files for ParaView.

Reads the OpenFOAM case on Windows with VTK's OpenFOAM reader (no WSL): for each
asked time, the internal mesh and every boundary patch with all the fields the
frame saved, as cell data. Each frame is a ``.vtm`` (a multiblock: the internal
mesh ``.vtu`` and one ``.vtp`` per boundary patch); several frames also get a
``.pvd`` time series. Everything goes into one zip with a README.

Pressure: an incompressible case stores ``p`` divided by density (m^2/s^2). As
the results view does (case_units), every field the case lists as kinematic is
multiplied by the case's density and saved under ``<name>_Pa`` (``p_Pa``), so a
name never hides a unit change. Without a known density the field keeps its
name and its kinematic unit, and the README says so.

Progress goes to stdout as ``MAGNUSIM_EVENT`` lines (job-runner.js):
``progress`` (fraction 0..1, message), then ``exported`` (the zip) or
``export_error`` (a plain sentence) before a non-zero exit.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import zipfile
from pathlib import Path
from xml.sax.saxutils import quoteattr

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from case_units import KINEMATIC_UNIT, case_density, kinematic_fields  # noqa: E402

PA_SUFFIX = "_Pa"
_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


class ExportError(RuntimeError):
    """A failure said in a plain sentence the user sees as it is."""


def emit(event: str, **fields) -> None:
    print("MAGNUSIM_EVENT " + json.dumps({"event": event, **fields}), flush=True)


def safe_name(text: str, fallback: str = "results") -> str:
    """A file or folder name: letters, digits, '.', '_' and '-' only."""
    out = _SAFE.sub("_", str(text or "")).strip("._")
    return out[:80] or fallback


def scaled_names(case_dir: Path) -> tuple[float, tuple[str, ...]]:
    """The case's density and the fields stored divided by it."""
    return case_density(case_dir), kinematic_fields(case_dir)


def scale_to_pa(dataset, rho: float, names) -> list[str]:
    """Multiply each kinematic field on ``dataset`` by ``rho``, renamed ``<name>_Pa``.

    Returns the new names. Nothing changes when the density is unknown (1.0).
    """
    if rho == 1.0:
        return []
    done: list[str] = []
    for attr in ("cell_data", "point_data"):
        data = getattr(dataset, attr, None)
        if data is None:
            continue
        for name in names:
            if name not in data or (name + PA_SUFFIX) in data:
                continue
            arr = np.asarray(data[name])
            data[name + PA_SUFFIX] = (arr.astype(np.float64) * float(rho)).astype(arr.dtype)
            del data[name]
            if name + PA_SUFFIX not in done:
                done.append(name + PA_SUFFIX)
    return done


def units_note(rho: float, names) -> str:
    """The sentence each exported dataset carries about pressure units."""
    names = list(names)
    if not names:
        return "Fields are as OpenFOAM wrote them (SI units)."
    listed = ", ".join(names)
    if rho == 1.0:
        return (
            f"{listed}: kinematic ({KINEMATIC_UNIT}, pressure divided by density); "
            "the case gives no density, so they are not converted to Pa."
        )
    pa = ", ".join(n + PA_SUFFIX for n in names)
    return (
        f"{pa}: OpenFOAM's {listed} ({KINEMATIC_UNIT}) x density {rho:g} kg/m^3, in Pa. "
        "Other fields are as OpenFOAM wrote them (SI units)."
    )


def _leaves(block, path=()):
    """(path of block names, dataset) for every non-empty dataset under ``block``."""
    import pyvista as pv

    if block is None:
        return
    if isinstance(block, pv.MultiBlock):
        used: set[str] = set()
        for i in range(block.n_blocks):
            child = block[i]
            raw = block.get_block_name(i) or f"block{i}"
            name = safe_name(raw, f"block{i}")
            while name in used:
                name += "_"
            used.add(name)
            yield from _leaves(child, (*path, (name, raw)))
        return
    if int(getattr(block, "n_cells", 0) or 0) > 0:
        yield path, block


def _write_dataset(dataset, path: Path) -> None:
    import pyvista as pv
    from vtkmodules.vtkIOXML import vtkXMLPolyDataWriter, vtkXMLUnstructuredGridWriter

    if isinstance(dataset, pv.PolyData):
        writer = vtkXMLPolyDataWriter()
    else:
        if not isinstance(dataset, pv.UnstructuredGrid):
            dataset = dataset.cast_to_unstructured_grid()
        writer = vtkXMLUnstructuredGridWriter()
    path.parent.mkdir(parents=True, exist_ok=True)
    writer.SetFileName(str(path))
    writer.SetInputData(dataset)
    writer.SetDataModeToAppended()
    writer.EncodeAppendedDataOff()
    writer.SetCompressorTypeToZLib()
    writer.SetHeaderTypeToUInt64()
    if writer.Write() != 1:
        raise ExportError(f"Could not write {path.name}.")


def _vtm_xml(tree: dict, indent: str = "    ") -> list[str]:
    """The ``<DataSet>`` / ``<Block>`` lines of a vtm for a nested {name: file | dict}."""
    lines: list[str] = []
    for index, value in enumerate(tree.values()):
        raw = value["raw"]
        if "file" in value:
            lines.append(
                f'{indent}<DataSet index="{index}" name={quoteattr(raw)} file={quoteattr(value["file"])}/>'
            )
        else:
            lines.append(f'{indent}<Block index="{index}" name={quoteattr(raw)}>')
            lines.extend(_vtm_xml(value["children"], indent + "  "))
            lines.append(f"{indent}</Block>")
    return lines


def write_vtm(path: Path, tree: dict) -> None:
    body = "\n".join(_vtm_xml(tree))
    path.write_text(
        '<?xml version="1.0"?>\n'
        '<VTKFile type="vtkMultiBlockDataSet" version="1.0" byte_order="LittleEndian" header_type="UInt64">\n'
        "  <vtkMultiBlockDataSet>\n"
        f"{body}\n"
        "  </vtkMultiBlockDataSet>\n"
        "</VTKFile>\n",
        encoding="utf-8",
    )


def write_pvd(path: Path, frames: list[tuple[str, str]]) -> None:
    rows = "\n".join(
        f'    <DataSet timestep={quoteattr(t)} group="" part="0" file={quoteattr(f)}/>' for t, f in frames
    )
    path.write_text(
        '<?xml version="1.0"?>\n'
        '<VTKFile type="Collection" version="0.1" byte_order="LittleEndian">\n'
        "  <Collection>\n"
        f"{rows}\n"
        "  </Collection>\n"
        "</VTKFile>\n",
        encoding="utf-8",
    )


def _open_reader(case_dir: Path):
    import pyvista as pv

    if not (case_dir / "constant" / "polyMesh").is_dir():
        raise ExportError("The run's case has no mesh (constant/polyMesh is missing).")
    foam = next(iter(sorted(case_dir.glob("*.foam"))), None)
    if foam is None:
        foam = case_dir / "case.foam"
        foam.write_text("", encoding="ascii")
    reader = pv.OpenFOAMReader(str(foam))
    try:
        reader.skip_zero_time = False
    except Exception:
        pass
    reader.cell_to_point_creation = False
    reader.disable_all_patch_arrays()
    for name in reader.patch_array_names:
        # The internal mesh and each patch; never a patch group (its patches twice).
        if name == "internalMesh" or not str(name).startswith(("group/", "lagrangian/")):
            reader.enable_patch_array(name)
    return reader


def _pick_time(reader, time: str) -> float:
    values = [float(v) for v in (reader.time_values or [])]
    target = float(time)
    for v in values:
        if abs(v - target) <= 1e-9 * max(1.0, abs(target)):
            return v
    raise ExportError(f"The run has no saved frame at {time}.")


def export_vtk(case_dir: Path, times: list[str], out_dir: Path, name: str = "results") -> dict:
    """Write the zip for ``times`` of the case into ``out_dir``; return what it holds."""
    case_dir = Path(case_dir).resolve()
    if not case_dir.is_dir():
        raise ExportError("The run's case folder is missing.")
    times = [str(t).strip() for t in times if str(t).strip()]
    if not times:
        raise ExportError("No frame to export.")
    for t in times:
        try:
            float(t)
        except ValueError:
            raise ExportError(f"{t!r} is not a saved frame time.") from None
        if not (case_dir / t).is_dir():
            raise ExportError(f"The run has no saved frame at {t}.")
    name = safe_name(name)
    out_dir = Path(out_dir)
    stage = out_dir / "build"
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)

    rho, kinematic = scaled_names(case_dir)
    note = units_note(rho, kinematic)
    emit("progress", fraction=0.0, message="Opening the case")
    reader = _open_reader(case_dir)
    n = len(times)
    frames: list[tuple[str, str]] = []
    vtms: list[str] = []
    fields: list[str] = []
    n_cells = 0
    for i, t in enumerate(times):
        label = f"frame {i + 1} of {n}" if n > 1 else "the frame"
        emit("progress", fraction=round(0.9 * i / n, 4), message=f"Reading {label}", time=t)
        reader.set_active_time_value(_pick_time(reader, t))
        data = reader.read()
        leaves = list(_leaves(data))
        if not leaves:
            raise ExportError(f"The OpenFOAM reader found no cells at {t}.")
        emit("progress", fraction=round(0.9 * (i + 0.5) / n, 4), message=f"Writing {label}", time=t)
        folder = f"{name}/{safe_name(t, 'frame')}"
        tree: dict = {}
        for path, dataset in leaves:
            scale_to_pa(dataset, rho, kinematic)
            dataset.field_data["Magnusim_units"] = [note]
            dataset.field_data["Magnusim_time"] = [t]
            ext = ".vtp" if dataset.__class__.__name__ == "PolyData" else ".vtu"
            rel = folder + "/" + "/".join(p[0] for p in path) + ext
            _write_dataset(dataset, stage / rel)
            node = tree
            for key, raw in path[:-1]:
                node = node.setdefault(key, {"raw": raw, "children": {}})["children"]
            node[path[-1][0]] = {"raw": path[-1][1], "file": rel}
            for arr in dataset.cell_data.keys():
                if arr not in fields and not str(arr).lower().startswith("vtk"):
                    fields.append(str(arr))
            if path and path[-1][1] == "internalMesh":
                n_cells = max(n_cells, int(dataset.n_cells))
        vtm = f"{name}_{safe_name(t, 'frame')}.vtm"
        write_vtm(stage / vtm, tree)
        frames.append((t, vtm))
        vtms.append(vtm)
    pvd = ""
    if n > 1:
        pvd = f"{name}.pvd"
        write_pvd(stage / pvd, frames)
    open_first = pvd or vtms[0]
    (stage / "README.txt").write_text(
        "\n".join(
            [
                f"Results exported from {case_dir}",
                "",
                f"Open {open_first} in ParaView" + (" (all frames as a time series)." if pvd else "."),
                *(["Each frame is also a .vtm on its own."] if pvd else []),
                "Each frame holds the internal mesh (internalMesh.vtu) and each boundary patch",
                "(boundary/<patch>.vtp), with every saved field as cell data.",
                "",
                "Frames: " + ", ".join(times),
                "Fields: " + ", ".join(fields),
                "",
                "Units: " + note,
                "",
            ]
        ),
        encoding="utf-8",
    )
    emit("progress", fraction=0.92, message="Packing the zip")
    zip_path = out_dir / f"{name}.zip"
    part = out_dir / f"{name}.zip.part"
    with zipfile.ZipFile(part, "w", allowZip64=True) as zf:
        for f in sorted(stage.rglob("*")):
            if not f.is_file():
                continue
            # The VTK files are already compressed inside.
            kind = zipfile.ZIP_STORED if f.suffix in (".vtu", ".vtp") else zipfile.ZIP_DEFLATED
            zf.write(f, f.relative_to(stage).as_posix(), compress_type=kind)
    part.replace(zip_path)
    shutil.rmtree(stage, ignore_errors=True)
    result = {
        "zip": str(zip_path),
        "file_name": zip_path.name,
        "bytes": zip_path.stat().st_size,
        "times": times,
        "open": open_first,
        "fields": fields,
        "n_cells": n_cells,
        "rho": rho,
        "pa_fields": [k + PA_SUFFIX for k in kinematic] if rho != 1.0 else [],
        "units_note": note,
    }
    emit("progress", fraction=1.0, message="Done")
    emit("exported", **result)
    return result


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--case", type=Path, required=True, help="OpenFOAM case folder")
    ap.add_argument("--times", required=True, help="comma-separated saved times")
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument("--name", default="results", help="base name of the files")
    args = ap.parse_args(argv)
    try:
        export_vtk(args.case, args.times.split(","), args.out_dir, args.name)
    except ExportError as exc:
        emit("export_error", error=str(exc))
        print(str(exc), file=sys.stderr)
        return 1
    except Exception as exc:  # the user sees this sentence; the trace goes to the log
        import traceback

        traceback.print_exc()
        message = f"The export failed: {exc}"
        emit("export_error", error=message)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
