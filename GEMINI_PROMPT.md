# Claude Bridge — 外部 AI 项目咨询

> 把这段完整发给外部 AI（Gemini/GPT/Claude），让它帮你分析卡点和下一步方向。

---

## 项目目标

**手机（企业微信）是电脑前 Claude Code 的"第二屏幕"。**

我在外面用手机发消息，mote-home（24/7 Linux 服务器）通过 Tailscale SSH 到我 Windows 电脑上执行 `claude --resume <session-id>`，结果返回企业微信。同一套 session store，电脑上 `claude --continue` 能看到手机上的对话。

---

## 当前架构

```
企业微信 App → Bot API (webhook)
  → Node.js Gateway (mote-home, 127.0.0.1:8933)
    → Tailscale SSH → Windows (100.80.205.79)
      → claude --resume <id>
```

Gateway 只做消息路由。Claude Code 是唯一 AI 层。

---

## 已完成功能

1. ✅ 企业微信消息接收/解密/回复
2. ✅ SSH 远程执行 Claude Code（管道 + 中文编码）
3. ✅ `@会话名` 创建/续接会话
4. ✅ `claude --resume` 跨消息续接
5. ✅ 电脑历史会话列表显示
6. ✅ 多会话路由（@指定或唯一活跃自动路由）
7. ✅ 退出项目 / 重新接入
8. ✅ 电脑离线检测 + 任务排队

---

## 卡住的难题：项目自动发现

### 需求

Gateway 需要**自动发现**我 Windows 电脑上所有用 Claude Code 做过的项目。项目信息存在 `C:\Users\Mote\.claude\projects\` 目录下，每个项目一个子目录，目录里是 JSONL 会话文件。JSONL 第一行包含 `"cwd":"E:\\Desktop\\AI_Financial_Assistant"` 这样的完整路径。

### 当前方案

手动维护 `/mnt/data/clawd/config.js` 里的项目列表（27 个项目），每次加新项目要手动更新。不可接受。

### 尝试过的方案

**方案 1：PowerShell -EncodedCommand（失败）**
```javascript
// 问题：PowerShell 命令里的 $ 变量被 cmd.exe 先吃掉了
const psScript = `
  Get-ChildItem C:\\Users\\Mote\\.claude\\projects -Directory | % {
    $jl = dir $_.FullName\\*.jsonl -EA 0 | select -First 1;
    if ($jl) {
      $l = gc $jl.FullName -First 30 | % { if ($_ -match "cwd") { $_ } } | select -First 1;
      if ($l -and $l -match '"cwd"\\s*:\\s*"([^"]+)"') {
        $c = $matches[1];
        Write-Output "$c"
      }
    }
  }
`;
const psEnc = Buffer.from(psScript, 'utf16le').toString('base64');
const res = await sshExec(`powershell -NoProfile -EncodedCommand ${psEnc}`, 15000);
```
**失败原因**：JS 单引号字符串里嵌入 PowerShell 的 `"cwd"` 正则，引号冲突导致语法错误。

**方案 2：JS 字符串拼接（失败）**
```javascript
// 用 Buffer 构造命令字节避免转义
const cmdParts = [
  'for /d %d in (', '"', 'C:\\Users\\Mote\\.claude\\projects\\*', '"', 
  ') do @findstr /c:', '"', '\\"', 'cwd', '\\"', '"', 
  ' ', '"', '%d\\*.jsonl', '"', ' 2>nul'
];
const cmdStr = cmdParts.join('');
const grepAll = await sshExec(cmdStr, 15000);
```
**失败原因**：虽然 JS 语法通过了（`node -c` 检查 OK），但从 bash/ssh 测试时 `\\` 总是被吃掉成 `\`，导致命令路径变成 `C:UsersMote.claudeprojects`。

**方案 3：逐目录 findstr 循环（太慢）**
```javascript
// 29 个目录 × 每目录一次 SSH = 至少 30 秒，不可接受
for (const dir of dirs) {
  const grep = await sshExec(`findstr /c:"\"cwd\"" "${dir}\\*.jsonl"`, 5000);
  // ...
}
```

**方案 4：批处理文件（转义地狱）**
- 想把命令写成 .bat 文件 SCP 到 Windows 执行
- 但 .bat 文件在 Linux 上无法运行，SCP 到 Windows 也遇到 host key 问题

### 核心矛盾

SSH 命令链路有多层转义：

```
Node.js 字符串 → ssh2 conn.exec → SSH 服务器 → cmd.exe → 实际执行
```

每一层都吃一次反斜杠/引号。`\\` 在 JS 是 `\`，在 cmd 又不是。简单的 `dir /b C:\path` 命令可以正常工作（因为有 `sshExec` 封装），但 `for /d` 循环 + `findstr` + 正则的组合命令的转义无法可靠处理。

### 当前回退方案

```javascript
// config.js — 手动维护
projects: {
  "AI_Financial_Assistant": "E:\\Desktop\\AI_Financial_Assistant",
  "Stardust_Chat": "E:\\Desktop\\Deepseek_V4_API\\Stardust_Chat",
  // ... 27 个项目
}
```

---

## 相关代码文件

### sshExec 封装（所有 SSH 命令入口）
```javascript
function sshExec(cmd, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const { host, username, privateKey } = config.local;
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { conn.end(); reject(new Error('SSH timeout')); }, timeout);
    conn.on('ready', () => {
      conn.exec(cmd, { pty: false }, (err, stream) => {
        if (err) { clearTimeout(timer); conn.end(); return reject(err); }
        stream.on('data', (d) => stdout += d.toString());
        stream.stderr.on('data', (d) => stderr += d.toString());
        stream.on('close', (code) => { clearTimeout(timer); conn.end(); resolve({ stdout, stderr, code }); });
      });
    });
    conn.on('error', (err) => { clearTimeout(timer); reject(err); });
    conn.connect({ host, port: 22, username, privateKey: fs.readFileSync(privateKey), readyTimeout: 10000 });
  });
}
```

### execClaude（已验证能正常工作—中文编码）
```javascript
async function execClaude(sessionId, message, options = {}) {
  const claudeBin = 'C:\\Users\\Mote\\AppData\\Roaming\\npm\\claude.cmd';
  const msgFile = 'C:\\Users\\Mote\\AppData\\Local\\Temp\\clawd-msg.txt';
  const msgB64 = Buffer.from(message, 'utf-8').toString('base64');
  
  // Step 1: PowerShell UTF8 写文件（绕过 cmd echo 乱码）
  const writeScript = `$f='${msgFile}'; [System.IO.File]::WriteAllBytes($f,[System.Convert]::FromBase64String('${msgB64}')); $ProgressPreference='SilentlyContinue'`;
  const writeEnc = Buffer.from(writeScript, 'utf16le').toString('base64');
  await sshExec(`powershell -NoProfile -NonInteractive -EncodedCommand ${writeEnc}`, 10000);

  // Step 2: type file | claude --resume
  const resumeFlag = sessionId ? ` --resume "${sessionId}"` : '';
  const runCmd = `cmd /c "type ${msgFile} | ${claudeBin}${resumeFlag}"`;
  return sshExec(runCmd, 180000);
}
```

### listSessions（能工作，只列出文件名，不含摘要）
```javascript
async function listSessions(projectPath) {
  const encoded = projectPath[0].toLowerCase() + projectPath.slice(1).replace(/[:\\_]/g, '-');
  const dir = `C:\\Users\\Mote\\.claude\\projects\\${encoded}`;
  const res = await sshExec(`dir /o-d /tc "${dir}\\*.jsonl"`, 8000);
  return res.stdout.trim().split(/\r?\n/)
    .filter(l => l.includes('.jsonl'))
    .map(line => {
      const parts = line.trim().split(/\s+/);
      const fn = parts[parts.length - 1];
      return { id: fn.replace('.jsonl', ''), date: `${parts[0]} ${parts[1] || ''}` };
    });
}
```

---

## 想问外部 AI 的问题

1. **SSH 命令转义**：有没有办法在 Node.js ssh2 库中可靠执行包含引号、反斜杠的复杂 Windows 命令？`for /d + findstr` 这条命令能否换一种方式写，避开转义问题？

2. **项目发现替代方案**：不用 SSH 动态发现的话，有没有更简单的办法？比如：
   - 在 Windows 上跑一个定时脚本，把项目列表推送到 mote-home
   - 第一次手动配，之后通过 Claude Code 自身的 session 更新自动追加
   - 其他思路？

3. **架构评估**：目前的 Node.js Gateway + SSH + Claude Code pipe 方案有没有架构级的问题？要不要换成别的？

4. **PTY vs Pipe**：我测试了 `claude` 的 PTY 交互模式（`conn.exec(cmd, {pty: true})`），但 Claude Code v2.1.197 会弹出主题选择 TUI，`stream.write()` 的消息到不了聊天输入框。有没有办法跳过主题选择或用其他方式进入纯文本交互模式？如果 PTY 可行，就能实现真正的"手机=第二屏幕"体验。

5. **❓ 重新评估 OpenClaw**：这个项目最初考虑过用 OpenClaw，但被外部 AI 否掉了。否掉理由如下：

   > **当时的外部 AI 判断（第一轮咨询）：**
   >
   > *Gemini：*
   > "OpenClaw 是一个完备的 Agent 框架，而你其实只需要一个带有 SSH 通信能力的 Telegram Bot 管道。
   > 极简替代方案：直接用 Node.js 或 Python 写一个 100 行左右的 Bot 脚本。
   > OpenClaw 的 Skill 机制更适合'输入-等待-单次返回'的同步模式，处理复杂的 CLI 交互会很别扭。"
   >
   > *GPT：*
   > "OpenClaw 同时在'当 agent'和'当 router'，会导致决策逻辑不清晰、调试困难。
   > 去掉 OpenClaw。Claude Code 保持'唯一智能决策层'。OpenClaw 不要'思考'，只做 message broker、task queue、audit log。
   > 过早引入 agent orchestration 层。其实你还没到需要它的阶段。"

   **现在发生了什么（第二轮实践后）：**
   - 亲手写了 ~500 行 Node.js Gateway，踩了所有坑
   - SSH 多层转义地狱（JS → ssh2 → SSH server → cmd.exe → PowerShell → 正则），每一层都吃反斜杠和引号
   - `claude` 没有 `--no-tui` / `--chat` 等非交互 flag；PTY 模式 TUI 无法被 `stream.write()` 操控
   - 中文编码必须走 Base64 → PowerShell WriteAllBytes → cmd type pipe 三步，不能直接 `echo | claude`
   - 项目发现必须在本地读文件，远程 SSH grep JSONL 是不可靠的
   - 两台外部 AI（最新一轮）一致建议："Windows 本地 agent"——本质上是重新发明一个简化版 OpenClaw
   - OpenClaw 自带 WeCom 渠道、消息路由、本地文件访问、Windows agent 能力——恰好填补我们所有自建短板

   **核心问题：当初否掉 OpenClaw 的判断，在经历过这些实战验证后，还成立吗？**

   - OpenClaw 的 WeCom 渠道 + 本地 agent 模式，能否替代我们现在这套 SSH + pipe 的脆弱链路？
   - OpenClaw 接 Claude Code 作为后端模型（而非用 DeepSeek 取代它），能否保留"Claude Code 是唯一 AI 决策层"的原则？
   - 如果现在用 OpenClaw 重建，最小改动方案是什么？还是说自建 agent 更合适？
