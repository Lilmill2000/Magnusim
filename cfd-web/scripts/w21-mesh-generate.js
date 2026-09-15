/**
 * Mesh Generate (POST /api/mesh/generate).
 * Standard (default engine)      -> scripts/generate_standard.py: gmsh uniform surface +
 *                                   hex element core + tet shell, OpenFOAM boundary layers.
 * Standard, engine 'cfmesh'      -> scripts/generate_cfmesh_standard.py (legacy cartesianMesh,
 *                                   only with Hex element core on; see hexcore-cfmesh-backup rule).
 * Hex-dominant                   -> snappyHexMesh (isolated; not the Standard path).
 * Cell/point counts always come from the produced polyMesh.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBody1Stl } from './w16-project-geometry.js';
import { activeGeometryId } from './w16-geometry-scope.js';
import { PYTHON, pyTool } from './python-env.js';
import { wslCasePath, wslDistro } from './wsl-env.js';
import { createJobLogger } from './log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
/* Scratch for the Hex-dominant (snappyHexMesh) path: bash scripts, logs, WSL case copies. */
const REPORT_DIR = join(ROOT, '.cache', 'jobs', 'snappy');
const PROJECTS_ROOT = process.env.CFDDESK_PROJECTS_ROOT ? resolve(process.env.CFDDESK_PROJECTS_ROOT) : join(ROOT, 'projects');
const ACTIVE_PATH = join(PROJECTS_ROOT, 'active.json');
const WSL_DISTRO = wslDistro();
/** Case layout template only — geometry surfaces overwritten from project Body1. */
const WSL_TEMPLATE_CASE = wslCasePath('cfddesk-manual-test-project-1');
const INCREMENT = 'W25';
const MESH_SURFACE_EXPORT_SCRIPT = pyTool('export_mesh_surface_vtp.py');
const MESH_SURFACE_CACHE_ROOT = join(ROOT, '.cache', 'mesh-surface');
const CFMESH_GENERATE_SCRIPT = pyTool('generate_cfmesh_standard.py');
/** SimScale-style Standard mesher (gmsh surface + hex core + tet shell + layers). */
const STANDARD_GENERATE_SCRIPT = pyTool('generate_standard.py');
const PATH_CFMESH = 'cartesianMesh';
const PATH_STANDARD = 'standard';
const PATH_SNAPPY = 'snappyHexMesh';
const GENERATE_SH_TEMPLATE = "#!/usr/bin/env bash\nset -uo pipefail\nTEMPLATE=\"__WSL_TEMPLATE__\"\nDST=\"__WSL_DST__\"\nWIN_OUT=\"__WSL_WIN_OUT__\"\nBLOCK='__BLOCK__'\nFEAT_LEVEL='__FEATURE_LEVEL__'\nWALLS_LEVEL='__WALLS_LEVEL__'\nADD_LAYERS='__ADD_LAYERS__'\nSNAP_NSMOOTH='__SNAP_NSMOOTH__'\nSNAP_TOL='__SNAP_TOL__'\nSNAP_NSOLVE='__SNAP_NSOLVE__'\nSNAP_NRELAX='__SNAP_NRELAX__'\nSNAP_NFEAT='__SNAP_NFEAT__'\nWSL_BODY1=\"__WSL_BODY1__\"\nWSL_STEP=\"__WSL_STEP__\"\nPROJECT_ID=\"__PROJECT_ID__\"\nSTEP_SHA=\"__STEP_SHA__\"\nBODY1_SHA=\"__BODY1_SHA__\"\necho \"W25_GENERATE_START generate_id=__GENERATE_ID__ bash_pid=$$ dst=$DST block=$BLOCK feature_level=$FEAT_LEVEL walls_level=$WALLS_LEVEL add_layers=$ADD_LAYERS path_kind=snappyHexMesh increment=W25\"\necho \"W25_GEOMETRY project_id=$PROJECT_ID step=$WSL_STEP body1=$WSL_BODY1 step_sha=$STEP_SHA body1_sha=$BODY1_SHA\"\necho \"W25_TEMPLATE scaffolding_only=$TEMPLATE (triSurface replaced with project Body1; NOT MTP1-silent-copy remesh)\"\nif [ ! -f \"$WSL_STEP\" ]; then\n  echo \"W25_GEOMETRY_FAIL missing source.step: $WSL_STEP\"\n  mkdir -p \"$WIN_OUT\"\n  echo \"W25_GENERATE_END exit=46 win_out=$WIN_OUT\"\n  exit 46\nfi\nif [ ! -f \"$WSL_BODY1\" ]; then\n  echo \"W25_GEOMETRY_FAIL missing Body1.stl: $WSL_BODY1\"\n  mkdir -p \"$WIN_OUT\"\n  echo \"W25_GENERATE_END exit=46 win_out=$WIN_OUT\"\n  exit 46\nfi\nrm -rf \"$DST\"\nmkdir -p \"$DST\"\ncp -a \"$TEMPLATE/constant\" \"$DST/\"\ncp -a \"$TEMPLATE/system\" \"$DST/\"\ncd \"$DST\"\npython3 - <<'PY'\nfrom pathlib import Path\nimport struct, json, sys, shutil, re, math\n\nbody1_src = Path(\"__WSL_BODY1__\")\nstep_src = Path(\"__WSL_STEP__\")\ntri = Path(\"constant/triSurface\")\ntri.mkdir(parents=True, exist_ok=True)\nfor p in list(tri.glob(\"*\")):\n    try:\n        p.unlink()\n    except IsADirectoryError:\n        shutil.rmtree(p)\n\nraw = body1_src.read_bytes()\nis_bin = len(raw) >= 84 and not raw[:5].lower().startswith(b\"solid\")\nscale = 0.001\n\ndef scale_bounds_from_binary(buf):\n    ntri = struct.unpack_from(\"<I\", buf, 80)[0]\n    xmin=ymin=zmin=float(\"inf\")\n    xmax=ymax=zmax=float(\"-inf\")\n    off = 84\n    hdr = b\"W23 Body1 from project source.step (mm->m)\"[:80].ljust(80, b\"\\0\")\n    out = bytearray(hdr)\n    out += struct.pack(\"<I\", ntri)\n    for i in range(ntri):\n        chunk = buf[off:off+50]\n        if len(chunk) < 50:\n            break\n        vals = list(struct.unpack(\"<12fH\", chunk))\n        for j in range(12):\n            vals[j] = vals[j] * scale\n        out += struct.pack(\"<12fH\", *vals)\n        xs = vals[3], vals[6], vals[9]\n        ys = vals[4], vals[7], vals[10]\n        zs = vals[5], vals[8], vals[11]\n        xmin=min(xmin,*xs); xmax=max(xmax,*xs)\n        ymin=min(ymin,*ys); ymax=max(ymax,*ys)\n        zmin=min(zmin,*zs); zmax=max(zmax,*zs)\n        off += 50\n    return bytes(out), {\"xmin\":xmin,\"xmax\":xmax,\"ymin\":ymin,\"ymax\":ymax,\"zmin\":zmin,\"zmax\":zmax,\"ntri\":ntri,\"scale\":scale}\n\nif is_bin:\n    scaled, bounds = scale_bounds_from_binary(raw)\nelse:\n    text = raw.decode(\"utf-8\", errors=\"ignore\")\n    out_lines = [\"solid Body1_W23\"]\n    xmin=ymin=zmin=float(\"inf\"); xmax=ymax=zmax=float(\"-inf\")\n    for line in text.splitlines():\n        s=line.strip()\n        if s.startswith(\"vertex\"):\n            parts=s.split()\n            x,y,z = float(parts[1])*scale, float(parts[2])*scale, float(parts[3])*scale\n            out_lines.append(f\"  vertex {x} {y} {z}\")\n            xmin=min(xmin,x); xmax=max(xmax,x)\n            ymin=min(ymin,y); ymax=max(ymax,y)\n            zmin=min(zmin,z); zmax=max(zmax,z)\n        elif s.startswith(\"facet normal\"):\n            parts=s.split()\n            nx,ny,nz=float(parts[2]),float(parts[3]),float(parts[4])\n            n=math.sqrt(nx*nx+ny*ny+nz*nz) or 1.0\n            out_lines.append(f\"facet normal {nx/n} {ny/n} {nz/n}\")\n        elif s.startswith(\"outer\") or s.startswith(\"endloop\") or s.startswith(\"endfacet\"):\n            out_lines.append(s)\n    out_lines.append(\"endsolid Body1_W23\")\n    scaled = (\"\\n\".join(out_lines)+\"\\n\").encode(\"ascii\")\n    bounds = {\"xmin\":xmin,\"xmax\":xmax,\"ymin\":ymin,\"ymax\":ymax,\"zmin\":zmin,\"zmax\":zmax,\"ntri\":None,\"scale\":scale}\n\nbody1_dst = tri / \"Body1.stl\"\nbody1_dst.write_bytes(scaled)\n\npad = 1.33\ncx = 0.5*(bounds[\"xmin\"]+bounds[\"xmax\"])\ncy = 0.5*(bounds[\"ymin\"]+bounds[\"ymax\"])\ncz = 0.5*(bounds[\"zmin\"]+bounds[\"zmax\"])\nhx = 0.5*(bounds[\"xmax\"]-bounds[\"xmin\"])*pad\nhy = 0.5*(bounds[\"ymax\"]-bounds[\"ymin\"])*pad\nhz = 0.5*(bounds[\"zmax\"]-bounds[\"zmin\"])*pad\nverts = [\n    (cx-hx, cy-hy, cz-hz),\n    (cx+hx, cy-hy, cz-hz),\n    (cx+hx, cy+hy, cz-hz),\n    (cx-hx, cy+hy, cz-hz),\n    (cx-hx, cy-hy, cz+hz),\n    (cx+hx, cy-hy, cz+hz),\n    (cx+hx, cy+hy, cz+hz),\n    (cx-hx, cy+hy, cz+hz),\n]\nloc = (cx, cy, cz - 0.15*hz)\n\nblock = \"__BLOCK__\"\nfeat_level = int(\"__FEATURE_LEVEL__\")\nwalls_level = int(\"__WALLS_LEVEL__\")\nadd_layers = (\"__ADD_LAYERS__\" == \"true\")\nsnap_nsmooth = int(\"__SNAP_NSMOOTH__\")\nsnap_tol = float(\"__SNAP_TOL__\")\nsnap_nsolve = int(\"__SNAP_NSOLVE__\")\nsnap_nrelax = int(\"__SNAP_NRELAX__\")\nsnap_nfeat = int(\"__SNAP_NFEAT__\")\n\nbm = Path(\"system/blockMeshDict\")\nbm_txt = bm.read_text()\nvert_block = \"vertices\\n(\\n\" + \"\\n\".join(f\"    ({v[0]:.8f} {v[1]:.8f} {v[2]:.8f})\" for v in verts) + \"\\n);\"\nbm_txt2 = re.sub(r\"vertices\\s*\\([\\s\\S]*?\\);\", vert_block, bm_txt, count=1)\nbm_txt2 = re.sub(r\"hex \\(0 1 2 3 4 5 6 7\\) \\([^)]+\\)\", f\"hex (0 1 2 3 4 5 6 7) {block}\", bm_txt2)\nbm.write_text(bm_txt2)\n\nsnap_lines = [\n\"FoamFile\",\n\"{\",\n\"    version     2.0;\",\n\"    format      ascii;\",\n\"    class       dictionary;\",\n\"    object      snappyHexMeshDict;\",\n\"}\",\n\"// W25: Body1/source.step + lifted addLayers/snappy_policy (not MTP1)\",\n\"castellatedMesh true;\",\n\"snap            true;\",\nf\"addLayers       {\'true\' if add_layers else \'false\'};\",\n\"\",\n\"geometry\",\n\"{\",\n\"    Body1.stl\",\n\"    {\",\n\"        type triSurfaceMesh;\",\n\"        name Body1;\",\n\"    }\",\n\"}\",\n\"\",\n\"castellatedMeshControls\",\n\"{\",\n\"    maxLocalCells 2000000;\",\n\"    maxGlobalCells 4000000;\",\n\"    minRefinementCells 0;\",\n\"    maxLoadUnbalance 0.10;\",\n\"    nCellsBetweenLevels 2;\",\n\"\",\n\"    features\",\n\"    (\",\n\"        {\",\n'            file \"cadFeatures.eMesh\";',\nf\"            level {feat_level};\",\n\"        }\",\n\"    );\",\n\"\",\n\"    refinementSurfaces\",\n\"    {\",\n\"        Body1\",\n\"        {\",\nf\"            level ({walls_level} {walls_level});\",\n\"            patchInfo { type wall; }\",\n\"        }\",\n\"    }\",\n\"\",\n\"    resolveFeatureAngle 20;\",\n\"    refinementRegions {}\",\nf\"    locationInMesh ({loc[0]:.8f} {loc[1]:.8f} {loc[2]:.8f});\",\n\"    allowFreeStandingZoneFaces true;\",\n\"}\",\n\"\",\n\"snapControls\",\n\"{\",\nf\"    nSmoothPatch {snap_nsmooth};\",\nf\"    tolerance {snap_tol};\",\nf\"    nSolveIter {snap_nsolve};\",\nf\"    nRelaxIter {snap_nrelax};\",\nf\"    nFeatureSnapIter {snap_nfeat};\",\n\"    implicitFeatureSnap false;\",\n\"    explicitFeatureSnap true;\",\n\"    multiRegionFeatureSnap false;\",\n\"}\",\n\"\",\n\"addLayersControls\",\n\"{\",\n\"    relativeSizes true;\",\n\"    layers\",\n\"    {\",\n*( [\"        Body1\", \"        {\", \"            nSurfaceLayers 2;\", \"        }\"] if add_layers else [] ),\n\"    }\",\nf\"    expansionRatio {1.1 if add_layers else 1.0};\",\n\"    finalLayerThickness 0.3;\",\nf\"    minThickness {0.2 if add_layers else 0.1};\",\n\"    nGrow 0;\",\nf\"    featureAngle {130 if add_layers else 60};\",\n\"    slipFeatureAngle 30;\",\nf\"    nRelaxIter {5 if add_layers else 3};\",\nf\"    nSmoothSurfaceNormals {3 if add_layers else 1};\",\nf\"    nSmoothNormals {10 if add_layers else 3};\",\n\"    nSmoothThickness 10;\",\n\"    maxFaceThicknessRatio 0.5;\",\n\"    maxThicknessToMedialRatio 0.3;\",\n\"    minMedialAxisAngle 90;\",\n\"    nBufferCellsNoExtrude 0;\",\n\"    nLayerIter 50;\",\n\"}\",\n\"\",\n\"meshQualityControls\",\n\"{\",\n\"    maxNonOrtho 65;\",\n\"    maxBoundarySkewness 20;\",\n\"    maxInternalSkewness 4;\",\n\"    maxConcave 80;\",\n\"    minVol 1e-13;\",\n\"    minTetQuality 1e-30;\",\n\"    minArea -1;\",\n\"    minTwist 0.02;\",\n\"    minDeterminant 0.001;\",\n\"    minFaceWeight 0.05;\",\n\"    minVolRatio 0.01;\",\n\"    minTriangleTwist -1;\",\n\"    nSmoothScale 4;\",\n\"    errorReduction 0.75;\",\n\"    relaxed\",\n\"    {\",\n\"        maxNonOrtho 75;\",\n\"    }\",\n\"}\",\n\"\",\n\"debug 0;\",\n\"mergeTolerance 1e-6;\",\n]\nPath(\"system/snappyHexMeshDict\").write_text(\"\\n\".join(snap_lines) + \"\\n\")\n\nsfe = \"\"\"FoamFile\n{\n    version     2.0;\n    format      ascii;\n    class       dictionary;\n    object      surfaceFeatureExtractDict;\n}\nBody1.stl\n{\n    extractionMethod    extractFromSurface;\n    includedAngle       150;\n    writeObj            yes;\n}\n\"\"\"\nPath(\"system/surfaceFeatureExtractDict\").write_text(sfe)\n\nmeta = {\n  \"increment\": \"W23\",\n  \"project_id\": \"__PROJECT_ID__\",\n  \"step_path\": str(step_src),\n  \"body1_path_src\": str(body1_src),\n  \"body1_path_case\": str(body1_dst.resolve()),\n  \"step_sha256\": \"__STEP_SHA__\",\n  \"body1_sha256_src\": \"__BODY1_SHA__\",\n  \"body1_bytes_scaled\": len(scaled),\n  \"bounds_m\": bounds,\n  \"feature_level\": feat_level,\n  \"walls_level\": walls_level,\n  \"add_layers\": add_layers,\n  \"snappy_geometry_rev\": 3,\n  \"snap\": {\"n_smooth_patch\": snap_nsmooth, \"tolerance\": snap_tol, \"n_solve_iter\": snap_nsolve, \"n_relax_iter\": snap_nrelax, \"n_feature_snap_iter\": snap_nfeat},\n  \"block\": block,\n  \"locationInMesh\": list(loc),\n  \"template_case\": \"__WSL_TEMPLATE__\",\n  \"template_role\": \"scaffolding_only\",\n  \"mtp1_silent_copy\": False,\n  \"geometry_source\": \"W16_project_STEP_Body1\",\n}\nPath(\"w23-geometry-meta.json\").write_text(json.dumps(meta, indent=2))\nprint(\"W25_DICTS_PATCHED\", json.dumps({\"bounds_m\": bounds, \"body1_bytes\": len(scaled), \"ntri\": bounds.get(\"ntri\")}))\nPY\nEC_PATCH=$?\nif [ \"$EC_PATCH\" -ne 0 ]; then\n  echo \"W25_PATCH_FAIL exit=$EC_PATCH\"\n  mkdir -p \"$WIN_OUT\"\n  echo \"W25_GENERATE_END exit=$EC_PATCH win_out=$WIN_OUT\"\n  exit $EC_PATCH\nfi\necho \"W25_CWD=$(pwd)\"\nopenfoam2606 surfaceFeatureExtract 2>&1 | tee log.surfaceFeatureExtract\nEC_SFE=${PIPESTATUS[0]}\necho \"W25_SURFACEFEATURE_END exit=$EC_SFE\"\nif [ \"$EC_SFE\" -ne 0 ]; then\n  mkdir -p \"$WIN_OUT\"\n  cp -f log.surfaceFeatureExtract w23-geometry-meta.json \"$WIN_OUT/\" 2>/dev/null || true\n  echo \"W25_GENERATE_END exit=$EC_SFE win_out=$WIN_OUT\"\n  exit $EC_SFE\nfi\nif [ -f constant/triSurface/Body1.eMesh ]; then\n  cp -f constant/triSurface/Body1.eMesh constant/triSurface/cadFeatures.eMesh\nfi\npython3 - <<'PY'\nfrom pathlib import Path\nimport sys, json\nem = Path(\"constant/triSurface/cadFeatures.eMesh\")\nif not em.is_file() or em.stat().st_size < 50:\n    b = Path(\"constant/triSurface/Body1.eMesh\")\n    if b.is_file():\n        em.write_bytes(b.read_bytes())\nif not em.is_file() or em.stat().st_size < 50:\n    print(\"W25_EMESH_FAIL missing_or_empty\", em, file=sys.stderr)\n    sys.exit(42)\nlines = em.read_text(errors=\"ignore\").splitlines()\nints=[]; past=False\nfor i,l in enumerate(lines):\n    s=l.strip()\n    if not past:\n        if s==\"}\" or s.startswith(\"// *****\"): past=True\n        continue\n    if s.isdigit(): ints.append(int(s))\n    if len(ints)>=2: break\nn_edges = ints[1] if len(ints)>1 else 0\nif n_edges < 1:\n    print(\"W25_EMESH_FAIL zero_edges\", file=sys.stderr)\n    sys.exit(42)\nmeta_path = Path(\"w23-geometry-meta.json\")\nmeta = json.loads(meta_path.read_text()) if meta_path.is_file() else {}\nmeta[\"emesh_bytes\"] = em.stat().st_size\nmeta[\"emesh_n_edges\"] = n_edges\nmeta[\"emesh_n_points\"] = ints[0] if ints else None\nmeta_path.write_text(json.dumps(meta, indent=2))\nPath(\"w21-feature-meta.json\").write_text(json.dumps(meta, indent=2))\nprint(\"W25_EMESH_OK\", json.dumps({\"bytes\": em.stat().st_size, \"n_edges\": n_edges, \"n_points\": ints[0] if ints else None}))\nwalls = Path(\"constant/triSurface/walls.stl\")\ninlet = Path(\"constant/triSurface/inlet.stl\")\nif walls.is_file() or inlet.is_file():\n    print(\"W25_MTP1_LEAK walls/inlet still present\", file=sys.stderr)\n    sys.exit(47)\nif not Path(\"constant/triSurface/Body1.stl\").is_file():\n    print(\"W25_GEOMETRY_FAIL Body1.stl missing in case\", file=sys.stderr)\n    sys.exit(46)\nPY\nEC_EM=$?\nif [ \"$EC_EM\" -ne 0 ]; then\n  mkdir -p \"$WIN_OUT\"\n  cp -f log.surfaceFeatureExtract w23-geometry-meta.json \"$WIN_OUT/\" 2>/dev/null || true\n  echo \"W25_GENERATE_END exit=$EC_EM win_out=$WIN_OUT\"\n  exit $EC_EM\nfi\nopenfoam2606 blockMesh 2>&1 | tee log.blockMesh\nEC_BM=${PIPESTATUS[0]}\necho \"W25_BLOCKMESH_END exit=$EC_BM\"\nif [ \"$EC_BM\" -ne 0 ]; then\n  mkdir -p \"$WIN_OUT\"\n  cp -f log.blockMesh w23-geometry-meta.json \"$WIN_OUT/\" 2>/dev/null || true\n  echo \"W25_GENERATE_END exit=$EC_BM win_out=$WIN_OUT\"\n  exit $EC_BM\nfi\nPHYS=$(lscpu -p=CORE,SOCKET 2>/dev/null | grep -v '^#' | sort -u | wc -l | tr -d ' ')\nTHREADS=$(nproc 2>/dev/null || echo 1)\nNPROC=$THREADS\nif [ -n \"$PHYS\" ] && [ \"$PHYS\" -ge 1 ]; then\n  NPROC=$PHYS\nfi\nif [ \"$NPROC\" -lt 1 ]; then\n  NPROC=1\nfi\necho \"W25_NPROC threads=$THREADS cores=$PHYS using=$NPROC\"\nrm -rf 0 processor*\nrun_serial_snappy() {\n  rm -rf processor*\n  openfoam2606 snappyHexMesh -overwrite 2>&1 | tee log.snappyHexMesh\n  EC=${PIPESTATUS[0]}\n}\nif [ \"$NPROC\" -gt 1 ]; then\n  printf '%s\\n' 'FoamFile' '{' '    version     2.0;' '    format      ascii;' '    class       dictionary;' '    object      decomposeParDict;' '}' \"numberOfSubdomains $NPROC;\" 'method          scotch;' > system/decomposeParDict\n  openfoam2606 decomposePar 2>&1 | tee log.decomposePar\n  EC_DEC=${PIPESTATUS[0]}\n  echo \"W25_DECOMPOSE_END exit=$EC_DEC nproc=$NPROC\"\n  if [ \"$EC_DEC\" -ne 0 ]; then\n    echo \"W25_DECOMPOSE_FALLBACK serial\"\n    run_serial_snappy\n  else\n    openfoam2606 mpirun -np \"$NPROC\" snappyHexMesh -parallel -overwrite 2>&1 | tee log.snappyHexMesh\n    EC=${PIPESTATUS[0]}\n    echo \"W25_SNAPPY_MPI_END exit=$EC\"\n    if [ \"$EC\" -eq 0 ]; then\n      openfoam2606 reconstructParMesh -constant -mergeTol 1e-6 2>&1 | tee log.reconstructParMesh\n      rm -rf processor*\n    else\n      echo \"W25_MPI_FALLBACK serial\"\n      run_serial_snappy\n    fi\n  fi\nelse\n  run_serial_snappy\nfi\necho \"W25_SNAPPY_END exit=$EC nproc=$NPROC\"\npython3 - <<'PY'\nfrom pathlib import Path\nimport re, json, sys\ntext = Path(\"log.snappyHexMesh\").read_text(errors=\"ignore\")\nmarks = [int(x) for x in re.findall(r\"Marked for refinement due to explicit features\\s*:\\s*(\\d+)\", text)]\ntotal = sum(marks) if marks else 0\nPath(\"w21-feature-marks.json\").write_text(json.dumps({\"marks\": marks, \"total\": total}, indent=2))\nprint(\"W25_FEATURE_MARKS\", marks, \"total\", total)\nif total < 1:\n    print(\"W25_FEATURE_MARKS_FAIL zero explicit feature refinement\", file=sys.stderr)\n    sys.exit(44)\nPY\nEC_FEAT=$?\nif [ \"$EC_FEAT\" -ne 0 ]; then\n  EC=$EC_FEAT\nfi\npython3 - <<'PY'\nfrom pathlib import Path\nimport json\ndef first_int(path):\n    lines = Path(path).read_text(errors=\"ignore\").splitlines()\n    past = False\n    for i,l in enumerate(lines):\n        s=l.strip()\n        if not past:\n            if s == \"}\" or s.startswith(\"// *****\"):\n                past = True\n            continue\n        if s.isdigit() and i > 5:\n            return int(s)\n    return None\ndef n_cells_owner(path):\n    lines = Path(path).read_text(errors=\"ignore\").splitlines()\n    mode=\"seek\"; vals=[]; nfaces=None\n    for i,l in enumerate(lines):\n        s=l.strip()\n        if mode==\"seek\":\n            if s.isdigit() and i>10:\n                nfaces=int(s); mode=\"paren\"\n            continue\n        if mode==\"paren\":\n            if s==\"(\": mode=\"vals\"\n            continue\n        if mode==\"vals\":\n            if s==\")\": break\n            if s.lstrip(\"-\").isdigit(): vals.append(int(s))\n    return (max(vals)+1 if vals else None), (nfaces if nfaces is not None else len(vals))\npm = Path(\"constant/polyMesh\")\nn_points = first_int(pm/\"points\") if (pm/\"points\").is_file() else None\nn_cells, n_faces = n_cells_owner(pm/\"owner\") if (pm/\"owner\").is_file() else (None, None)\ndoc = {\n  \"n_points\": n_points,\n  \"n_cells\": n_cells,\n  \"n_faces\": n_faces,\n  \"source\": \"polyMesh/points+owner\",\n  \"polyMesh\": str(pm.resolve()),\n  \"increment\": \"W23\",\n}\nPath(\"w21-counts.json\").write_text(json.dumps(doc, indent=2))\nprint(\"W25_COUNTS\", json.dumps(doc))\nif n_cells in (694700, 694712, 293400, 293412):\n    print(\"W25_COUNTS_SUSPECT hardcoded_bankish\", n_cells, file=__import__(\"sys\").stderr)\nPY\nrm -rf \"$WIN_OUT\"\nmkdir -p \"$WIN_OUT/constant/triSurface\" \"$WIN_OUT/system\"\nif [ -d constant/polyMesh ]; then cp -a constant/polyMesh \"$WIN_OUT/constant/\"; fi\nif [ -f constant/triSurface/cadFeatures.eMesh ]; then cp -f constant/triSurface/cadFeatures.eMesh \"$WIN_OUT/constant/triSurface/\"; fi\nif [ -f constant/triSurface/Body1.stl ]; then cp -f constant/triSurface/Body1.stl \"$WIN_OUT/constant/triSurface/\"; fi\ncp -a system \"$WIN_OUT/\" 2>/dev/null || true\ncp -f log.blockMesh log.snappyHexMesh log.surfaceFeatureExtract log.decomposePar log.reconstructParMesh w21-counts.json w21-feature-meta.json w21-feature-marks.json w23-geometry-meta.json \"$WIN_OUT/\" 2>/dev/null || true\ntouch \"$WIN_OUT/case.foam\"\necho \"W25_GENERATE_END exit=$EC win_out=$WIN_OUT path_kind=snappyHexMesh step=$WSL_STEP body1=$WSL_BODY1 increment=W25\"\nexit $EC\n";

/** @type {null | { child: import('node:child_process').ChildProcess, generate_id: string }} */
let liveJob = null;

function stampId() {
  return randomBytes(4).toString('hex');
}

function readActiveId() {
  if (!existsSync(ACTIVE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(ACTIVE_PATH, 'utf8')).project_id || null;
  } catch {
    return null;
  }
}

function meshJsonPath(projectId) {
  return join(PROJECTS_ROOT, projectId, 'mesh.json');
}

function projectJsonPath(projectId) {
  return join(PROJECTS_ROOT, projectId, 'project.json');
}

function readMeshDoc(projectId) {
  const p = meshJsonPath(projectId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeMeshDoc(projectId, doc) {
  mkdirSync(join(PROJECTS_ROOT, projectId), { recursive: true });
  const p = meshJsonPath(projectId);
  writeFileSync(p, JSON.stringify(doc, null, 2), 'utf8');
  return p;
}

function winToWsl(winPath) {
  const posix = String(winPath).replace(/\\/g, '/');
  const m = posix.match(/^([A-Za-z]):\/(.*)$/);
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2]}` : posix;
}

/**
 * Resolve active W16 project geometry: source.step + Body1.stl.
 * HARD FAIL if missing — never silently fall back to MTP1 walls.stl.
 */
export function resolveProjectGeometry(projectId) {
  const id = projectId || readActiveId();
  if (!id) {
    return { ok: false, error: 'no active project; create W16 project + import STEP first' };
  }
  const projPath = projectJsonPath(id);
  if (!existsSync(projPath)) {
    return { ok: false, error: 'project.json missing', project_id: id };
  }
  let proj;
  try {
    proj = JSON.parse(readFileSync(projPath, 'utf8'));
  } catch (e) {
    return { ok: false, error: 'project.json unreadable: ' + e, project_id: id };
  }
  const geom = proj.geometry || {};
  const step_path =
    geom.step_path || join(PROJECTS_ROOT, id, 'geometry', 'source.step');
  const body1_path =
    geom.stl_path || join(PROJECTS_ROOT, id, 'geometry', 'Body1.stl');
  if (!existsSync(step_path)) {
    return {
      ok: false,
      error: 'W16 source.step missing — import geometry first',
      project_id: id,
      step_path,
      body1_path,
    };
  }
  if (!existsSync(body1_path)) {
    return {
      ok: false,
      error: 'W16 Body1.stl missing — import geometry first',
      project_id: id,
      step_path,
      body1_path,
    };
  }
  const stepSt = statSync(step_path);
  const bodySt = statSync(body1_path);
  if (stepSt.size < 32 || bodySt.size < 100) {
    return {
      ok: false,
      error: 'geometry files too small / empty',
      project_id: id,
      step_path,
      body1_path,
      step_bytes: stepSt.size,
      body1_bytes: bodySt.size,
    };
  }
  const bodyBuf = readFileSync(body1_path);
  const body1_sha256 = createHash('sha256').update(bodyBuf).digest('hex');
  const stepBuf = readFileSync(step_path);
  const step_sha256 = createHash('sha256').update(stepBuf).digest('hex');
  return {
    ok: true,
    project_id: id,
    step_path,
    body1_path,
    step_bytes: stepSt.size,
    body1_bytes: bodySt.size,
    step_sha256,
    body1_sha256,
    geometry_name: geom.name || null,
    wsl_step: winToWsl(step_path),
    wsl_body1: winToWsl(body1_path),
    cad_faces_path: join(PROJECTS_ROOT, id, 'geometry', 'cad_faces.vtp'),
    bounds:
      (geom.fingerprint && geom.fingerprint.bounds) ||
      (geom.fingerprint &&
        geom.fingerprint.convert_meta &&
        geom.fingerprint.convert_meta.bounds) ||
      null,
  };
}

/** Lifted from cfddesk mesh/snappy_policy.py (SNAPPY_GEOMETRY_REV=3). */
const SNAPPY_GEOMETRY_REV = 3;
const FEATURE_LEVEL_CAP = 4;

function clampFineness(fineness) {
  const f = Math.round(Number(fineness));
  if (!Number.isFinite(f)) return 5;
  return Math.max(1, Math.min(10, f));
}

function featureLevelFromFineness(fineness) {
  const f = clampFineness(fineness);
  return Math.min(FEATURE_LEVEL_CAP, 2 + Math.floor((f - 1) / 3));
}

/** Preferential feature level: max(walls+1, fineness floor), cap 4. */
function featureRefinementLevel(wallsLevel, fineness) {
  const fromWalls = Number(wallsLevel) + 1;
  const fromFineness = featureLevelFromFineness(fineness);
  return Math.min(FEATURE_LEVEL_CAP, Math.max(2, fromWalls, fromFineness));
}

/**
 * Lifted from cfddesk project/mesh_sizing.physics_refinement_for_fineness.
 * F<=3 -> walls 1; F4-6 -> walls 2; F7-10 -> walls 3. Physics-off -> walls 1.
 */
function wallsLevelForSettings(settings) {
  const f = clampFineness(settings && settings.fineness != null ? settings.fineness : 5);
  const phys =
    !settings || settings.physics_based_meshing === undefined
      ? true
      : !!settings.physics_based_meshing;
  if (!phys || f <= 3) return 1;
  return Math.min(3, 1 + Math.floor((f - 1) / 3));
}

/**
 * Official snappy snapControls (ESI snap guide + OpenFOAM user-guide 4.4).
 * nSmoothPatch 3, tolerance 2.0, nSolveIter 30, nRelaxIter 5,
 * nFeatureSnapIter 10, implicitFeatureSnap false, explicitFeatureSnap true.
 * Implicit snap is only for simple geometry without sharp corners.
 * Feature snap needs extra iterations; do not invent 100+ nSolveIter.
 */
function snapControlsForFineness(fineness, hasFeatures = true) {
  const f = clampFineness(fineness);
  return {
    n_smooth_patch: 3,
    tolerance: 2.0,
    n_solve_iter: 30,
    n_relax_iter: 5,
    n_feature_snap_iter: hasFeatures ? (f <= 3 ? 10 : 15) : 10,
    implicit_feature_snap: false,
    explicit_feature_snap: true,
  };
}

/** Lifted from cfddesk mesh_sizing.cells_across / base_cell_from_fineness. */
function cellsAcross(fineness) {
  const f = clampFineness(fineness);
  return 16.0 * Math.pow(2.0, (f - 1) / 3.0);
}

/**
 * Prefer bbox-diagonal base-cell block counts when bounds known (prepare_mesh_case spirit).
 * Fallback ladder kept for missing bounds.
 */
function blockFromFineness(fineness, boundsM) {
  const f = clampFineness(fineness);
  if (boundsM && Number.isFinite(boundsM.xmin)) {
    const dx = Math.abs(boundsM.xmax - boundsM.xmin);
    const dy = Math.abs(boundsM.ymax - boundsM.ymin);
    const dz = Math.abs(boundsM.zmax - boundsM.zmin);
    const diag = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    const base = Math.max(1e-5, Math.min(1.0, diag / cellsAcross(f)));
    // padded domain ~1.33 like generate script
    const pad = 1.33;
    const nx = Math.max(8, Math.round((dx * pad) / base));
    const ny = Math.max(8, Math.round((dy * pad) / base));
    const nz = Math.max(12, Math.round((dz * pad) / base));
    return `(${nx} ${ny} ${nz})`;
  }
  if (f <= 3) return '(10 10 20)';
  if (f <= 6) return '(18 18 48)'; // denser than old (12 12 24); F5 mesh_sizing-aligned
  if (f <= 8) return '(24 24 64)';
  return '(32 32 80)';
}

function finenessParams(fineness, settings, boundsM) {
  const f = clampFineness(fineness);
  const wallsLevel = wallsLevelForSettings({
    ...(settings || {}),
    fineness: f,
  });
  const featureLevel = featureRefinementLevel(wallsLevel, f);
  const snap = snapControlsForFineness(f, true);
  const block = blockFromFineness(f, boundsM);
  return { block, featureLevel, wallsLevel, snap, snappy_geometry_rev: SNAPPY_GEOMETRY_REV };
}


export function readPolyMeshCounts(polyMeshDir) {
  const pointsPath = join(polyMeshDir, 'points');
  const ownerPath = join(polyMeshDir, 'owner');
  if (!existsSync(pointsPath) || !existsSync(ownerPath)) {
    return {
      n_points: null,
      n_cells: null,
      n_faces: null,
      points_path: pointsPath,
      owner_path: ownerPath,
    };
  }
  const pointsTxt = readFileSync(pointsPath, 'utf8');
  const ownerTxt = readFileSync(ownerPath, 'utf8');

  function firstIntAfterHeader(txt) {
    const lines = txt.split(/\r?\n/);
    let past = false;
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i].trim();
      if (!past) {
        if (s === '}' || s.startsWith('// *****')) past = true;
        continue;
      }
      if (/^\d+$/.test(s) && i > 5) return parseInt(s, 10);
    }
    return null;
  }

  const n_points = firstIntAfterHeader(pointsTxt);
  const ownerLines = ownerTxt.split(/\r?\n/);
  let mode = 'seek';
  const vals = [];
  let n_faces = null;
  for (let i = 0; i < ownerLines.length; i++) {
    const s = ownerLines[i].trim();
    if (mode === 'seek') {
      if (/^\d+$/.test(s) && i > 10) {
        n_faces = parseInt(s, 10);
        mode = 'paren';
      }
      continue;
    }
    if (mode === 'paren') {
      if (s === '(') mode = 'vals';
      continue;
    }
    if (mode === 'vals') {
      if (s === ')') break;
      if (/^-?\d+$/.test(s)) vals.push(parseInt(s, 10));
    }
  }
  let maxOwner = -1;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] > maxOwner) maxOwner = vals[i];
  }
  const n_cells = vals.length ? maxOwner + 1 : null;
  return {
    n_points,
    n_cells,
    n_faces: n_faces != null ? n_faces : vals.length,
    points_path: pointsPath,
    owner_path: ownerPath,
    source: 'polyMesh/points+owner',
  };
}

function readEmeshStats(emeshPath) {
  if (!existsSync(emeshPath)) return { present: false, n_points: null, n_edges: null, bytes: 0 };
  const st = statSync(emeshPath);
  const lines = readFileSync(emeshPath, 'utf8').split(/\r?\n/);
  const ints = [];
  let past = false;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!past) {
      if (s === '}' || s.startsWith('// *****')) past = true;
      continue;
    }
    if (/^\d+$/.test(s)) ints.push(parseInt(s, 10));
    if (ints.length >= 2) break;
  }
  return {
    present: true,
    n_points: ints[0] ?? null,
    n_edges: ints[1] ?? null,
    bytes: st.size,
    path: emeshPath,
  };
}

function fingerprintPolyMesh(polyMeshDir) {
  const pointsPath = join(polyMeshDir, 'points');
  const ownerPath = join(polyMeshDir, 'owner');
  const h = createHash('sha256');
  if (existsSync(pointsPath)) {
    const st = statSync(pointsPath);
    h.update(`points:${st.size}:${st.mtimeMs}`);
    const buf = readFileSync(pointsPath);
    h.update(buf.subarray(0, Math.min(2048, buf.length)));
    if (buf.length > 2048) h.update(buf.subarray(buf.length - 2048));
  }
  if (existsSync(ownerPath)) {
    const st = statSync(ownerPath);
    h.update(`owner:${st.size}:${st.mtimeMs}`);
    const buf = readFileSync(ownerPath);
    h.update(buf.subarray(0, Math.min(2048, buf.length)));
    if (buf.length > 2048) h.update(buf.subarray(buf.length - 2048));
  }
  const counts = readPolyMeshCounts(polyMeshDir);
  h.update(`cells:${counts.n_cells}:pts:${counts.n_points}`);
  return { sha256: h.digest('hex'), ...counts };
}

function meshSurfaceCacheKey(caseDir) {
  const h = createHash('sha256').update(String(caseDir)).digest('hex').slice(0, 16);
  return join(MESH_SURFACE_CACHE_ROOT, `surface-${h}.vtp`);
}

function prewarmMeshSurface(winOut) {
  if (!existsSync(MESH_SURFACE_EXPORT_SCRIPT) || !existsSync(PYTHON)) {
    return { ok: false, skipped: 'missing_tool' };
  }
  mkdirSync(MESH_SURFACE_CACHE_ROOT, { recursive: true });
  const outVtp = meshSurfaceCacheKey(winOut);
  const metaPath = outVtp.replace(/\.vtp$/i, '.meta.json');
  const r = spawnSync(
    PYTHON,
    [MESH_SURFACE_EXPORT_SCRIPT, '--case', winOut, '--out', outVtp, '--meta', metaPath],
    { encoding: 'utf8', timeout: 180000, windowsHide: true }
  );
  return { ok: r.status === 0 && existsSync(outVtp), path: outVtp, status: r.status };
}

function fillGenerateScript(template, map) {
  let s = template;
  for (const [k, v] of Object.entries(map)) {
    s = s.split(k).join(String(v));
  }
  return s;
}

function writeGenerateScript({
  generateId,
  wslDst,
  winOut,
  wslWinOut,
  block,
  featureLevel,
  wallsLevel,
  addLayers,
  snap,
  geometry,
}) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const shPath = join(REPORT_DIR, `generate-${generateId}.sh`);
  const body = fillGenerateScript(GENERATE_SH_TEMPLATE, {
    __WSL_TEMPLATE__: WSL_TEMPLATE_CASE,
    __WSL_DST__: wslDst,
    __WSL_WIN_OUT__: wslWinOut,
    __BLOCK__: block,
    __FEATURE_LEVEL__: String(featureLevel),
    __WALLS_LEVEL__: String(wallsLevel),
    __ADD_LAYERS__: addLayers ? 'true' : 'false',
    __SNAP_NSMOOTH__: String(snap.n_smooth_patch),
    __SNAP_TOL__: String(snap.tolerance),
    __SNAP_NSOLVE__: String(snap.n_solve_iter),
    __SNAP_NRELAX__: String(snap.n_relax_iter),
    __SNAP_NFEAT__: String(snap.n_feature_snap_iter),
    __WSL_BODY1__: geometry.wsl_body1,
    __WSL_STEP__: geometry.wsl_step,
    __PROJECT_ID__: geometry.project_id,
    __STEP_SHA__: geometry.step_sha256,
    __BODY1_SHA__: geometry.body1_sha256,
    __GENERATE_ID__: generateId,
  });
  writeFileSync(shPath, body.replace(/\r\n/g, '\n'), 'utf8');
  return { shPath, wslSh: winToWsl(shPath), winOut };
}

export function persistMeshResult(projectId, resultFields) {
  if (!projectId) return null;
  const existing = readMeshDoc(projectId) || {};
  const now = new Date().toISOString();
  const pathKind = resultFields.path_kind || PATH_SNAPPY;
  const increment = resultFields.increment || INCREMENT;
  const live = {
    status: resultFields.status,
    path_kind: pathKind,
    generate_id: resultFields.generate_id,
    pid: resultFields.pid,
    exit_code: resultFields.exit_code,
    command: resultFields.command,
    log_path: resultFields.log_path,
    log_excerpt: resultFields.log_excerpt || null,
    wsl_case: resultFields.wsl_case,
    case_dir: resultFields.case_dir,
    mesh_path:
      resultFields.mesh_path ||
      (resultFields.case_dir ? join(resultFields.case_dir, 'constant', 'polyMesh') : null),
    n_cells: resultFields.n_cells ?? null,
    n_points: resultFields.n_points ?? null,
    n_faces: resultFields.n_faces ?? null,
    counts_source: resultFields.counts_source || null,
    emesh: resultFields.emesh || null,
    feature_marks_total: resultFields.feature_marks_total ?? null,
    fingerprint_before: resultFields.fingerprint_before || null,
    fingerprint_after: resultFields.fingerprint_after || null,
    started_at: resultFields.started_at,
    finished_at: resultFields.finished_at || null,
    settings_snapshot: resultFields.settings_snapshot || null,
    geometry: resultFields.geometry || null,
    step_path: resultFields.step_path || null,
    body1_path: resultFields.body1_path || null,
    engine: resultFields.engine || null,
    stage: resultFields.stage || null,
    stage_detail: resultFields.stage_detail || null,
    error: resultFields.error || null,
    hex_core_applied: resultFields.hex_core_applied ?? null,
    layers_applied: resultFields.layers_applied ?? null,
    surface_size_m: resultFields.surface_size_m ?? null,
    note: resultFields.note,
    increment,
  };
  const fallbackNote =
    resultFields.status === 'done'
      ? `Mesh done: ${live.n_cells} cells, ${live.n_points} points.`
      : resultFields.status === 'failed'
        ? `Mesh failed (exit ${resultFields.exit_code}).`
        : 'Mesh running.';
  const generated = resultFields.status === 'done';
  const meshId = resultFields.mesh_id || null;
  let meshes = Array.isArray(existing.meshes) ? existing.meshes.slice() : null;
  if (meshes && meshes.length) {
    let idx = meshId ? meshes.findIndex((m) => m && m.id === meshId) : -1;
    if (idx < 0 && resultFields.generate_id) {
      idx = meshes.findIndex(
        (m) =>
          m &&
          m.live_mesh_result &&
          String(m.live_mesh_result.generate_id || '') === String(resultFields.generate_id)
      );
    }
    if (idx >= 0) {
      const prev = meshes[idx] || {};
      meshes[idx] = {
        ...prev,
        id: meshes[idx].id,
        name: meshes[idx].name || existing.name,
        settings: meshes[idx].settings || existing.settings || null,
        generated,
        live_mesh_result: live,
        geometry_id: prev.geometry_id || null,
        simulation_id: prev.simulation_id || null,
        updated_at: now,
      };
    } else {
      return existing;
    }
    const nextActive =
      (existing.active_id && meshes.some((m) => m && m.id === existing.active_id)
        ? existing.active_id
        : null) ||
      (meshId && meshes.some((m) => m && m.id === meshId) ? meshId : null);
    const activeEntry = meshes.find((m) => m && m.id === nextActive) || null;
    const doc = {
      ...existing,
      generated: !!(activeEntry && activeEntry.generated),
      generate_available: true,
      live_mesh_result: (activeEntry && activeEntry.live_mesh_result) || null,
      note: resultFields.note || fallbackNote,
      updated_at: now,
      increment,
      active_id: nextActive,
      meshes,
    };
    delete doc.out_of_scope;
    writeMeshDoc(projectId, doc);
    return doc;
  }
  const doc = {
    ...existing,
    generated,
    generate_available: true,
    live_mesh_result: live,
    note: resultFields.note || fallbackNote,
    updated_at: now,
    increment,
    active_id: existing.active_id || existing.id || meshId || null,
  };
  delete doc.out_of_scope;
  writeMeshDoc(projectId, doc);
  return doc;
}

function wantsStandard(settings) {
  const algo = String((settings && settings.algorithm) || 'Standard')
    .trim()
    .toLowerCase();
  return algo === 'standard' || algo === '';
}

function wantsHexCore(settings) {
  return !settings || settings.hex_element_core === undefined
    ? true
    : !!settings.hex_element_core;
}

/**
 * Standard engine: 'standard' (SimScale-style gmsh surface + hex core, default)
 * or 'cfmesh' (legacy cartesianMesh, hex core only). Chosen in Advanced settings.
 */
function standardEngine(settings) {
  const adv = (settings && settings.advanced) || {};
  const eng = String(adv.mesh_engine || settings?.mesh_engine || 'standard')
    .trim()
    .toLowerCase();
  return eng === 'cfmesh' && wantsHexCore(settings) ? 'cfmesh' : 'standard';
}

function wantsHexDominant(settings) {
  const algo = String((settings && settings.algorithm) || '')
    .trim()
    .toLowerCase();
  return algo.startsWith('hex-dominant') || algo === 'hexdominant';
}

function parseCfmeshLine(line) {
  const s = String(line || '').trim();
  if (s.startsWith('CFMESH_PROGRESS ')) {
    try {
      return { kind: 'progress', data: JSON.parse(s.slice('CFMESH_PROGRESS '.length)) };
    } catch {
      return null;
    }
  }
  if (s.startsWith('CFMESH_RESULT ')) {
    try {
      return { kind: 'result', data: JSON.parse(s.slice('CFMESH_RESULT '.length)) };
    } catch {
      return null;
    }
  }
  return null;
}

function resolveProjectStep(projectId) {
  const full = resolveProjectGeometry(projectId);
  if (full.ok) return full;
  const id = projectId || readActiveId();
  if (!id) return full;
  const step_path = join(PROJECTS_ROOT, id, 'geometry', 'source.step');
  if (!existsSync(step_path)) return full;
  const st = statSync(step_path);
  if (st.size < 32) return full;
  const stepBuf = readFileSync(step_path);
  return {
    ok: true,
    project_id: id,
    step_path,
    body1_path: full.body1_path || join(PROJECTS_ROOT, id, 'geometry', 'Body1.stl'),
    step_bytes: st.size,
    body1_bytes: 0,
    step_sha256: createHash('sha256').update(stepBuf).digest('hex'),
    body1_sha256: null,
    geometry_name: null,
    wsl_step: winToWsl(step_path),
    wsl_body1: null,
    bounds: null,
  };
}

/**
 * Standard mesh generate (python host script + WSL OpenFOAM tools).
 * engine 'standard' → generate_standard.py (gmsh surface, hex core, layers)
 * engine 'cfmesh'   → generate_cfmesh_standard.py (legacy cartesianMesh)
 */
function startStandardGenerate({ settings, projectId, onUpdate, engine, meshId }) {
  const pathKind = engine === 'cfmesh' ? PATH_CFMESH : PATH_STANDARD;
  if (!meshId) {
    return {
      ok: false,
      status: 400,
      bodyExtra: { error: 'mesh_id required', path_kind: pathKind },
    };
  }
  const geometry = resolveProjectStep(projectId);
  if (!geometry.ok) {
    return {
      ok: false,
      status: 400,
      bodyExtra: {
        error: geometry.error,
        step_path: geometry.step_path || null,
        project_id: geometry.project_id || projectId || readActiveId(),
        path_kind: pathKind,
      },
    };
  }

  const generateId = stampId();
  const project_id = geometry.project_id;
  const meshDoc = project_id ? readMeshDoc(project_id) : null;
  const settings_snapshot = settings || (meshDoc && meshDoc.settings) || null;
  const fineness =
    settings_snapshot && settings_snapshot.fineness != null
      ? settings_snapshot.fineness
      : 5;
  const addLayers =
    !settings_snapshot || settings_snapshot.automatic_boundary_layers === undefined
      ? true
      : !!settings_snapshot.automatic_boundary_layers;
  const physicsBased =
    !settings_snapshot || settings_snapshot.physics_based_meshing === undefined
      ? true
      : !!settings_snapshot.physics_based_meshing;
  const hexCore = wantsHexCore(settings_snapshot);
  const adv = (settings_snapshot && settings_snapshot.advanced) || {};
  const smallFeature =
    adv.small_feature_suppression == null || String(adv.small_feature_suppression).trim() === ''
      ? 'auto'
      : String(adv.small_feature_suppression).trim();
  const gapFactor = Number.isFinite(Number(adv.gap_refinement_factor))
    ? Number(adv.gap_refinement_factor)
    : 0.05;
  const gradation = Number.isFinite(Number(adv.global_gradation_rate))
    ? Number(adv.global_gradation_rate)
    : 1.22;

  const wslDst = `cfddesk-cfdweb-${generateId}`;
  const winOut = join(PROJECTS_ROOT, project_id, 'mesh', `run-${generateId}`);
  mkdirSync(winOut, { recursive: true });
  const winLog = join(winOut, 'generate.log');
  const projectDir = join(PROJECTS_ROOT, project_id);

  let fingerprint_before = null;
  try {
    const prev =
      meshDoc &&
      meshDoc.live_mesh_result &&
      meshDoc.live_mesh_result.mesh_path &&
      existsSync(meshDoc.live_mesh_result.mesh_path)
        ? meshDoc.live_mesh_result.mesh_path
        : null;
    if (prev) fingerprint_before = fingerprintPolyMesh(prev);
  } catch {
    fingerprint_before = null;
  }

  const argv = [
    PYTHON,
    engine === 'cfmesh' ? CFMESH_GENERATE_SCRIPT : STANDARD_GENERATE_SCRIPT,
    '--project-dir',
    projectDir,
    '--case-dir',
    winOut,
    '--wsl-case',
    wslDst,
    '--generate-id',
    generateId,
    '--fineness',
    String(clampFineness(fineness)),
    '--add-layers',
    addLayers ? '1' : '0',
    '--physics-based',
    physicsBased ? '1' : '0',
  ];
  if (engine !== 'cfmesh') {
    argv.push(
      '--hex-core',
      hexCore ? '1' : '0',
      '--small-feature',
      smallFeature,
      '--gap-factor',
      String(gapFactor),
      '--gradation',
      String(gradation),
    );
  }
  const scopedMeshId = meshId || '';
  if (scopedMeshId) {
    argv.push('--mesh-id', String(scopedMeshId));
  }
  const command = argv.join(' ');
  const started_at = new Date().toISOString();
  const engineLabel = engine === 'cfmesh' ? 'cfMesh cartesianMesh' : 'Standard';

  let logBuf = '';
  let lastResult = null;
  const jobLog = createJobLogger('mesh', generateId);
  const child = spawn(argv[0], argv.slice(1), {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });
  liveJob = { child, generate_id: generateId, path_kind: pathKind, project_id, started_at, mesh_id: meshId || null };
  jobLog.info('spawn', { pid: child.pid || null, path_kind: pathKind, engine });

  const baseRunning = {
    status: 'running',
    mode: 'mesh',
    path_kind: pathKind,
    engine,
    generate_id: generateId,
    kick_id: generateId,
    pid: child.pid || null,
    exit_code: null,
    command,
    argv,
    started_at,
    finished_at: null,
    log_path: winLog,
    log_jsonl_path: jobLog.path,
    log_excerpt: '',
    wsl_case: wslCasePath(wslDst),
    case_dir: winOut,
    mesh_path: join(winOut, 'constant', 'polyMesh'),
    n_cells: null,
    n_points: null,
    n_faces: null,
    counts_source: null,
    emesh: null,
    feature_marks_total: null,
    fingerprint_before,
    fingerprint_after: null,
    project_id,
    settings_snapshot,
    fineness_used: fineness,
    add_layers_used: addLayers,
    geometry: {
      step_path: geometry.step_path,
      body1_path: geometry.body1_path,
      step_sha256: geometry.step_sha256,
      body1_sha256: geometry.body1_sha256,
      geometry_name: geometry.geometry_name,
      source: 'W16_project_STEP',
    },
    step_path: geometry.step_path,
    body1_path: geometry.body1_path,
    stage: 'starting',
    stage_detail: null,
    note: `${engineLabel} mesh on project STEP (fineness ${fineness}, hex core ${hexCore ? 'on' : 'off'}, layers ${addLayers ? 'on' : 'off'}).`,
    mesh_id: liveJob.mesh_id,
  };
  persistMeshResult(project_id, baseRunning);

  let lastStage = null;
  const appendLog = (chunk) => {
    const s = chunk.toString('utf8');
    logBuf += s;
    try {
      writeFileSync(winLog, logBuf, 'utf8');
    } catch {}
    for (const line of s.split(/\r?\n/)) {
      const parsed = parseCfmeshLine(line);
      if (!parsed) continue;
      if (parsed.kind === 'result') lastResult = parsed.data;
      if (parsed.kind === 'progress' && parsed.data && parsed.data.stage) {
        const stage = String(parsed.data.stage);
        const detail = parsed.data.msg ? String(parsed.data.msg) : null;
        if (stage !== lastStage || detail) {
          lastStage = stage;
          if (liveJob && liveJob.child === child) {
            const running = { ...baseRunning, stage, stage_detail: detail };
            try {
              persistMeshResult(project_id, running);
              onUpdate(running);
            } catch (_) {}
          }
        }
      }
    }
  };
  child.stdout?.on('data', appendLog);
  child.stderr?.on('data', appendLog);

  child.on('error', (err) => {
    logBuf += `\nSPAWN_ERROR: ${err}\n`;
    try {
      writeFileSync(winLog, logBuf, 'utf8');
    } catch {}
    liveJob = null;
    const failed = {
      ...baseRunning,
      status: 'failed',
      exit_code: -1,
      finished_at: new Date().toISOString(),
      log_excerpt: logBuf.slice(-2000),
      error: String(err),
      note: `${engineLabel} mesher failed to start: ${err}`,
    };
    persistMeshResult(project_id, failed);
    onUpdate(failed);
  });

  child.on('exit', (code, signal) => {
    const exit_code = code == null ? (signal ? -2 : -1) : code;
    const finished_at = new Date().toISOString();
    try {
      writeFileSync(winLog, logBuf, 'utf8');
    } catch {}
    const polyDir = join(winOut, 'constant', 'polyMesh');
    let counts = { n_cells: null, n_points: null, n_faces: null, source: null };
    let fingerprint_after = null;
    try {
      const countsJson = join(winOut, 'w21-counts.json');
      if (existsSync(countsJson)) {
        const j = JSON.parse(readFileSync(countsJson, 'utf8'));
        counts = {
          n_cells: j.n_cells ?? null,
          n_points: j.n_points ?? null,
          n_faces: j.n_faces ?? null,
          source: j.source || 'w21-counts.json',
        };
      } else if (existsSync(polyDir)) {
        const c = readPolyMeshCounts(polyDir);
        counts = {
          n_cells: c.n_cells,
          n_points: c.n_points,
          n_faces: c.n_faces,
          source: c.source,
        };
      }
      if (lastResult) {
        if (counts.n_cells == null) counts.n_cells = lastResult.n_cells ?? null;
        if (counts.n_points == null) counts.n_points = lastResult.n_points ?? null;
        if (counts.n_faces == null) counts.n_faces = lastResult.n_faces ?? null;
      }
      try {
        if (existsSync(polyDir)) fingerprint_after = fingerprintPolyMesh(polyDir);
      } catch (fpErr) {
        fingerprint_after = { error: String(fpErr), ...counts };
      }
    } catch (e) {
      logBuf += `\nCOUNT_PARSE_ERROR: ${e}\n`;
    }
    try {
      if (existsSync(polyDir)) prewarmMeshSurface(winOut);
    } catch (_) {}

    const scriptOk = lastResult && lastResult.ok === true;
    const ok =
      exit_code === 0 &&
      scriptOk &&
      counts.n_cells != null &&
      counts.n_points != null &&
      existsSync(join(polyDir, 'points'));

    liveJob = null;
    const terminal = {
      ...baseRunning,
      status: ok ? 'done' : 'failed',
      exit_code: ok ? 0 : exit_code === 0 && !ok ? 45 : exit_code,
      finished_at,
      log_excerpt: logBuf.slice(-4000),
      case_dir: winOut,
      mesh_path: polyDir,
      n_cells: counts.n_cells,
      n_points: counts.n_points,
      n_faces: counts.n_faces,
      counts_source: counts.source,
      fingerprint_after,
      script_result: lastResult,
      stage: ok ? 'done' : 'failed',
      stage_detail: null,
      error: ok ? null : (lastResult && lastResult.error) || `exit ${exit_code}`,
      hex_core_applied: lastResult && lastResult.hex_core != null ? !!lastResult.hex_core : hexCore,
      layers_applied: lastResult && lastResult.layers_applied != null ? !!lastResult.layers_applied : null,
      surface_size_m: (lastResult && lastResult.surface_size_m) || null,
      signal: signal || null,
      note: ok
        ? `${engineLabel} mesh done: ${counts.n_cells} cells, ${counts.n_points} points.`
        : `${engineLabel} mesh failed (exit ${exit_code}${lastResult && lastResult.error ? ': ' + lastResult.error : ''}).`,
    };
    persistMeshResult(project_id, terminal);
    onUpdate(terminal);
  });

  return {
    ok: true,
    status: 202,
    bodyExtra: { ...baseRunning },
  };
}

export function startMeshGenerate({ settings, projectId, onUpdate, meshId }) {
  if (liveJob && liveJob.child && !liveJob.child.killed && liveJob.child.exitCode === null) {
    return {
      ok: false,
      status: 409,
      bodyExtra: {
        error: 'mesh generate already running',
        pid: liveJob.child.pid || null,
        generate_id: liveJob.generate_id,
        path_kind: liveJob.path_kind || PATH_CFMESH,
        increment: INCREMENT,
      },
    };
  }

  const projectIdEarly = projectId || readActiveId();
  const meshDocEarly = projectIdEarly ? readMeshDoc(projectIdEarly) : null;
  const settingsEarly = settings || (meshDocEarly && meshDocEarly.settings) || null;
  if (wantsStandard(settingsEarly)) {
    return startStandardGenerate({
      settings: settingsEarly,
      projectId: projectIdEarly,
      onUpdate,
      engine: standardEngine(settingsEarly),
      meshId: meshId || null,
    });
  }
  if (!wantsHexDominant(settingsEarly)) {
    return {
      ok: false,
      status: 400,
      bodyExtra: {
        error: `Unknown mesh algorithm "${settingsEarly && settingsEarly.algorithm}".`,
        path_kind: null,
      },
    };
  }
  if (!meshId) {
    return {
      ok: false,
      status: 400,
      bodyExtra: { error: 'mesh_id required', path_kind: 'snappyHexMesh' },
    };
  }

  const stlReady = ensureBody1Stl(projectId);
  if (!stlReady.ok) {
    return {
      ok: false,
      status: 400,
      bodyExtra: {
        error: stlReady.error || 'could not tessellate STEP for mesh generate',
        detail: stlReady.detail || null,
        step_path: stlReady.step_path || null,
        project_id: stlReady.project_id || projectId || readActiveId(),
        path_kind: 'snappyHexMesh',
        mtp1_silent_copy: false,
        soft_pass_avoided: true,
        increment: INCREMENT,
      },
    };
  }

  const geometry = resolveProjectGeometry(projectId);
  if (!geometry.ok) {
    return {
      ok: false,
      status: 400,
      bodyExtra: {
        error: geometry.error,
        step_path: geometry.step_path || null,
        body1_path: geometry.body1_path || null,
        project_id: geometry.project_id || projectId || readActiveId(),
        path_kind: 'snappyHexMesh',
        mtp1_silent_copy: false,
        soft_pass_avoided: true,
        increment: INCREMENT,
      },
    };
  }

  const generateId = stampId();
  const project_id = geometry.project_id;
  const meshDoc = project_id ? readMeshDoc(project_id) : null;
  const settings_snapshot = settings || (meshDoc && meshDoc.settings) || null;
  const fineness =
    settings_snapshot && settings_snapshot.fineness != null ? settings_snapshot.fineness : 5;
  const addLayers =
    !settings_snapshot || settings_snapshot.automatic_boundary_layers === undefined
      ? true
      : !!settings_snapshot.automatic_boundary_layers;
  // Geometry bounds may be mm from W16 fingerprint; generate scales Body1 mm->m.
  let boundsM = null;
  if (geometry.bounds) {
    const b = geometry.bounds;
    const lookMm = Math.abs((b.xmax ?? b[1] ?? 0) - (b.xmin ?? b[0] ?? 0)) > 2;
    const s = lookMm ? 0.001 : 1;
    boundsM = {
      xmin: (b.xmin ?? b[0]) * s,
      xmax: (b.xmax ?? b[1]) * s,
      ymin: (b.ymin ?? b[2]) * s,
      ymax: (b.ymax ?? b[3]) * s,
      zmin: (b.zmin ?? b[4]) * s,
      zmax: (b.zmax ?? b[5]) * s,
    };
  }
  const { block, featureLevel, wallsLevel, snap, snappy_geometry_rev } = finenessParams(
    fineness,
    settings_snapshot,
    boundsM
  );

  const wslDst = wslCasePath(`cfddesk-w25-${generateId}`);
  mkdirSync(REPORT_DIR, { recursive: true });
  // W25b: put remesh under active project so SPA attach/mesh-inspect reads layered mesh
  const winOut = project_id
    ? join(PROJECTS_ROOT, project_id, 'mesh', `run-w25-${generateId}`)
    : join(REPORT_DIR, 'cases', `run-w25-${generateId}`);
  mkdirSync(winOut, { recursive: true });
  const winLog = join(REPORT_DIR, `generate-${generateId}.log`);
  const { shPath, wslSh } = writeGenerateScript({
    generateId,
    wslDst,
    winOut,
    wslWinOut: winToWsl(winOut),
    block,
    featureLevel,
    wallsLevel,
    addLayers,
    snap,
    geometry,
  });

  let fingerprint_before = null;
  try {
    const prev =
      meshDoc &&
      meshDoc.live_mesh_result &&
      meshDoc.live_mesh_result.mesh_path &&
      existsSync(meshDoc.live_mesh_result.mesh_path)
        ? meshDoc.live_mesh_result.mesh_path
        : null;
    if (prev) fingerprint_before = fingerprintPolyMesh(prev);
  } catch {
    fingerprint_before = null;
  }

  const argv = ['wsl', '-d', WSL_DISTRO, '--', 'bash', wslSh];
  const command = argv.join(' ');
  const started_at = new Date().toISOString();

  let logBuf = '';
  const jobLog = createJobLogger('mesh', generateId);
  const child = spawn(argv[0], argv.slice(1), {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  liveJob = { child, generate_id: generateId, path_kind: PATH_SNAPPY, project_id, started_at };
  jobLog.info('spawn', { pid: child.pid || null, path_kind: PATH_SNAPPY });

  const baseRunning = {
    status: 'running',
    mode: 'mesh',
    path_kind: 'snappyHexMesh',
    generate_id: generateId,
    kick_id: generateId,
    pid: child.pid || null,
    exit_code: null,
    command,
    argv,
    started_at,
    finished_at: null,
    log_path: winLog,
    log_jsonl_path: jobLog.path,
    log_excerpt: '',
    wsl_case: wslDst,
    wsl_script: wslSh,
    case_dir: winOut,
    mesh_path: join(winOut, 'constant', 'polyMesh'),
    n_cells: null,
    n_points: null,
    n_faces: null,
    counts_source: null,
    emesh: null,
    feature_marks_total: null,
    fingerprint_before,
    fingerprint_after: null,
    project_id,
    settings_snapshot,
    fineness_used: fineness,
    block_used: block,
    feature_level_used: featureLevel,
    walls_level_used: wallsLevel,
    add_layers_used: addLayers,
    snap_used: snap,
    snappy_geometry_rev,
    lift: {
      from: [
        'cfddesk/mesh/case_writer.py:_add_layers_controls_block',
        'cfddesk/mesh/snappy_policy.py:SNAPPY_GEOMETRY_REV=3',
        'cfddesk/project/mesh_sizing.py:physics_refinement_for_fineness',
        'cfddesk/mesh/feature_edges.py:cadFeatures.eMesh (via surfaceFeatureExtract)',
      ],
      automatic_boundary_layers: addLayers,
    },
    geometry: {
      step_path: geometry.step_path,
      body1_path: geometry.body1_path,
      step_sha256: geometry.step_sha256,
      body1_sha256: geometry.body1_sha256,
      geometry_name: geometry.geometry_name,
      source: 'W16_project_STEP_Body1',
    },
    step_path: geometry.step_path,
    body1_path: geometry.body1_path,
    mtp1_silent_copy: false,
    note:
      'W25: snappyHexMesh + lifted addLayers/snappy_policy on W16 STEP/Body1 (surfaceFeatureExtract->eMesh + blockMesh + snappy). NOT MTP1-silent-copy. NOT checkMesh. No invented cell counts. No solves.',
    no_fake_progress: true,
    soft_pass_avoided: true,
    increment: INCREMENT,
  };

  persistMeshResult(project_id, baseRunning);

  const appendLog = (chunk) => {
    const s = chunk.toString('utf8');
    logBuf += s;
    try {
      writeFileSync(winLog, logBuf, 'utf8');
    } catch {}
  };
  child.stdout?.on('data', appendLog);
  child.stderr?.on('data', appendLog);

  child.on('error', (err) => {
    logBuf += `\nSPAWN_ERROR: ${err}\n`;
    try {
      writeFileSync(winLog, logBuf, 'utf8');
    } catch {}
    liveJob = null;
    const failed = {
      ...baseRunning,
      status: 'failed',
      exit_code: -1,
      finished_at: new Date().toISOString(),
      log_excerpt: logBuf.slice(-2000),
      error: String(err),
      note: `W25: remesh failed to spawn: ${err}`,
    };
    persistMeshResult(project_id, failed);
    onUpdate(failed);
  });

  child.on('exit', (code, signal) => {
    const exit_code = code == null ? (signal ? -2 : -1) : code;
    const finished_at = new Date().toISOString();
    const excerpt = logBuf.slice(-4000);
    try {
      writeFileSync(winLog, logBuf, 'utf8');
    } catch {}

    const polyDir = join(winOut, 'constant', 'polyMesh');
    let counts = { n_cells: null, n_points: null, n_faces: null, source: null };
    let fingerprint_after = null;
    let emesh = null;
    let feature_marks_total = null;
    let geometry_meta = null;
    try {
      const countsJson = join(winOut, 'w21-counts.json');
      if (existsSync(countsJson)) {
        const j = JSON.parse(readFileSync(countsJson, 'utf8'));
        counts = {
          n_cells: j.n_cells ?? null,
          n_points: j.n_points ?? null,
          n_faces: j.n_faces ?? null,
          source: j.source || 'w21-counts.json',
        };
      } else if (existsSync(polyDir)) {
        const c = readPolyMeshCounts(polyDir);
        counts = {
          n_cells: c.n_cells,
          n_points: c.n_points,
          n_faces: c.n_faces,
          source: c.source,
        };
      }
      const emeshPath = join(winOut, 'constant', 'triSurface', 'cadFeatures.eMesh');
      emesh = readEmeshStats(emeshPath);
      const marksPath = join(winOut, 'w21-feature-marks.json');
      if (existsSync(marksPath)) {
        const m = JSON.parse(readFileSync(marksPath, 'utf8'));
        feature_marks_total = m.total ?? null;
      }
      const gmeta = join(winOut, 'w23-geometry-meta.json');
      if (existsSync(gmeta)) {
        geometry_meta = JSON.parse(readFileSync(gmeta, 'utf8'));
      }
      try {
        if (existsSync(polyDir)) fingerprint_after = fingerprintPolyMesh(polyDir);
      } catch (fpErr) {
        fingerprint_after = { error: String(fpErr), ...counts };
      }
    } catch (e) {
      logBuf += `\nCOUNT_PARSE_ERROR: ${e}\n`;
      try {
        writeFileSync(winLog, logBuf, 'utf8');
      } catch {}
    }

    try {
      if (existsSync(polyDir)) prewarmMeshSurface(winOut);
    } catch (_) {}
    try {
      writeFileSync(winLog, logBuf, 'utf8');
    } catch {}

    const banned = new Set([694700, 694712, 293400, 293412, 694700000]);
    const inventSuspect =
      counts.n_cells != null && banned.has(Number(counts.n_cells)) && !existsSync(polyDir);

    const body1InCase = join(winOut, 'constant', 'triSurface', 'Body1.stl');
    const wallsLeak = existsSync(join(winOut, 'constant', 'triSurface', 'walls.stl'));
    const usedProjectBody =
      existsSync(body1InCase) &&
      !wallsLeak &&
      geometry_meta &&
      geometry_meta.mtp1_silent_copy === false;

    const ok =
      exit_code === 0 &&
      counts.n_cells != null &&
      counts.n_points != null &&
      emesh &&
      emesh.present &&
      (emesh.n_edges || 0) > 0 &&
      !inventSuspect &&
      usedProjectBody;

    liveJob = null;
    const terminal = {
      ...baseRunning,
      status: ok ? 'done' : 'failed',
      exit_code: ok ? exit_code : exit_code === 0 && !ok ? 45 : exit_code,
      finished_at,
      log_excerpt: excerpt,
      case_dir: winOut,
      mesh_path: polyDir,
      n_cells: counts.n_cells,
      n_points: counts.n_points,
      n_faces: counts.n_faces,
      counts_source: counts.source,
      emesh,
      feature_marks_total,
      fingerprint_after,
      geometry_meta,
      signal: signal || null,
      note: ok
        ? `W25: snappyHexMesh+BL lift done (exit ${exit_code}). cells=${counts.n_cells} points=${counts.n_points}. addLayers=${addLayers}. step=${geometry.step_path}. NOT MTP1-silent-copy. NOT checkMesh.`
        : `W25: remesh failed (exit ${exit_code}${signal ? ' signal ' + signal : ''}${inventSuspect ? ' invented-counts-suspect' : ''}${!usedProjectBody ? ' geometry-not-project-Body1' : ''}). Honest fail.`,
      no_fake_progress: true,
      soft_pass_avoided: true,
      mtp1_silent_copy: false,
      increment: INCREMENT,
    };
    persistMeshResult(project_id, terminal);
    onUpdate(terminal);
  });

  return {
    ok: true,
    status: 202,
    bodyExtra: { ...baseRunning },
  };
}

export function meshGenerateLivePid() {
  if (liveJob && liveJob.child && liveJob.child.exitCode === null) {
    return liveJob.child.pid || null;
  }
  return null;
}

export function liveMeshJobSnapshot() {
  if (liveJob && liveJob.child && liveJob.child.exitCode === null) {
    return {
      pid: liveJob.child.pid || null,
      generate_id: liveJob.generate_id || null,
      path_kind: liveJob.path_kind || PATH_CFMESH,
      project_id: liveJob.project_id || null,
      started_at: liveJob.started_at || null,
    };
  }
  return null;
}

export const W21_META = {
  increment: INCREMENT,
  path_kind: 'snappyHexMesh',
  report_dir: REPORT_DIR,
  forbidden_path_kind: 'checkMesh',
  wsl_template_case: WSL_TEMPLATE_CASE,
  geometry_source: 'W16_project_STEP_Body1',
  mtp1_silent_copy: false,
};

export const W23_META = W21_META;
