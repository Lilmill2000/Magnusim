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

The API (`/api/`, `/plugins/`, `/plugin-sdk/`) answers only requests whose Host
is this PC's own (`localhost`, a `*.localhost` name, an IP address) or one of the
hosts Vite allows the page on (`server.allowedHosts` in `vite.config.js`: the
public tunnel's host and `MAGNUSIM_ALLOWED_HOSTS`). Any other Host gets 403
before anything is read or written, so a web page whose domain is made to
resolve to 127.0.0.1 (DNS rebinding) can't use it. Magnusim CAD's own server has
no allowed list: this PC's names only.

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
  antivirus), keys can't be saved or unlocked on that PC; there is no
  unencrypted fallback. A local server still works without a token: a saved
  server token can't be unlocked either, and Settings says to remove it.
- On other systems the master key is kept in a file only the user's account can
  read (mode 0600, in a 0700 folder). The operating system does not encrypt it,
  and Settings says so.

A local server's token is tied to the server address it was saved for, and is
sent nowhere else: once the address changes, it is not sent until it is saved
again for the new one. Saved for a server outside this PC whose address starts
with `http://`, it travels there unencrypted, and Settings warns when it is
saved.

Every copy of Magnusim run by one Windows account shares
`%APPDATA%\Magnusim`, and reads the key files again before each use, save or
removal of a key, so a key removed in one copy is removed in all of them.
Removing Magnusim's folder does not remove `%APPDATA%\Magnusim`; remove keys in
Settings before handing the PC to someone else.

Any program and any other account signed in to this PC can call the
Assistant's requests (start a turn, change its settings): the local check
proves a request came from this PC, not who sent it. Another account can't read
the key, but can spend it within the limits. Starting a coding agent (a turn,
or its Test, connect check or sign-in in Settings) also needs a proof of this
account, and so do adding a custom agent and allowing one (Coding agents,
below).

The Assistant's questions are answered only by the app tab that shows them,
through that tab's own connection to the app, or by the program that started
the turn, with a key the app gave it when the turn started. A request typed in
the app's Assistant panel shows its questions in the window that started it
(as cards in that panel, never the app's confirm dialog); that window keeps the
request's key in its own session storage only to show the open questions again
after it reloads, never to answer them: the answer still goes through the
window's connection. Another program, an
app or a coding agent using Magnusim's tools, and the model itself can't answer
them. A question meant for the Magnusim window only (such as a coding agent
asking to use one of its own tools) is answered only in the window. This raises
the bar against a stray request; it is not a sandbox: a program running as the
same account can read that key from the starting program's memory, and any
program or account on this PC can take over a tab's connection to the app and
answer that tab's questions.

The per-turn and per-day spending limits are checked before each step of the
Assistant's work, so one step can go a little over; two copies of Magnusim run
by one account share the day's limit and can pass it by up to twice.

A plugin's page code that runs inside the app (not a sandboxed workspace frame)
has the app's own origin. It can start the Assistant, answer its questions,
replace a key, and read a key while it is typed into Settings. Workspace frames
cannot reach the app's API. Plugins can't replace the Assistant's Settings
step. Install only plugins you trust.

A workspace page may offer the Assistant tools of its own while it is open. The
frame never talks to the Assistant itself: it hands its list to the app's page,
which passes it on over the tab's event stream, on a channel for this PC only
whose every request carries an unguessable link. The tools belong to that tab
and its project. They are offered to turns started for that tab (a coding
agent's calls in such a turn included) and, while Other apps (MCP) is on and
it is the only connected app tab, to the apps on this PC that use Magnusim's
tools (see "Other apps on this PC"). The app
checks each call's input against the limits the tool declared before the page
sees it, runs one call at a time and caps what comes back. What a workspace says
about itself is the plugin's own text, trusted like its code: its notes for the
Assistant (its guide) go into the model's instructions, as notes from that
plugin, for the whole conversation (which keeps the first notes it met), and its
tools' names and descriptions go into the tool definitions the model is given.
A plugin must keep that text fixed and never fill it from a project; the app
can't check that it does. What a tool returns reaches the model only as data.
A call's progress goes to the turn's log, which the terminal client shows; it is
not sent to the model. A plugin turned off, replaced or reset loses its tools at
once, and a call it was running ends. The frame never sees the Assistant's
questions and can't answer them: they are cards in the app's Assistant panel,
outside the frame, and each takes the keyboard on its No, so Enter or Escape (a
key typed for the workspace) answers No. A tool whose risk the page doesn't name as one the app knows is
asked about like one that can't be undone. To keep a turn reachable while its
window is covered, a tab that ran the Assistant keeps its connection to the app
for 10 minutes after the last turn, even while hidden; then it lets go like any
hidden tab, and the Assistant can't reach it until it is shown again.

Project data goes to a cloud provider only when the person asks about a project
and the privacy setting allows it: asked once per project (the default), always,
or never. A local server keeps it on this PC; a server address outside this PC
needs a confirmation and is then treated as a cloud provider. Text that comes
from projects and from what plugins return (names, logs, results) reaches the
model as data, never as instructions; the one exception is a workspace's own
notes and tool descriptions, which are trusted plugin text (above). The app asks
before the Assistant starts a computation or does anything that can't be undone.

The Assistant's test switches (`MAGNUSIM_TEST_ASSISTANT_*`) work only together
with `MAGNUSIM_TEST_ASSISTANT=1`; `run.bat` and Setup never set them. The
stand-in key protector also needs a test home (`MAGNUSIM_ASSISTANT_HOME` or
`MAGNUSIM_LOCAL_JSON`), so it never keeps the keys in this PC's real folder.
## Other apps on this PC (MCP)

Settings → Assistant → Other apps (MCP) lets other AI apps on this PC (a
desktop chat app, a coding tool) use Magnusim's tools through the Model Context
Protocol. It is off until the owner turns it on.

- The connection is a socket on 127.0.0.1 only, apart from the app's web port:
  a web page can't speak to it, and the tunnel and reverse proxies never
  forward it. An app reaches it through a small bridge,
  `scripts/assistant-mcp.mjs`, that the app starts. The config Settings shows
  names the bridge and Magnusim's connection file, never a secret.
- Each launch of Magnusim makes a new random token and writes it to
  `mcp.json` beside the Assistant's settings, in the owner's own
  application-data folder (mode 0600 on systems other than Windows). The
  bridge and Magnusim each prove they hold it with a challenge both ways; the
  token itself never crosses the socket and is never in a command line, in
  Settings or in an answer. A clean exit removes the file, and the next start
  replaces it. Any program the owner runs, and an administrator, can read it:
  this keeps out other accounts and everything off this PC, not programs the
  owner runs.
- An app gets the tools of the one connected app tab (only the app-wide tools
  with no tab or several), with the same questions and privacy rules as the
  Assistant. A question shows in that tab as a card in the app's Assistant
  panel, saying that an app on this PC asks and naming it as it names itself (its own claim). Only
  that tab answers it, never the app; it waits 10 minutes, and with no tab to
  show it the call is refused.
- Every app counts as sending data off this PC. Under "Ask" the first call
  that reads a project asks once for all apps together (Allow covers every
  app; Don't allow holds for 10 minutes); until then the project's tools are
  listed without their own descriptions. "Never send" refuses them.
- All apps together get 120 changes and 1200 calls an hour; at most 4 apps are
  connected at once, each with one call at a time. Turning the switch off cuts
  off the apps connected now.

## Coding agents

Settings → Assistant → Coding agents lets a coding agent the owner already
uses, signed in with their own account, work for the Assistant beside the
API-key providers. Magnusim starts it as a program on this PC and talks to it
over its input and output (the Agent Client Protocol); the agent reaches
Magnusim's tools only through the connection above, bound to the conversation.
Agents are never part of Magnusim: the owner installs them, and Magnusim never
sees, stores or passes on their login. What the agent reads through Magnusim's
tools goes to the agent's own service, under the owner's account and terms, as
it does when the owner uses the agent in a terminal. Magnusim can't see what
that costs: it is billed to the owner's account with that agent, and the $
limits apply to API keys only.

**Its own tools off.** For an agent Magnusim knows how to lock down, a session
starts with the agent's own shell, file and web tools switched off, the owner's
own settings, instruction files and MCP servers for that agent left out, and a
note telling it to use only Magnusim's tools. This counts only when the agent
was found through its own published package at a version that was checked;
another program of the same name, an older version or a custom command counts
as an agent whose own tools stay on. Every agent is told there is no file
system and no terminal, its file and terminal requests are refused, and it
starts in an empty private working folder with only basic environment
variables (no other provider's key, nothing of Magnusim's). If an agent whose
tools should be off still uses or asks for a tool that isn't Magnusim's,
Magnusim stops it at once (a tripwire), and from then on it needs its allow
switch until Magnusim is updated. An agent that switches itself to a mode
Magnusim doesn't use is stopped too. Settings the PC's administrator manages
for the agent (managed policies, hooks) still apply, as in a terminal; the
tripwire stops the agent if they bring one of its own tools back. The check of
the package is by its name, version and real path, not by who put it there: a
whole package of the right name and version placed in an earlier folder of the
`PATH` that another account can write to would count as the agent's own (and
Magnusim asks its version when it looks for agents). Keep the folders on the
`PATH` writable only by the owner and administrators.

**The allow switch.** An agent whose own tools Magnusim can't switch off stays
off until the owner turns on "Allow this agent" in Settings, after a question
with "Don't" focused. The warning beside the switch says what it means: once
allowed, the agent can run commands, change files and read Magnusim's projects
on this PC by its own rules, whatever the privacy setting says, and Magnusim's
questions cover only Magnusim's tools. The switch is kept per agent with a
fingerprint of the program's path, the resolved script's path and the
arguments it was allowed for: a new path or new arguments count as off and
ask again, but an update of the program in place keeps it on. Turning it on
takes a request from the Settings page itself, sent after its question: the
app's own origin and the live link of the page's own connection to the app
(the page opens that connection for it). A tool, a turn, the settings request,
the terminal client and an agent whose own tools are off send neither. That
keeps out commands slipped into an agent's or a model's work, not programs the
owner runs, and only raises the bar for other accounts (see "This PC, not this
account"). Turning it off is always taken, with no question, and ends what the
agent still runs. A custom agent is added the same way and needs its switch,
even to connect.

**Who starts it, who answers it.** Starting a coding agent needs a proof of
this account, for a turn and for its Test, connect check and sign-in in
Settings alike: the per-launch token from `mcp.json`, which the terminal client
reads and sends only to a Magnusim that first proves, for the port it reached,
that it holds the same token; or the live link of an app tab's connection to
the app, which the page sends (from any page: Settings, a workspace, Home). A
coding agent's request to use one of its own tools becomes a
question that only the Magnusim window answers, as does its privacy question,
never the program that started the turn. Its requests to use Magnusim's own
tools are allowed by Magnusim ("Auto-allowed" in the turn's log), because
Magnusim asks its own questions for them; they are recognised only from fields
the agent's own software sets, never from a title the model writes. Nothing an
agent asks for runs between messages or after Stop.

**Privacy.** Every coding agent counts as sending data off this PC, under its
own destination: "Ask" asks once per project and per agent, in the Magnusim
window, before the agent is started; "Never send" refuses turns about a
project, and refuses every turn on an agent whose own tools stay on, since
such an agent could read the projects folder by itself.

**Stop.** Stop answers the agent's open requests as cancelled, then tells it
to cancel; if it hasn't answered within 3 seconds, it is ended with everything
it started. On Windows each agent runs inside a job object kept by a small
Windows PowerShell helper, so its whole process tree ends with it, even if
Magnusim itself is killed; if Windows blocks that helper, stopping is a
best-effort process-tree kill, and Settings says to check Task Manager. On
other systems the agent leads its own process group, which is ended as a
whole; groups a crashed Magnusim left behind are ended the next time it starts
a coding agent, so until then they may outlive it. An agent is also ended when its conversation
ends, after 15 minutes idle, when its switch goes off, when it crashes and when
Magnusim stops; at most two run at once. Each message allows 24 changes, 400
tool calls and 60 active minutes (Settings → Assistant → Limits).

**This PC, not this account.** The local check proves a request came from this
PC, not which account sent it. Any program the owner runs, an allowed agent's
own shell included, can read `mcp.json`, call the Assistant's requests and
connect to the app as a tab does, so it can do whatever the Settings page can.
Another account signed in to this PC (one that isn't an administrator) can't
read `mcp.json`, and the page's origin, which it can forge, is not enough by
itself: adding a custom agent, turning an allow switch on and starting any
coding agent (a turn, its Test, connect check or sign-in) also need the
per-launch token or the live link of an app tab's connection to the app. That
link isn't tied to an account either: any program on this PC that connects to
the app as a tab does gets one. So another account can, with that effort, add a
custom command, allow it and have Magnusim run it as the owner, or use an agent
that is allowed. Magnusim's guarantees hold against agents whose own tools are
off and against everything off this PC, not against code the owner lets run or
other accounts on this PC: allow agents only on a PC whose other accounts you
trust. A proof of the owner's account that another account can't get, for
these Settings changes, is planned after v0.5.0.

## Releases and reports

Keep projects, `.cache`, local preferences, environment files, keys, recordings,
and generated run reports out of source releases. `.gitignore` prevents new
tracking; it does not remove files from old commits. Review existing history
before pushing an existing repository publicly. A source zip made by
`pack-portable.ps1` excludes history and requires reviewed, committed source.

Report vulnerabilities privately to the maintainer through GitHub's private
vulnerability reporting facility when enabled. Do not include credentials or
private CAD/project files in a public issue.
