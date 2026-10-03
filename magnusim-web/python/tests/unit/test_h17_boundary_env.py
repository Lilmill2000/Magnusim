"""H17 host rule: code on a plugin's own environment may import what its lock pins;
import-by-name calls count as imports (tools/plugin_boundary.py)."""

from __future__ import annotations

import ast
import json
from pathlib import Path

import plugin_boundary
import pytest

from cfddesk.registry.plugin_env import lock_hash as host_lock_hash

WEB_ROOT = Path(__file__).resolve().parents[3]
HASH = "--hash=sha256:" + "0" * 64
LOCK = (
    "# a lock\n"
    f"scikit-learn==1.5.0 \\\n    {HASH}\n"
    f"python-dateutil==2.9.0.post0 {HASH}  # inline\n"
    f"gmsh==4.15.2 \\\n    {HASH}\n"
    f"AeroSandbox==4.2.10 {HASH}\n"
    "--require-hashes\n"
)
MANIFEST = 'key = "{key}"\n'
PYTHON_TABLE = '\n[python]\nrequirements = "requirements.lock"\nservice = "{key}_service"\n'
PLUGIN_PY = '''\
from pathlib import Path

from cfddesk.registry.jobs import JobKind

HERE = Path(__file__).resolve().parent


def register(hub):
    hub.register_job(JobKind("env_job", "jobs/env_job.py", "project", ("study_id",), python="plugin"), plugin="p", package_dir=HERE)
    hub.register_job(JobKind("core_job", "jobs/core_job.py", "project"), plugin="p", package_dir=HERE)
'''


def _write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _plugin(root: Path, key: str = "envp", *, python: bool = True, files: dict[str, str] | None = None) -> Path:
    d = root / key
    _write(d / "manifest.toml", MANIFEST.format(key=key) + (PYTHON_TABLE.format(key=key) if python else ""))
    _write(d / "requirements.lock", LOCK)
    _write(d / "plugin.py", PLUGIN_PY)
    for rel, text in (files or {}).items():
        _write(d / rel, text)
    return d


def _check(d: Path, web: Path | None = None) -> list[tuple[str, str, str]]:
    problems, _ = plugin_boundary.check_plugin(d, d.name, web_root=web or d.parent)
    return [(Path(str(p["file"])).relative_to(d).as_posix(), str(p["import"]), str(p["problem"])) for p in problems]


ENV_SIDE = {
    "envp_service.py": "import sklearn\nfrom dateutil import parser\nimport aerosandbox\n\nfrom envp_pkg import mesh\n",
    "envp_pkg/__init__.py": "",
    "envp_pkg/mesh.py": "import gmsh\nfrom sklearn.cluster import KMeans\n",
    "jobs/env_job.py": "import sys\n\nimport gmsh\n\nfrom envp_pkg import mesh\n",
}


def test_environment_code_imports_what_its_lock_pins(tmp_path: Path):
    d = _plugin(tmp_path, files=ENV_SIDE)
    assert _check(d) == []
    info: dict = {}
    plugin_boundary.check_plugin(d, d.name, web_root=tmp_path, info=info)
    assert info["environment_files"] == ["envp_pkg/__init__.py", "envp_pkg/mesh.py", "envp_service.py", "jobs/env_job.py"]
    assert info["names_from"] == "lock"
    # scikit-learn -> sklearn, python-dateutil -> dateutil (the static map), AeroSandbox normalized.
    assert {"sklearn", "dateutil", "gmsh", "aerosandbox"} <= set(info["lock_names"])


def test_without_a_python_table_nothing_is_environment_code(tmp_path: Path):
    d = _plugin(tmp_path, python=False, files=ENV_SIDE)
    found = {(f, i) for f, i, _ in _check(d)}
    assert ("envp_pkg/mesh.py", "gmsh") in found and ("envp_service.py", "sklearn") in found
    assert ("jobs/env_job.py", "gmsh") in found


@pytest.mark.parametrize(
    ("rel", "text"),
    [
        # The host loads plugin.py and what it imports.
        ("plugin.py", PLUGIN_PY + "\nimport gmsh\n"),
        # A module the service and plugin.py both import is host code.
        ("envp_pkg/shared.py", "import sklearn\n"),
        # A job tool on the core's Python.
        ("jobs/core_job.py", "import gmsh\n"),
        # Nothing on the environment imports it.
        ("tools/dev.py", "import gmsh\n"),
    ],
)
def test_host_code_still_may_not_import_the_locks_packages(tmp_path: Path, rel: str, text: str):
    files = {**ENV_SIDE, "jobs/core_job.py": "print('core')\n", rel: text}
    d = _plugin(tmp_path, files=files)
    if rel == "envp_pkg/shared.py":
        _write(d / "plugin.py", PLUGIN_PY + "\nfrom envp_pkg import shared\n")
        _write(d / "envp_service.py", ENV_SIDE["envp_service.py"] + "from envp_pkg import shared\n")
    found = _check(d)
    assert len(found) == 1, found
    file, mod, why = found[0]
    assert file == rel and mod in ("gmsh", "sklearn")
    assert "pinned in the plugin's lock" in why and "does not run only on the plugin's environment" in why


@pytest.mark.parametrize(
    "line",
    [
        "import requests",
        "import cfddesk.project.scope",
        "import importlib\nimportlib.import_module('cfddesk.project.scope')",
        "__import__('requests')",
    ],
)
def test_environment_code_still_may_not_import_what_its_lock_does_not_pin(tmp_path: Path, line: str):
    d = _plugin(tmp_path, files={**ENV_SIDE, "envp_service.py": ENV_SIDE["envp_service.py"] + line + "\n"})
    found = _check(d)
    assert [(f, i) for f, i, _ in found] == [("envp_service.py", line.split("'")[1] if "'" in line else line.split()[1])]
    assert "the packages its lock pins" in found[0][2]


def test_a_lock_never_provides_the_hosts_own_package(tmp_path: Path):
    d = _plugin(tmp_path, files={"envp_service.py": "import cfddesk.project.scope\n"})
    _write(d / "requirements.lock", f"cfddesk==1.0 {HASH}\n")
    assert [i for _, i, _ in _check(d)] == ["cfddesk.project.scope"]


@pytest.mark.parametrize(
    ("code", "mod"),
    [
        ("import importlib\n\nimportlib.import_module('cfddesk.project.scope')\n", "cfddesk.project.scope"),
        ("import importlib as il\n\nil.import_module('requests')\n", "requests"),
        ("from importlib import import_module as im\n\nim('requests.adapters')\n", "requests.adapters"),
        ("__import__('requests')\n", "requests"),
        ("import builtins\n\nbuiltins.__import__('requests')\n", "requests"),
        ("from builtins import __import__ as imp\n\nimp('requests')\n", "requests"),
        ("import importlib\n\nimportlib.__import__('requests')\n", "requests"),
        ("import importlib\n\nloader = importlib\nloader.import_module(name='requests')\n", "requests"),
        ("import importlib\n\nimportlib.import_module('gm' + 'sh')\n", "gmsh"),
        ("import importlib\n\nimportlib.import_module(f'requests')\n", "requests"),
        ("import importlib\n\n\ndef later():\n    return importlib.import_module('cfddesk.project')\n", "cfddesk.project"),
    ],
)
def test_import_by_name_is_an_import(tmp_path: Path, code: str, mod: str):
    """gate: a fixture plugin doing importlib.import_module("cfddesk.project.scope") fails."""
    d = _plugin(tmp_path, python=False, files={"plugin_extra.py": code})
    found = [(f, i) for f, i, _ in _check(d)]
    assert found == [("plugin_extra.py", mod)], found


@pytest.mark.parametrize(
    "code",
    [
        "import importlib\n\nNAME = 'cfddesk.project.scope'\nimportlib.import_module(NAME)\n",
        "def load(name):\n    return __import__(name)\n",
        "import importlib\n\nimportlib.import_module(f'cfddesk.{\"project\"}' if True else '')\n",
    ],
)
def test_import_by_a_name_the_check_cannot_read_is_a_problem(tmp_path: Path, code: str):
    for python in (False, True):  # on the environment too: no way around the check
        others = ENV_SIDE if python else {"envp_pkg/__init__.py": ""}
        d = _plugin(tmp_path / str(python), python=python, files={**others, "envp_pkg/mesh.py": code})
        found = _check(d)
        assert len(found) == 1 and found[0][0] == "envp_pkg/mesh.py", found
        assert "a module name the check cannot read" in found[0][2]


def test_import_by_name_of_the_plugins_own_and_relative_modules_is_fine(tmp_path: Path):
    code = (
        "import importlib\n\nimportlib.import_module('envp_pkg.mesh')\n"
        "importlib.import_module('.mesh', __package__)\nimportlib.import_module('json')\n"
    )
    d = _plugin(tmp_path, files={**ENV_SIDE, "envp_pkg/__init__.py": code})
    assert _check(d) == []


def test_import_by_name_reaches_environment_code(tmp_path: Path):
    # The service loads its module by name: that module is environment code too.
    files = {
        **ENV_SIDE,
        "envp_service.py": "import importlib\n\nmesh = importlib.import_module('envp_pkg.mesh')\n",
        "jobs/env_job.py": "print('job')\n",
    }
    d = _plugin(tmp_path, files=files)
    assert _check(d) == []


def test_the_core_importing_a_bundled_plugin_by_name(tmp_path: Path):
    core = tmp_path / "cfddesk"
    _write(core / "a.py", "import importlib\n\nimportlib.import_module('airfoil.neural')\n")
    _write(core / "b.py", "import importlib\n\n\ndef load(key):\n    return importlib.import_module(key)\n")
    found = plugin_boundary.check_core([core], {"airfoil"})
    assert [(Path(str(p["file"])).name, p["import"]) for p in found] == [("a.py", "airfoil.neural")]


# -- import names of the lock's distributions ---------------------------------------------


def test_lock_distributions_reads_pins_as_pip_does():
    assert plugin_boundary.lock_distributions(LOCK) == ["scikit-learn", "python-dateutil", "gmsh", "AeroSandbox"]
    text = "# c\nsix[extra] == 1.17.0 \\\n  --hash=sha256:00\n-r other.txt\nfoo==1 ; python_version<'4'\n"
    assert plugin_boundary.lock_distributions(text) == ["six", "foo"]


def test_lock_hash_is_the_hosts(tmp_path: Path):
    lock = _write(tmp_path / "requirements.lock", "a==1\r\nb==2\n")
    lock.write_bytes(b"a==1\r\nb==2\n")
    assert plugin_boundary.lock_hash(lock) == host_lock_hash(lock)


def _dist_info(site: Path, name: str, top_level: str | None, record: list[str]) -> None:
    info = site / f"{name}.dist-info"
    info.mkdir(parents=True)
    if top_level is not None:
        (info / "top_level.txt").write_text(top_level, encoding="utf-8")
    (info / "RECORD").write_text("".join(f"{r},sha256=x,1\n" for r in record), encoding="utf-8")


def _site(tmp_path: Path) -> Path:
    site = tmp_path / "site-packages"
    _dist_info(site, "gmsh-4.15.2", "\n", ["gmsh.py", "__pycache__/gmsh.cpython-310.pyc", "../../Scripts/gmsh.exe", "gmsh-4.15.2.dist-info/RECORD"])
    _dist_info(site, "python_dateutil-2.9.0.post0", "dateutil\n", ["dateutil/__init__.py", "dateutil/parser/_parser.py"])
    _dist_info(site, "scikit_learn-1.5.0", None, ['"sklearn/__init__.py"', "scikit_learn.libs/vcomp.dll", "sklearn/_x.cp310-win_amd64.pyd"])
    _dist_info(site, "matplotlib-3.10.9", "", ["matplotlib/__init__.py", "mpl_toolkits/axes_grid1/__init__.py", "pylab.py", "dummy.txt"])
    _dist_info(site, "fast-1.0", "", ["_fast.cp310-win_amd64.pyd", "fast.pth"])
    return site


def test_installed_import_names_from_top_level_and_record(tmp_path: Path):
    names = plugin_boundary.installed_import_names(_site(tmp_path))
    assert names["gmsh"] == {"gmsh"}
    assert names["python-dateutil"] == {"dateutil"}
    assert names["scikit-learn"] == {"sklearn"}
    assert names["matplotlib"] == {"matplotlib", "mpl_toolkits", "pylab"}
    assert names["fast"] == {"_fast"}


@pytest.mark.parametrize("layout", ["Lib/site-packages", "lib/python3.12/site-packages"])
def test_the_built_environment_names_what_it_installed(tmp_path: Path, layout: str, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("MAGNUSIM_PLUGIN_ENVS_DIR", raising=False)
    web = tmp_path / "web"
    # A distribution whose import name nothing static knows: only the environment can say.
    lock_text = f"oddly-named==1.0 {HASH}\n"
    d = _plugin(web / "bundled-plugins", files={"envp_service.py": "import odd_inside\n"})
    (d / "requirements.lock").write_text(lock_text, encoding="utf-8")
    assert [i for _, i, _ in _check(d, web)] == ["odd_inside"]
    env = web / ".cache" / "plugin-envs" / f"envp-{plugin_boundary.lock_hash(d / 'requirements.lock')}"
    _dist_info(env / layout, "oddly_named-1.0", None, ["odd_inside/__init__.py"])
    (env / "magnusim-env.json").write_text(json.dumps({"lock_hash": "0" * 16}), encoding="utf-8")
    assert [i for _, i, _ in _check(d, web)] == ["odd_inside"], "an environment built for another lock says nothing"
    (env / "magnusim-env.json").write_text(json.dumps({"lock_hash": plugin_boundary.lock_hash(d / "requirements.lock")}), encoding="utf-8")
    assert _check(d, web) == []
    info: dict = {}
    plugin_boundary.check_plugin(d, "envp", web_root=web, info=info)
    assert info["names_from"] == "installed"
    # MAGNUSIM_PLUGIN_ENVS_DIR moves the folder, as it does for the host.
    monkeypatch.setenv("MAGNUSIM_PLUGIN_ENVS_DIR", str(tmp_path / "elsewhere"))
    assert [i for _, i, _ in _check(d, web)] == ["odd_inside"]


# -- the Airfoil plugin --------------------------------------------------------------------


AIRFOIL = WEB_ROOT / "bundled-plugins" / "airfoil"


@pytest.mark.skipif(not AIRFOIL.is_dir(), reason="the Airfoil plugin is not in this checkout")
def test_airfoil_imports_its_engines_plainly_on_its_environment():
    """No import-by-name workaround is left: NeuralFoil, AeroSandbox, NumPy and Gmsh are
    imported with import statements, in files the check holds to the environment rule."""
    files, _skipped, _bytecode = plugin_boundary.plugin_files(AIRFOIL)
    dynamic = []
    for py in files:
        for mod, _top, line, _level, _names, how, _unread in plugin_boundary._imports(py):
            if how:
                dynamic.append(f"{py.relative_to(AIRFOIL).as_posix()}:{line} {how}({mod!r})")
    assert dynamic == []
    info: dict = {}
    problems, _ = plugin_boundary.check_plugin(AIRFOIL, "airfoil", web_root=WEB_ROOT, info=info)
    assert problems == []
    env = set(info["environment_files"])
    assert {"airfoil_service.py", "jobs/openfoam_2d.py", "jobs/xfoil_polar.py", "airfoil/neural.py"} <= env
    assert "plugin.py" not in env and "tools/make_xfoil_golden.py" not in env
    imported = {
        alias.name
        for py in (AIRFOIL / "airfoil" / "neural.py", AIRFOIL / "jobs" / "openfoam_2d.py")
        for node in ast.walk(ast.parse(py.read_text(encoding="utf-8")))
        if isinstance(node, ast.Import)
        for alias in node.names
    }
    assert {"numpy", "aerosandbox", "neuralfoil", "gmsh"} <= imported


def test_the_static_map_names_its_keys_normalized():
    for dist in plugin_boundary.IMPORT_NAMES:
        assert plugin_boundary.normalize_dist(dist) == dist


# -- review round 3: relative names, host entry points, job placement, aliases -------------


def _found(d: Path) -> list[tuple[str, str]]:
    return [(f, i) for f, i, _ in _check(d)]


@pytest.mark.parametrize(
    ("code", "mod"),
    [
        # import_module resolves a relative name against its package argument.
        ("import importlib\n\nimportlib.import_module('.project.scope', 'cfddesk')\n", "cfddesk.project.scope"),
        ("import importlib\n\nimportlib.import_module('..project.scope', package='cfddesk.registry')\n", "cfddesk.project.scope"),
        ("import importlib\n\nimportlib.import_module('.', 'cfddesk.project.scope')\n", "cfddesk.project.scope"),
        # A package of the lock's: gmsh is imported before gmsh.gmsh is looked up.
        ("import importlib\n\nimportlib.import_module('.gmsh', 'gmsh')\n", "gmsh.gmsh"),
    ],
)
def test_a_relative_name_is_read_against_its_package(tmp_path: Path, code: str, mod: str):
    d = _plugin(tmp_path, files={"plugin.py": PLUGIN_PY + "\n" + code})
    assert _found(d) == [("plugin.py", mod)]


@pytest.mark.parametrize(
    "code",
    [
        # __package__ taken from globals the code writes itself.
        "__import__('project.scope', {'__package__': 'cfddesk'}, None, ['scope'], 1)\n",
        "G = {'__package__': 'cfddesk'}\n__import__('project.scope', G, None, ['scope'], 1)\n",
        # A package the check cannot read, or none at all.
        "import importlib\n\nPKG = 'cfddesk'\nimportlib.import_module('.project.scope', PKG)\n",
        "import importlib\n\nimportlib.import_module('.project.scope')\n",
        # A level the check cannot read.
        "LEVEL = 1\n__import__('project.scope', globals(), None, ['scope'], LEVEL)\n",
        # A fromlist the check cannot read: its names may be submodules.
        "NAMES = ['tests']\n__import__('envp_pkg', globals(), None, NAMES)\n",
    ],
)
def test_a_relative_name_the_check_cannot_resolve_is_a_problem(tmp_path: Path, code: str):
    d = _plugin(tmp_path, python=False, files={"envp_pkg/__init__.py": "", "envp_pkg/mesh.py": code})
    found = _check(d)
    assert len(found) == 1 and found[0][0] == "envp_pkg/mesh.py", found
    assert "cannot read" in found[0][2]


@pytest.mark.parametrize(
    ("code", "shown"),
    [
        # plugin.py runs as cfddesk._bundled.<folder>: .. is the core's package.
        ("from ..project import scope\n", "..project"),
        ("from .. import project\n", "..project"),
        # . is cfddesk._bundled: another plugin's plugin.py.
        ("from . import other_plugin\n", ".other_plugin"),
        ("__import__('project', globals(), None, ['scope'], 2)\n", "..project"),
        ("import importlib\n\nimportlib.import_module('.mesh', __package__)\n", ".mesh"),
        ("import importlib\n\nimportlib.import_module('.', __package__)\n", "."),
    ],
)
def test_a_relative_import_in_plugin_py_reaches_the_core(tmp_path: Path, code: str, shown: str):
    d = _plugin(tmp_path, python=False, files={"plugin.py": code + PLUGIN_PY, "mesh.py": "", "project/__init__.py": ""})
    found = _check(d)
    assert [(f, i) for f, i, _ in found] == [("plugin.py", shown)], found
    assert "cfddesk._bundled" in found[0][2]


@pytest.mark.parametrize(
    ("rel", "code", "bad"),
    [
        ("envp_pkg/mesh.py", "from .. import other\n", True),
        ("envp_pkg/mesh.py", "from ...project import scope\n", True),
        ("helper.py", "from . import other\n", True),
        ("envp_pkg/mesh.py", "__import__('other', globals(), None, [], 2)\n", True),
        # Inside the plugin's packages: its own modules.
        ("envp_pkg/sub/deep.py", "from .. import mesh\nfrom . import sibling\n", False),
        ("envp_pkg/mesh.py", "import importlib\n\nimportlib.import_module('.sub.sibling', __package__)\n", False),
    ],
)
def test_a_relative_import_that_climbs_out_of_the_plugin_is_a_problem(tmp_path: Path, rel: str, code: str, bad: bool):
    files = {"envp_pkg/__init__.py": "", "envp_pkg/sub/__init__.py": "", "envp_pkg/sub/sibling.py": "", "other.py": "", rel: code}
    found = _check(_plugin(tmp_path, python=False, files=files))
    if not bad:
        assert found == []
        return
    assert len(found) == 1 and found[0][0] == rel, found
    assert "above the plugin's top-level package" in found[0][2]


LOG_PARSER_PLUGIN = '''\
from pathlib import Path

from cfddesk.registry.contract import LogParserRef

NAME = "parser"
HERE = Path(__file__).resolve().parent
LOG_PARSER = {ref}


def register(hub):
    return None
'''


@pytest.mark.parametrize(
    ("ref", "flagged"),
    [
        # The core imports a log parser by its module name, on the core's Python.
        ('LogParserRef("lp.parser", "Parser", str(HERE))', [("lp/parser.py", "gmsh")]),
        ('LogParserRef(module="lp.parser", factory="Parser", path=str(HERE))', [("lp/parser.py", "gmsh")]),
        # Named from a folder of the plugin's: still the same file.
        ('LogParserRef("parser", "Parser", str(HERE / "lp"))', [("lp/parser.py", "gmsh")]),
        # A module name the check cannot read: no file is environment code.
        ('LogParserRef("lp." + NAME, "Parser", str(HERE))', [("log_parser_service.py", "sklearn"), ("lp/parser.py", "gmsh")]),
    ],
)
def test_a_log_parser_runs_on_the_cores_python(tmp_path: Path, ref: str, flagged: list):
    files = {
        "plugin.py": LOG_PARSER_PLUGIN.format(ref=ref),
        "lp/__init__.py": "",
        "lp/parser.py": "import gmsh\n\n\nclass Parser:\n    def feed(self, line):\n        return []\n",
        "log_parser_service.py": "import sklearn\n\nimport lp.parser\n",
    }
    d = _plugin(tmp_path, key="log_parser", files=files)
    assert sorted(_found(d)) == flagged


def test_a_log_parser_replaced_by_a_name_the_check_cannot_read(tmp_path: Path):
    plugin = LOG_PARSER_PLUGIN.format(ref='LogParserRef("lp.other", "Parser", str(HERE))') + (
        "\nimport dataclasses\n\nLOG_PARSER = dataclasses.replace(LOG_PARSER, module='lp.' + NAME)\n"
    )
    files = {"plugin.py": plugin, "lp/__init__.py": "", "lp/parser.py": "import gmsh\n", "log_parser_service.py": "import lp.parser\n"}
    d = _plugin(tmp_path, key="log_parser", files=files)
    assert _found(d) == [("lp/parser.py", "gmsh")]


@pytest.mark.parametrize(
    ("init", "host"),
    [
        ('__all__ = ["heavy"]\n', True),
        ('__all__ = ("heavy", "light")\n', True),
        # __all__ the check cannot read: every submodule counts.
        ('__all__ = [n for n in ("heavy",)]\n', True),
        ('__all__ = ["light"]\n__all__ += ["heavy"]\n', True),
        # Not in __all__: a star import does not load it.
        ('__all__ = ["light"]\n', False),
    ],
)
def test_a_star_import_in_host_code_loads_the_packages_submodules(tmp_path: Path, init: str, host: bool):
    files = {
        "plugin.py": PLUGIN_PY + "\nfrom pkg import *\n",
        "pkg/__init__.py": init,
        "pkg/heavy.py": "import gmsh\n",
        "pkg/light.py": "",
        "envp_service.py": "import pkg.heavy\n",
    }
    d = _plugin(tmp_path, files=files)
    assert _found(d) == ([("pkg/heavy.py", "gmsh")] if host else [])


def test_a_star_import_of_a_folder_the_check_skips(tmp_path: Path):
    files = {"pkg/__init__.py": '__all__ = ["tests"]\n', "pkg/tests/__init__.py": "import requests\n", "helper.py": "from pkg import *\n"}
    found = _check(_plugin(tmp_path, python=False, files=files))
    assert [(f, i) for f, i, _ in found] == [("helper.py", "pkg.tests")], found
    assert "does not read" in found[0][2]


@pytest.mark.parametrize(
    "register",
    [
        # dataclasses.replace puts the job back on the core's Python.
        'hub.register_job(dataclasses.replace(JobKind("k", "jobs/run.py", "project", (), python="plugin"), python="core"), plugin="p")',
        'job = JobKind("k", "jobs/run.py", "project", (), python="plugin")\n    hub.register_job(dataclasses.replace(job, python="core"), plugin="p")',
        # A decoy literal next to the real registration, whose tool is a variable.
        'JobKind("decoy", "jobs/run.py", "project", (), python="plugin")\n    hub.register_job(JobKind("real", TOOL, "project", ()), plugin="p")',
        # The class under another name, or a registration the check cannot follow.
        'K = JobKind\n    hub.register_job(K("k", "jobs/run.py", "project", ()), plugin="p")',
        'for job in JOBS:\n        hub.register_job(job, plugin="p")',
        'getattr(hub, "register_job")(JobKind("k", "jobs/run.py", "project", ()), plugin="p")',
        'hub.register_job(JobKind("k", "jobs/run.py", "project", (), python=RUNTIME), plugin="p")',
        # A decoy literal next to a registration through the job registry, which the check does not place.
        'JobKind("decoy", "jobs/run.py", "project", (), python="plugin")\n'
        '    hub.registry("job").register(JobKind("real", "jobs/run.py", "project", ()), plugin="p")',
        # Registered through the job registry, by an alias the file binds itself.
        'K = JobKind\n    hub.registry("job").register(K("k", "jobs/run.py", "project", ()), plugin="p")',
        # The method looked up by name; a job rebuilt from another one; a registered job changed.
        'getattr(hub, "register_job")(SPEC, plugin="p")',
        'hub.registry("job").register(dataclasses.replace(SPEC, tool="jobs/run.py"), plugin="p")',
        'hub.register_job(JobKind("k", "jobs/run.py", "project", (), python="plugin"), plugin="p")\n'
        '    object.__setattr__(SPEC, "python", "core")',
    ],
)
def test_jobs_the_check_cannot_place_leave_no_environment_code(tmp_path: Path, register: str):
    plugin = (
        "import dataclasses\n\nfrom cfddesk.registry.jobs import JobKind\n\nTOOL = 'jobs/run.py'\nRUNTIME = 'core'\n"
        "JOBS = []\nSPEC = None\n\n\ndef register(hub):\n    " + register + "\n"
    )
    files = {
        "plugin.py": plugin,
        "jobs/__init__.py": "",
        "jobs/run.py": "import gmsh\n",
        "envp_service.py": "import sklearn\n\nfrom jobs import run\n",
    }
    d = _plugin(tmp_path, files=files)
    info: dict = {}
    problems, _ = plugin_boundary.check_plugin(d, d.name, web_root=tmp_path, info=info)
    assert sorted((Path(str(p["file"])).relative_to(d).as_posix(), p["import"]) for p in problems) == [
        ("envp_service.py", "sklearn"),
        ("jobs/run.py", "gmsh"),
    ]
    assert info["environment_files"] == [] and info["unplaced"], info
    assert all("cannot place" in str(p["problem"]) for p in problems), problems


def test_a_core_job_tool_is_every_file_its_path_can_name(tmp_path: Path):
    # register_job resolves the tool from its package_dir, which the check does not read.
    plugin = (
        "from pathlib import Path\n\nfrom cfddesk.registry.jobs import JobKind\n\n\ndef register(hub):\n"
        '    hub.register_job(JobKind("k", "jobs/run.py", "project", ()), plugin="p", '
        'package_dir=Path(__file__).resolve().parent / "sub")\n'
    )
    files = {
        "plugin.py": plugin,
        "sub/__init__.py": "",
        "sub/jobs/__init__.py": "",
        "sub/jobs/run.py": "import gmsh\n",
        "envp_service.py": "import sub.jobs.run\n",
    }
    assert _found(_plugin(tmp_path, files=files)) == [("sub/jobs/run.py", "gmsh")]


@pytest.mark.parametrize(
    ("code", "mod"),
    [
        # importlib.__all__ holds import_module and __import__.
        ("from importlib import *\n\nimport_module('cfddesk.project.scope')\n", "cfddesk.project.scope"),
        ("from importlib import *\n\n__import__('requests')\n", "requests"),
        ("from builtins import *\n\n__import__('requests')\n", "requests"),
    ],
)
def test_a_star_import_of_importlib_binds_its_import_functions(tmp_path: Path, code: str, mod: str):
    d = _plugin(tmp_path, python=False, files={"plugin_extra.py": code})
    assert _found(d) == [("plugin_extra.py", mod)]


@pytest.mark.parametrize(
    "code",
    [
        "import importlib\n\nim = importlib.import_module\nim('cfddesk.project.scope')\n",
        "import importlib\n\nload = importlib.__import__\n",
        "import builtins\n\nload = builtins.__import__\n",
        "from importlib import import_module\n\nLOADERS = [import_module]\n",
        "load = __import__\n",
        "import importlib\n\ngetattr(importlib, 'import_module')('cfddesk.project.scope')\n",
        "import functools\nimport importlib\n\nload = functools.partial(importlib.import_module, 'cfddesk.project.scope')\n",
        # Code run from a string or a file the check does not follow.
        "exec('import cfddesk.project.scope')\n",
        "eval(\"__import__('cfddesk.project.scope')\")\n",
        "import builtins\n\nbuiltins.exec('import cfddesk')\n",
        "code = compile('import cfddesk', 'x', 'exec')\n",
        "import runpy\n\nrunpy.run_module('cfddesk.project.scope')\n",
        "from runpy import run_path as rp\n\nrp('x.py')\n",
        "import importlib.util\n\nspec = importlib.util.spec_from_file_location('m', 'x.py')\nmod = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(mod)\n",
    ],
)
def test_an_import_the_check_cannot_follow_is_a_problem(tmp_path: Path, code: str):
    for python in (False, True):  # on the environment too
        others = ENV_SIDE if python else {"envp_pkg/__init__.py": ""}
        d = _plugin(tmp_path / str(python), python=python, files={**others, "envp_pkg/mesh.py": code})
        found = _check(d)
        assert len(found) == 1 and found[0][0] == "envp_pkg/mesh.py", found
        assert "cannot read" in found[0][2], found


def test_code_that_only_looks_like_an_import_function_is_fine(tmp_path: Path):
    code = (
        "import ast\nimport re\n\nPATTERN = re.compile('x')\nVALUE = ast.literal_eval('1')\n"
        "NAME = 'import_module'\n\n\ndef compile_case(x):\n    return x\n\n\ncompile_case(1)\n"
    )
    d = _plugin(tmp_path, python=False, files={"envp_pkg/__init__.py": "", "envp_pkg/mesh.py": code})
    assert _check(d) == []
