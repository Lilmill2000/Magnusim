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

A workspace can run an OpenFOAM case it wrote (host API 1.3). Case content can
run code in WSL: OpenFOAM dictionaries may hold `#codeStream`, `#calc` and
`systemCall` entries, which compile and run code when the case runs. The host
checks the solver name, the case's path and every WSL step and argument against
fixed lists, and builds the WSL scripts only from those checked names: the
solver must be a registered plain program name, the case path and the step
arguments pass fixed character rules and are quoted, and no free text from the
case or the plugin reaches a shell. That stops shell injection through the
case's settings; it does not stop a malicious plugin, whose case runs with your
WSL account's rights. When a step list has a prepare step on the host (a later
meshing plugin), it is only that plugin's own job tool, run on the app's
interpreter or on that plugin's own environment, as a job the plugin starts
would run.

The case folder is the one place a plugin's page names a path the host acts on,
and attaching a case to the viewer is checked against the plugin's study
(`/api/case/attach` with `plugin` and `plugin_study_id`). Reading a case's
result fields checks only that the folder is inside the open project. Workspace
frames reach neither: they cannot call the app's API.

Solve hooks (`solve.prepare`, `solve.parse_line`, `solve.stop`) run inside the
relay process of every solve, core runs included, whenever some plugin listens.
A listener's output cannot reach the run's events, a slow or failing listener is
dropped for the run, and core solves never wait for one. A plugin whose code
ends that process, crashes it or patches the runtime can still end or bend a
run.

## The Assistant and API keys

The Assistant (Settings → Assistant, off until turned on) lets a model the owner
chooses work in Magnusim: a cloud provider with the owner's own API key, or a
local server on this PC.

It is for this PC only. Every Assistant request must come from a browser or
program on this PC talking to Magnusim directly (a loopback Host and connection,
no `X-Forwarded-*`, `Forwarded` or `CF-*` headers), checked on the path as the
server routes it, before anything is read. Through a reverse proxy or the
public tunnel visitors are anonymous, so every Assistant request answers 403:
"The Assistant and its API keys can only be set up and used on the PC running
Magnusim."

Keys are write-only. Settings can save or remove a key and shows only whether
one is set, with its last four characters when it is long. No request returns a
key, none takes one in its URL, and log lines and error texts are scrubbed of
saved keys and of anything shaped like one. A key is never put in an environment
variable, so the Python worker, jobs and plugin services never inherit it. Keys
are kept outside the install folder, in `%APPDATA%\Magnusim\secrets` (the
user's application-data folder on other systems), encrypted with AES-256-GCM
under a master key:

- On Windows the master key is protected with DPAPI for the signed-in Windows
  account, through Windows PowerShell 5.1; the bytes travel to it only on its
  standard input, never on a command line. It protects keys from other accounts
  and other PCs, not from other programs running as the same account. If Windows
  blocks that helper (Constrained Language Mode, application control or an
  antivirus), keys can't be saved on that PC; there is no unencrypted fallback,
  and a local server still works.
- On other systems the master key is kept in a file only the user's account can
  read (mode 0600, in a 0700 folder). The operating system does not encrypt it,
  and Settings says so.

Removing Magnusim's folder does not remove `%APPDATA%\Magnusim`; remove keys in
Settings before handing the PC to someone else.

Any program and any other account signed in to this PC can call the
Assistant's requests: the local check proves a request came from this PC, not
who sent it. Another account can't read the key, but can spend it within the
limits. The per-turn and per-day spending limits are checked before each step
of the Assistant's work, so one step can go a little over; two copies of
Magnusim run by one account share the day's limit and can pass it by up to
twice.

A plugin's page code that runs inside the app (not a sandboxed workspace frame)
has the app's own origin. It can start the Assistant, answer its questions,
replace a key, and read a key while it is typed into Settings. Workspace frames
cannot reach the app's API. Plugins can't replace the Assistant's Settings
step. Install only plugins you trust.

Project data goes to a cloud provider only when the person asks about a project
and the privacy setting allows it: asked once per project (the default), always,
or never. A local server keeps it on this PC; a server address outside this PC
needs a confirmation and is then treated as a cloud provider. Text that comes
from projects and plugins (names, logs, results) reaches the model as data,
never as instructions, and the app asks before the Assistant starts a
computation or does anything that can't be undone.

The Assistant's test switches (`MAGNUSIM_TEST_ASSISTANT_*`) work only together
with `MAGNUSIM_TEST_ASSISTANT=1`; `run.bat` and Setup never set them.

Keep projects, `.cache`, local preferences, environment files, keys, recordings,
and generated run reports out of source releases. `.gitignore` prevents new
tracking; it does not remove files from old commits. Review existing history
before pushing an existing repository publicly. A source zip made by
`pack-portable.ps1` excludes history and requires reviewed, committed source.

Report vulnerabilities privately to the maintainer through GitHub's private
vulnerability reporting facility when enabled. Do not include credentials or
private CAD/project files in a public issue.
