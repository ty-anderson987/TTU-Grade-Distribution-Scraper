Option Explicit

Dim shell, fso, root, safeRoot, logDir, logFile, previousLog
Dim nodeCheck, stopCmd, pidFile, pidText, verifyCmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
safeRoot = Replace(root, "'", "''")
shell.CurrentDirectory = root

nodeCheck = shell.Run("cmd /c where node >nul 2>nul", 0, True)
If nodeCheck <> 0 Then
    MsgBox "Node.js 20 or newer was not found. Run setup.bat after installing Node.js.", 16, "TTU Grade Scraper"
    WScript.Quit 1
End If

nodeCheck = shell.Run("cmd /c node -e ""process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"" >nul 2>nul", 0, True)
If nodeCheck <> 0 Then
    MsgBox "Node.js 20 or newer is required.", 16, "TTU Grade Scraper"
    WScript.Quit 1
End If

If Not fso.FolderExists(root & "\node_modules\playwright") Then
    MsgBox "Dependencies are not installed yet. Run setup.bat once first.", 48, "TTU Grade Scraper"
    WScript.Quit 1
End If

logDir = root & "\logs"
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)

' Ask any already-running TTU Grade Scraper on port 3847 to shut down.
' The status-shape check avoids sending shutdown to an unrelated web server.
stopCmd = "powershell -NoProfile -WindowStyle Hidden -Command """ & _
    "$ErrorActionPreference='SilentlyContinue'; $stopping=$false; " & _
    "try { " & _
    "$s=Invoke-RestMethod -Uri 'http://127.0.0.1:3847/api/status' -TimeoutSec 2; " & _
    "if (($null -ne $s.phase) -and ($null -ne $s.loginRequired)) { " & _
    "$stopping=$true; Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3847/api/shutdown' -TimeoutSec 2 | Out-Null " & _
    "} " & _
    "} catch {}; " & _
    "if ($stopping) { for($i=0;$i -lt 24;$i++) { Start-Sleep -Milliseconds 250; " & _
    "try { Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3847/api/status' -TimeoutSec 1 | Out-Null } catch { break } } }"""
shell.Run stopCmd, 0, True

' A stale PID file can outlive its process and Windows can later reuse that PID.
' Only terminate it if CIM confirms the process command line points at THIS folder's
' server.js; otherwise remove the stale marker and leave the unrelated process alone.
pidFile = root & "\.server.pid"
If fso.FileExists(pidFile) Then
    On Error Resume Next
    pidText = Trim(fso.OpenTextFile(pidFile, 1).ReadAll)
    If Len(pidText) > 0 And IsNumeric(pidText) Then
        verifyCmd = "powershell -NoProfile -WindowStyle Hidden -Command """ & _
            "$targetPid=" & pidText & "; " & _
            "$p=Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $targetPid) -ErrorAction SilentlyContinue; " & _
            "$expected=[regex]::Escape((Join-Path '" & safeRoot & "' 'server.js')); " & _
            "if ($p -and $p.CommandLine -match $expected) { Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue }"""
        shell.Run verifyCmd, 0, True
    End If
    fso.DeleteFile pidFile, True
    On Error GoTo 0
End If

' Keep one current log and one previous log so hidden-launch debugging cannot grow
' server.log forever during long Schedule Builder verification sessions.
logFile = logDir & "\server.log"
previousLog = logDir & "\server-prev.log"
On Error Resume Next
If fso.FileExists(logFile) Then
    If fso.GetFile(logFile).Size > 5242880 Then
        If fso.FileExists(previousLog) Then fso.DeleteFile previousLog, True
        fso.MoveFile logFile, previousLog
    End If
End If
On Error GoTo 0

' Start one fresh hidden backend. server.js opens the local GUI in the default browser.
shell.Run "cmd /c node server.js > """ & logFile & """ 2>&1", 0, False
