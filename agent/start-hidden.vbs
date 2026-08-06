Dim Shell, agentPath
Set Shell = CreateObject("WScript.Shell")
' v1.8: 用 D:\Node24 (当前主力版本)，不用 D:\Node.js (v20 旧版)
agentPath = "D:\Node24\node-v24.15.0-win-x64\node.exe ""e:\Desktop\Claude-Bridge\agent\index.js"""

Do
    Shell.Run agentPath, 0, True
    WScript.Sleep 5000
Loop
