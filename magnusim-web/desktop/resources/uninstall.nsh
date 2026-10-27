; Magnusim CAD's uninstaller: its settings stay unless the person says to remove them (an update
; never asks). Projects in Documents\Magnusim CAD, and the Assistant's home shared with Magnusim
; (%APPDATA%\Magnusim), are always kept.
; SPDX-License-Identifier: GPL-3.0-or-later
!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also remove Magnusim CAD's settings?$\r$\n$\r$\nYour projects in Documents\Magnusim CAD are kept either way." /SD IDNO IDNO keep_settings
      RMDir /r "$APPDATA\Magnusim CAD"
    keep_settings:
  ${endIf}
!macroend
