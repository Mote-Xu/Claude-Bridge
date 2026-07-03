' 静默启动 Clawd Agent，完全无窗口
CreateObject("Wscript.Shell").Run "node " & CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & "\index.js", 0, False
