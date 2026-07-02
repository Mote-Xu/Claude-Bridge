const express = require('express');
const config = require('./config');
const db = require('./db');
const wecom = require('./wecom');
const { execClaude, healthCheck } = require('./ssh');

wecom.init(config);
const database = db.init(config.dbPath);

// === 消息处理 ===
async function handleMessage(chatId, senderId, text) {
  const group = database.getGroup(chatId);
  const trimmed = text.trim();

  // 第一步：群还没绑定项目
  if (!group) {
    const projectName = Object.keys(config.projects).find(
      p => p.toLowerCase() === trimmed.toLowerCase()
    );
    if (projectName) {
      database.addGroup(chatId, projectName, config.projects[projectName]);
      await wecom.sendMessage(chatId, `🟢 已接入项目：${projectName}`);
      await sendSessionList(chatId);
      return;
    }
    await wecom.sendMessage(chatId,
      '👋 我是 Claude。请告诉我项目名：\n' +
      Object.keys(config.projects).map(p => `  · ${p}`).join('\n')
    );
    return;
  }

  // 命令
  if (trimmed === '列表' || trimmed === '/list') {
    await sendSessionList(chatId);
    return;
  }

  // 解析 @会话名
  const atMatch = trimmed.match(/^@(\S+)\s*(.*)/);
  if (!atMatch) {
    // 没有 @ → 如果有唯一活跃会话自动路由
    const active = database.getActiveSessions(chatId);
    if (active.length === 1) {
      await routeMessage(chatId, active[0], trimmed);
    } else if (active.length === 0) {
      await wecom.sendMessage(chatId,
        '没有活跃会话。用 @会话名 <消息> 开始对话\n' +
        '或发 "列表" 查看所有会话'
      );
    } else {
      const names = active.map(s => `@${s.session_name}`).join('、');
      await wecom.sendMessage(chatId, `有多个会话：${names}\n你想发给谁？用 @会话名 指定`);
    }
    return;
  }

  const sessionName = atMatch[1];
  const message = atMatch[2];

  // 命令：停止
  if (!message || message === 'stop' || message === '中断') {
    const session = database.getSessionByName(chatId, sessionName);
    if (session && !message) {
      // 只 @了会话名，没发消息 → 显示会话信息
      await wecom.sendMessage(chatId,
        `@${session.session_name} · ${session.message_count}轮 · ${session.status}`
      );
      return;
    }
    if (session && message === 'stop') {
      database.updateSessionStatus(session.id, 'idle');
      await wecom.sendMessage(chatId, `⏹ 已中断 @${sessionName}`);
      return;
    }
    // 新会话 + 空消息
    if (!session && !message) {
      await wecom.sendMessage(chatId, `找不到 @${sessionName}。请附上你的第一条消息。`);
      return;
    }
  }

  // 路由消息
  const session = database.getSessionByName(chatId, sessionName);
  await routeMessage(chatId, session, message, sessionName, group);
}

async function sendSessionList(chatId) {
  const sessions = database.listSessions(chatId);
  if (sessions.length === 0) {
    await wecom.sendMessage(chatId, '暂无会话。用 @会话名 <消息> 开始对话');
    return;
  }
  const list = sessions.map(s =>
    `  @${s.session_name} · ${s.message_count}轮 · ${s.status}`
  ).join('\n');
  await wecom.sendMessage(chatId, `当前会话：\n${list}`);
}

async function routeMessage(chatId, existingSession, message, sessionName, group) {
  // 离线检测
  const online = await healthCheck();
  if (!online) {
    database.enqueueTask(chatId, existingSession?.id || null, message, 'user');
    await wecom.sendMessage(chatId, '💻 主力机离线。任务已排队。');
    return;
  }

  const isNew = !existingSession;
  const claudeSessionId = existingSession?.claude_session_id || null;

  if (isNew) {
    // 新会话
    database.createSession(chatId, sessionName, message.slice(0, 50));
    await wecom.sendMessage(chatId, `🆕 启动 @${sessionName}...`);
  }

  database.auditLog(chatId, existingSession?.id || null, 'in', message);

  // 执行 Claude
  try {
    await wecom.sendMessage(chatId, `Claude·${sessionName}:\n⏳ 正在处理...`);

    const result = await execClaude(claudeSessionId, message, {
      cwd: group.project_path,
      onOutput: (text) => {
        // 流式输出不为空时推送
        // TODO: 节流推送（避免刷屏）
      },
    });

    // 返回结果，截断过长的输出
    const output = (result.stdout || result.stderr || '(无输出)').slice(0, 4000);
    await wecom.sendMessage(chatId, `Claude·${sessionName}:\n${output}`);

    database.auditLog(chatId, existingSession?.id || null, 'out', output);

    if (isNew || existingSession) {
      const sid = existingSession?.id || database.getSessionByName(chatId, sessionName)?.id;
      if (sid) {
        database.touchSession(sid);
        // 记录 claude session id（如果新创建的话）
        if (isNew && result.stdout) {
          const match = result.stdout.match(/session[_\s]?id[:\s]+(\S+)/i);
          if (match) {
            database.updateClaudeSessionId(sid, match[1]);
          }
        }
      }
    }
  } catch (err) {
    await wecom.sendMessage(chatId, `❌ 执行失败：${err.message}`);
  }
}

// === Express 服务器 ===
const app = express();
app.use(express.text({ type: 'text/xml' }));
app.use(express.text({ type: 'application/xml' }));

app.get('/webhook', (req, res) => {
  const { msg_signature, timestamp, nonce, echostr } = req.query;
  try {
    res.send(wecom.verifyUrl(timestamp, nonce, echostr, msg_signature));
  } catch (err) {
    res.status(403).send('Forbidden');
  }
});

app.post('/webhook', async (req, res) => {
  const { msg_signature, timestamp, nonce } = req.query;
  try {
    const parsed = await wecom.decryptMessage(req.body, msg_signature, timestamp, nonce);
    const msg = parsed.xml;
    if (msg.MsgType === 'text') {
      handleMessage(msg.ChatId, msg.From?.UserId, msg.Text?.Content || msg.Content)
        .catch(err => console.error('Handle error:', err));
    }
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
  res.send('success');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(config.port, '127.0.0.1', () => {
  console.log(`clawd Gateway on 127.0.0.1:${config.port}`);
});
