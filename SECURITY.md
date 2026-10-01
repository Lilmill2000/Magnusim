# Security and hosting

Magnusim currently runs as a trusted local application. Its API can read local
CAD files, write simulation projects, and start Python/WSL jobs with the server
user's permissions. It has no built-in account authentication or per-user
authorization. Bind it to loopback (the default).

For remote access, use an authenticated reverse proxy that preserves the
original Host header, restrict access to trusted users, and explicitly set
`MAGNUSIM_ALLOWED_HOSTS` to the comma-separated hostnames you serve. Host and
browser-origin validation are not authentication. Do not expose the raw Vite
server or unrestricted API as a public multi-user service.

## Plugins

A plugin is trusted code. Its Python runs with the same permissions as
Magnusim, and its page code runs inside the app. Install only plugins you trust,
the same as any program. Isolation between plugins and the core (separate worker
process, per-plugin data, disabling a plugin) protects Magnusim from plugin bugs
and crashes; it is not a defence against a deliberately malicious plugin.

Turning plugins on or off and reloading them changes what code the app runs, so
those requests are accepted only from a browser on the same PC talking to
Magnusim directly (a loopback Host and no `X-Forwarded-*` headers). Through a
reverse proxy or the public tunnel they answer 403 "Plugin management is only
available on this PC." Installing or removing a plugin's dependencies (its own
environment) is managed the same way.

An optional plugin that ships with the app turned off (`default_enabled =
false`) is inert until someone on this PC turns it on. Only its manifest is read:
its code is not imported, its page files are not served, and its environment is
not built. Only the Python worker writes the list of plugins turned on or off;
the rest of the app never writes it.

A plugin's own environment keeps its packages apart from the app's (pinned and
hashed lock, wheels only, the app's packages untouched). It separates
dependencies, not permissions: its service and jobs still run with your
account's rights.

A plugin's workspace page runs in a sandboxed frame without
`allow-same-origin`, so it has an opaque origin. It cannot read or script the
app's page, call the app's API, or use the app's storage or cookies. Its
Content-Security-Policy limits what it loads and fetches to the plugin SDK
(`/plugin-sdk/`) and its own `workspace/` folder. Everything else it does goes
through the host's bridge, which accepts an allowlist of calls scoped to that
plugin, project and study and logs the rest. Because the frame's origin is
opaque, GET requests for those two folders are answered to any origin
(`Access-Control-Allow-Origin: *`). They hold only the SDK and the plugin's
shipped files, never project data. The sandbox isolates crashes, styles and the
app's data from workspace code. It is not a defence against a malicious
plugin, whose Python already runs with your rights.

A workspace can keep large files in its plugin's folder of the open project
(`ws.files`). The app server streams them to and from disk; they never pass
through the Python worker. The server checks every path where it really lands
(links and junctions included), never writes a study's record, and holds the
workspace to the plugin's own size limits and to free disk space. The same
checks now apply to the workspace's JSON files (`ws.data`), and both are
refused while the plugin is turned off.

A workspace page may go full screen after a click or key press inside it. It
then covers the app and the browser's own controls, which makes a fake screen
easier to draw; the browser shows its own notice, Esc always leaves, and the app
leaves full screen before it shows any dialog. A workspace page can also take
the keyboard focus without a click. The app gives focus back to its own dialogs
when they open, but text typed into the app over an open workspace is not
isolated from that page. When a page says it has unsaved work, the app's
question shows the page's message after the plugin's name, as plain text with
control and direction-changing characters removed.

Keep projects, `.cache`, local preferences, environment files, keys, recordings,
and generated run reports out of source releases. `.gitignore` prevents new
tracking; it does not remove files from old commits. Review existing history
before pushing an existing repository publicly. A source zip made by
`pack-portable.ps1` excludes history and requires reviewed, committed source.

Report vulnerabilities privately to the maintainer through GitHub's private
vulnerability reporting facility when enabled. Do not include credentials or
private CAD/project files in a public issue.
