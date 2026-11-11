; Included by the NSIS installer and uninstaller (electron-builder.config.cjs, nsis.include).
; Before replacing or removing files, electron-builder stops every process running from the install
; folder, bundled PostgreSQL included. Ask a running Moneo to quit the normal way first, so it stops
; its server and closes the database cleanly; the default check then handles anything left.
; Defining the custom hook suppresses these declarations in electron-builder's default include.
!include "getProcessInfo.nsh"
Var pid
!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    nsExec::Exec `"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit`
    Pop $R0
    StrCpy $R1 0
    ${Do}
      !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
      ${If} $R0 != 0
      ${OrIf} $R1 >= 40
        ${Break}
      ${EndIf}
      Sleep 1000
      IntOp $R1 $R1 + 1
    ${Loop}
  ${endif}
  !insertmacro _CHECK_APP_RUNNING
!macroend
