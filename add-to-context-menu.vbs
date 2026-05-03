Set objArgs = WScript.Arguments
If objArgs.Count > 0 Then
  Dim filePath
  filePath = objArgs(0)
  Dim fso, appDir, exePath
  Set fso = CreateObject("Scripting.FileSystemObject")
  appDir = fso.GetParentFolderName(WScript.ScriptFullName)
  exePath = appDir & "\文件传输.exe"
  Set shell = CreateObject("WScript.Shell")
  shell.Run """" & exePath & """ """ & filePath & """", 1, False
End If
