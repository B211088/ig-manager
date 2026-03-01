Dim shell, folder
Set shell = CreateObject("WScript.Shell")
folder = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.Run "cmd.exe /K ""cd /d """ & folder & """ && node manager.js""", 1, False
