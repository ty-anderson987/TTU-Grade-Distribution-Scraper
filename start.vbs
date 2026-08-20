Option Explicit

Dim shell, fso, root, logDir, nodeCheck, stopCmd, pidFile, pidText
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root

nodeCheck = shell.Run("cmd /c where node >nul 2>nul", 0, True)
If nodeCheck <> 0 Then
    MsgBox "Node.js 20 or newer was not found. Run setup.bat after installing Node.js.", 16, "TTU Grade Scraper"
    WScript.Quit 1
End If

If Not fso.FolderExists(root & "\node_modules\playwright") Then
    MsgBox "Dependencies are not installed yet. Run setup.bat once first.", 48, "TTU Grade Scraper"
    WScript.Quit 1
End If

logDir = root & "\logs"
If Not fso.FolderExists(logDir) Then
    fso.CreateFolder(logDir)
End If

' Ask any already-running TTU Grade Scraper on port 3847 to shut down.
' The status-shape check avoids sending shutdown to an unrelated web server.
stopCmd = "powershell -NoProfile -WindowStyle Hidden -Command """ & _
    "$ErrorActionPreference='SilentlyContinue'; " & _
    "try { " & _
    "$s=Invoke-RestMethod -Uri 'http://127.0.0.1:3847/api/status' -TimeoutSec 2; " & _
    "if (($null -ne $s.phase) -and ($null -ne $s.loginRequired)) { " & _
    "Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3847/api/shutdown' -TimeoutSec 2 | Out-Null " & _
    "} " & _
    "} catch {}; " & _
    "Start-Sleep -Milliseconds 800"""

shell.Run stopCmd, 0, True

' Fallback for a stale/crashed copy of this exact V2.6 folder.
pidFile = root & "\.server.pid"
If fso.FileExists(pidFile) Then
    On Error Resume Next
    pidText = Trim(fso.OpenTextFile(pidFile, 1).ReadAll)
    If Len(pidText) > 0 And IsNumeric(pidText) Then
        shell.Run "cmd /c taskkill /PID " & pidText & " /T /F >nul 2>nul", 0, True
    End If
    fso.DeleteFile pidFile, True
    On Error GoTo 0
End If

' Start one fresh hidden backend. server.js opens the local GUI in the default browser.
shell.Run "cmd /c node server.js >> """ & logDir & "\server.log"" 2>&1", 0, False
