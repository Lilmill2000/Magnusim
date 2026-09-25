"""H2 host: jobs.describe, plugin.dispatch, and ToolKind from filters."""

from __future__ import annotations

import json
from pathlib import Path

from cfddesk.registry.discovery import load_all, reset_for_tests
from cfddesk.worker.methods import filter_validate, jobs_describe, plugin_dispatch
from cfddesk.worker.rpc import RpcError


def _plugin(root: Path) -> None:
    folder = root / "plugins" / "h2probe"
    folder.mkdir(parents=True)
    (folder / "manifest.toml").write_text(
        'key = "h2probe"\nname = "H2 probe"\nversion = "0.0.1"\napi_version = "1.0"\n',
        encoding="utf-8",
    )
    (folder / "echo_job.py").write_text("print('ok')\n", encoding="utf-8")
    (folder / "plugin.py").write_text(
        "\n".join(
            [
                "from pathlib import Path",
                "from cfddesk.registry.jobs import JobKind",
                "from cfddesk.registry.result_filter import ResultFilterType",
                "from cfddesk.registry.schema import SchemaField",
                "ROOT = Path(__file__).resolve().parent",
                "def register(hub):",
                "    hub.register_job(",
                "        JobKind(key='h2probe', tool='echo_job.py', scope='project', args_from_params=('project_id',)),",
                "        plugin='h2probe',",
                "        package_dir=ROOT,",
                "    )",
                "    hub.registry('filter').register(",
                "        ResultFilterType(",
                "            key='h2probe',",
                "            label='H2 probe',",
                "            params_schema=(SchemaField('project_id', 'Project', 'text', default=''),),",
                "            tool='echo_job.py',",
                "            cache_scope='case',",
                "            output='json',",
                "            args_from_params=('project_id',),",
                "        ),",
                "        plugin='h2probe',",
                "    )",
                "    hub.register_method('h2probe', 'ping', lambda params, scope: {'ok': True, 'scope': scope})",
            ]
        ),
        encoding="utf-8",
    )


def test_gate_h2_jobs_and_tools(tmp_path: Path) -> None:
    reset_for_tests()
    try:
        _plugin(tmp_path)
        hub = load_all(web_root=tmp_path)
        tool = hub.registry("tool").get("h2probe")
        assert tool.tool == "echo_job.py"
        assert tool.args_from_params == ("project_id",)
        assert hub.registry("tool").owner("h2probe") == "h2probe"
        described = jobs_describe("h2probe")
        assert described["job"]["plugin"] == "h2probe"
        assert described["job"]["tool_path"].endswith("echo_job.py")
        validated = filter_validate("h2probe", {"project_id": "p1"})
        assert validated["plugin"] == "h2probe"
        assert validated["args_from_params"] == ["project_id"]
        ping = plugin_dispatch("h2probe", "ping", {}, {"project_id": "p1"})
        assert ping["scope"]["project_id"] == "p1"
        try:
            jobs_describe("missing-kind")
        except RpcError as exc:
            assert exc.code == -32602
        else:
            raise AssertionError("unknown kind should be an RPC error")
        dumped = json.dumps(described)
        assert "h2probe" in dumped
    finally:
        reset_for_tests()
