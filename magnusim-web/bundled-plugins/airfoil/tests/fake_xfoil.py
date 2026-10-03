"""A stand-in for xfoil.exe in the tests: it reads the same command session from
standard input, keeps XFOIL's menus, and writes the files XFOIL writes (the
PACC polar, one CPWR file per ALFA) in XFOIL 6.99's layouts.

It is strict where the plugin must be right:

- graphics: any command that would draw (LOAD, OPER) before ``PLOP`` / ``G``
  turned the graphics off ends it with exit 3 and "a graphics window would open";
- an unknown command in a menu ends it with exit 4;
- the session the plugin must send: ``OPER`` before the section was re-panelled
  (``PANE`` after ``LOAD``), or an ``ALFA`` before ``VISC``, ``MACH`` and ``ITER``
  were set, ends it with exit 6 (XFOIL itself would run on its defaults: inviscid,
  Mach 0, 20 iterations, the file's own panels).

Behaviour from the environment:

- ``FAKE_XFOIL_FAIL``: a comma-separated list of α that do not converge
  ("VISCAL:  Convergence failed", no polar point);
- ``FAKE_XFOIL_HANG=1``: start a child process (its pid in ``FAKE_XFOIL_CHILD``,
  a file) and never answer, as a stuck XFOIL would;
- ``FAKE_XFOIL_DELAY``: seconds each ALFA takes;
- ``FAKE_XFOIL_LOG``: a file that gets every command line it read.

The numbers are a smooth made-up polar (not XFOIL's): Cl = 0.11 (α + 2.1),
Cd = 0.0060 + 0.00012 α², Cm = −0.053.
"""

from __future__ import annotations

import math
import os
import subprocess
import sys
import time

FAIL = {round(float(a), 3) for a in os.environ.get("FAKE_XFOIL_FAIL", "").split(",") if a.strip()}
DELAY = float(os.environ.get("FAKE_XFOIL_DELAY", "0") or 0)
LOG = os.environ.get("FAKE_XFOIL_LOG", "")


def log(line: str) -> None:
    if LOG:
        with open(LOG, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")


def read() -> str | None:
    line = sys.stdin.readline()
    if line == "":
        return None
    line = line.rstrip("\r\n")
    log(line)
    return line


def die(code: int, message: str) -> None:
    print(message, flush=True)
    sys.exit(code)


def main() -> None:
    print(" XFOIL Version 6.99 (stand-in)", flush=True)
    graphics = True
    state = {"re": 0.0, "mach": 0.0, "ncrit": 9.0, "xtr": (1.0, 1.0), "polar": "", "loaded": False, "paneled": False}
    told: set[str] = set()  # the OPER settings the session set
    alpha_now = None
    while True:
        cmd = read()
        if cmd is None:
            die(5, "stdin ended without QUIT")
        word = cmd.strip().upper()
        if word == "":
            continue
        if word == "PLOP":
            while True:
                sub = read()
                if sub is None:
                    die(5, "stdin ended in PLOP")
                if sub.strip() == "":
                    break
                if sub.strip().upper() == "G":
                    graphics = not graphics
                    print(f" Graphics enabled: {'T' if graphics else 'F'}", flush=True)
                else:
                    die(4, f"unknown PLOP command {sub!r}")
            continue
        if word.startswith("LOAD"):
            if graphics:
                die(3, "a graphics window would open (LOAD with graphics on)")
            name = cmd.split(None, 1)[1].strip()
            with open(name, encoding="ascii") as fh:
                lines = [ln for ln in fh.read().splitlines() if ln.strip()]
            print(f" Labeled airfoil file.  Name:  {lines[0].strip()}", flush=True)
            print(f" Number of input coordinate points: {len(lines) - 1}", flush=True)
            state["loaded"] = True
            state["paneled"] = False
            state["name"] = lines[0].strip()
            continue
        if word == "PANE":
            state["paneled"] = state["loaded"]
            continue
        if word == "QUIT":
            sys.exit(0)
        if word != "OPER":
            die(4, f"unknown top-level command {cmd!r}")
        if graphics:
            die(3, "a graphics window would open (OPER with graphics on)")
        if not state["paneled"]:
            die(6, "OPER before PANE: XFOIL would use the file's own panels")
        while True:
            sub = read()
            if sub is None:
                die(5, "stdin ended in OPER")
            parts = sub.split()
            if not parts:
                break
            key = parts[0].upper()
            if key in ("VISC", "MACH", "ITER"):
                told.add(key)
            if key == "VISC":
                state["re"] = float(parts[1])
            elif key == "MACH":
                state["mach"] = float(parts[1])
            elif key == "ITER":
                state["iter"] = int(parts[1])
            elif key == "VPAR":
                while True:
                    v = read()
                    if v is None:
                        die(5, "stdin ended in VPAR")
                    vp = v.split()
                    if not vp:
                        break
                    if vp[0].upper() == "N":
                        state["ncrit"] = float(vp[1])
                    elif vp[0].upper() == "XTR":
                        state["xtr"] = (float(vp[1]), float(vp[2]))
                    else:
                        die(4, f"unknown VPAR command {v!r}")
            elif key == "PACC":
                if state["polar"]:
                    state["polar"] = ""
                    print(" Polar accumulation disabled", flush=True)
                    continue
                fname = read() or ""
                read()  # dump file name (blank)
                state["polar"] = fname.strip()
                with open(state["polar"], "w", encoding="ascii") as fh:
                    fh.write(header(state))
            elif key == "ALFA":
                missing = [k for k in ("VISC", "MACH", "ITER") if k not in told]
                if missing:
                    die(6, f"ALFA before {', '.join(missing)}: XFOIL would run on its defaults")
                a = float(parts[1])
                alpha_now = a
                if os.environ.get("FAKE_XFOIL_HANG") == "1":
                    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
                    with open(os.environ["FAKE_XFOIL_CHILD"], "w", encoding="ascii") as fh:
                        fh.write(str(child.pid))
                    time.sleep(600)
                if DELAY:
                    time.sleep(DELAY)
                # Like XFOIL 6.99 on NACA 2412: the boundary-layer march says it failed at
                # a station while the α still converges; only VISCAL's line is a failed α.
                print(" MRCHDU: Convergence failed at  76  side 2    Res =  0.1121E+01", flush=True)
                print(f"  a = {a:7.3f}", flush=True)
                if round(a, 3) in FAIL:
                    print(" VISCAL:  Convergence failed", flush=True)
                    continue
                cl = 0.11 * (a + 2.1)
                cd = 0.0060 + 0.00012 * a * a
                if state["polar"]:
                    with open(state["polar"], "a", encoding="ascii") as fh:
                        fh.write(
                            f"  {a:6.3f}  {cl:7.4f}  {cd:8.5f}  {cd * 0.4:8.5f}  {-0.053:7.4f}"
                            f"  {0.6:7.4f}  {0.9:7.4f}\n"
                        )
            elif key == "CPWR":
                with open(parts[1], "w", encoding="ascii") as fh:
                    fh.write("#    x        Cp  \n")
                    for i in range(161):
                        x = 0.5 * (1 - math.cos(math.pi * i / 160))
                        fh.write(f"  {x:8.5f}  {-(alpha_now or 0) * 0.1 * (1 - x):9.5f}\n")
            elif key == "INIT":
                continue
            else:
                die(4, f"unknown OPER command {sub!r}")


def header(state: dict) -> str:
    re6 = state["re"] / 1e6
    return (
        " \n"
        "       XFOIL         Version 6.99\n"
        " \n"
        f" Calculated polar for: {state.get('name', '')}\n"
        " \n"
        " 1 1 Reynolds number fixed          Mach number fixed         \n"
        " \n"
        f" xtrf =   {state['xtr'][0]:.3f} (top)        {state['xtr'][1]:.3f} (bottom)  \n"
        f" Mach =   {state['mach']:.3f}     Re =     {re6:.3f} e 6     Ncrit =   {state['ncrit']:.3f}\n"
        " \n"
        "  alpha    CL        CD       CDp       CM     Top_Xtr  Bot_Xtr\n"
        " ------ -------- --------- --------- -------- -------- --------\n"
    )


if __name__ == "__main__":
    main()
