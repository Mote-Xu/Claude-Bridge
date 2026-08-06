Dim Shell, agentPath
Set Shell = CreateObject("WScript.Shell")
agentPath = "D:\Node.js\node.exe ""e:\Desktop\Claude-Bridge\agent\index.js"""

Do
    Shell.Run agentPath, 0, True
    WScript.Sleep 5000
Loop
