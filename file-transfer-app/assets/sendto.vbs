Set objArgs = WScript.Arguments
Dim appDir, exePath, filePath
appDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
exePath = appDir & "\file-transfer.exe"

If objArgs.Count > 0 Then
  filePath = objArgs(0)
  Set shell = CreateObject("WScript.Shell")
  shell.Run """" & exePath & """ """ & filePath & """", 1, False
End If
