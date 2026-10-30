The JavaScript dependency inventory is recorded in the lockfiles:
`magnusim-web/package-lock.json` (the page, the server and the Assistant),
`magnusim-web/bundled-plugins/cad/package-lock.json` (the CAD workspace) and
`magnusim-web/desktop/package-lock.json` (Electron and the installer build).
`npm ci` installs them into `node_modules`; none is shipped in the repository.
React, vtk.js and the other packages keep their upstream licences.

The installer ships the npm packages the app runs, and the CAD workspace's
bundled libraries, with their licence texts in `THIRD_PARTY_NOTICES.txt` next to
the app; `magnusim-web/desktop/scripts/notices.mjs` writes it from the lockfiles
at each build, and the build fails on a package without a licence it accepts.
Electron's and Chromium's licences are next to `Magnusim CAD.exe`.
