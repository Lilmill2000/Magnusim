; Magnusim CAD's uninstaller: its settings stay unless the person says to remove them (an update
; never asks). They are all in the app's own folder, %APPDATA%\Magnusim CAD: its prefs
; (local.json) and, beside them, the Assistant's settings, saved API keys and chat history
; (local.assistant) and the server's log (logs), so removing the settings removes those too.
; Projects in Documents\Magnusim CAD are always kept.
; SPDX-License-Identifier: GPL-3.0-or-later
!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also remove Magnusim CAD's settings? They include the Assistant's saved API keys, its chat history (the last 31 days of chats, per project) and the app's logs.$\r$\n$\r$\nYour projects in Documents\Magnusim CAD are kept either way." /SD IDNO IDNO keep_settings
      RMDir /r "$APPDATA\Magnusim CAD"
    keep_settings:
  ${endIf}
!macroend
