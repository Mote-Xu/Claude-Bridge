const express = require('express');
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const wecom = require('./wecom');
const SessionManager = require('./session');

// === 初始化 ===
wecom.init(config);
const database = db.init(config.dbPath);
const sessions = new SessionManager(database);

// === 输出节流器 ===
// 每个 chatId 维护一个缓冲区，攒够几条或超时后一起发送
const outputBuffers = new Map();
const outputTimers = new Map();

function flushOutput(chatId) {
  const buffer = outputBuffers.get(chatId);
  if (!buffer || buffer.length === 0) return;
  const lines = buffer.splice(0);
  outputTimers.delete(chatId);

  const prefix = lines[0].prefix || '';
  const text = lines.map(l => l.text).join('\n');
  const msg = `${prefix}${text}`.slice(0, 4096); // 企业微信单条消息上限

  wecom.sendMessage(chatId, msg).catch(err => {
    console.error(`Send error to ${chatId}:`, err.message);
  });
}

function throttleOutput(chatId, sessionId, sessionName, text) {
  if (!outputBuffers.has(chatId)) {
    outputBuffers.set(chatId, []);
  }
  const buffer = outputBuffers.get(chatId);

  // 第一条消息带上 session 标签
  const prefix = buffer.length === 0 ? `Claude·${sessionName}:\n` : '';
  buffer.push({ text, prefix });

  // 达到阈值立即发送
  if (buffer.length >= config.session.maxBurstMessages) {
    if (outputTimers.has(chatId)) {
      clearTimeout(outputTimers.get(chatId));
    }
    flushOutput(chatId);
    return;
  }

  // 设置超时发送
  if (!outputTimers.has(chatId)) {
    outputTimers.set(chatId, setTimeout(() => flushOutput(chatId), config.session.burstIntervalMs));
  }
}

function onClaudeOutput(chatId, sessionId, text) {
  const session = database.getSession(null, null); // 需要查询
  // 根据 sessionId 查找 session 信息
  const s = dbGetSessionById(sessionId);
  if (!s) return;

  throttleOutput(chatId, sessionId, s.session_name, text);
  db.auditLog(chatId, sessionId, 'out', text);
}

// 辅助：根据 session table ID 查找 session
function dbGetSessionById(id) {
  const stmt = database.prepare('SELECT * FROM sessions WHERE id = ?');
  return stmt.get(id);
}

// === 消息路由 ===
async function handleMessage(chatId, senderId, text) {
  const group = database.getGroup(chatId);

  // 如果群还没关联项目
  if (!group) {
    // 检查是否是项目名
    const project = config.projects[text.trim()];
    if (project) {
      database.addGroup(chatId, text.trim(), project);
      await wecom.sendMessage(chatId, `🟢 已接入项目：${text.trim()}`);
      const history = await sessions.listClaudeSessions(project);
      if (history.length > 0) {
        const list = history.slice(0, 5).map((s, i) =>
          `${i + 1}. ${s.summary} (${s.updatedAt?.slice(0, 10) || '?'})`
        ).join('\n');
        await wecom.sendMessage(chatId,
          `找到 ${history.length} 个历史会话：\n${list}\n\n回复数字续接，或 @新建 <会话名> 开始新会话`
        );
      } else {
        await wecom.sendMessage(chatId,
          '该项目暂无历史会话。用 @会话名 <你的消息> 开始新会话'
        );
      }
      return;
    }

    // 还没关联项目
    await wecom.sendMessage(chatId,
      '👋 我是 Claude。请告诉我你想接入哪个项目：\n' +
      Object.keys(config.projects).map(p => `  · ${p}`).join('\n')
    );
    return;
  }

  // === 命令处理 ===
  const trimmed = text.trim();

  // 列出会话
  if (trimmed === '会话列表' || trimmed === '/sessions' || trimmed === '列表') {
    const active = database.getActiveSessions(chatId);
    if (active.length === 0) {
      await wecom.sendMessage(chatId, '当前没有活跃会话。用 @会话名 <消息> 开始对话');
    } else {
      const list = active.map(s =>
        `  @${s.session_name} · ${s.message_count}轮 · ${s.status === 'active' ? '🟢' : '🟡'}`
      ).join('\n');
      await wecom.sendMessage(chatId, `${group.project_name} 的活跃会话：\n${list}`);
    }
    return;
  }

  // 停止
  if (trimmed === '/stop' || trimmed === '停止' || trimmed === '中断') {
    await wecom.sendMessage(chatId, '⚠️ 请用 @会话名 stop 指定要中断的会话');
    return;
  }

  // === @会话名 解析 ===
  const atMatch = trimmed.match(/^@(\S+)\s+(.*)/);
  if (!atMatch) {
    // 没有 @前缀，可能是发给活跃会话
    const active = database.getActiveSessions(chatId);
    if (active.length === 1) {
      // 只有一个活跃会话，自动路由
      await routeToSession(chatId, active[0], trimmed, senderId);
    } else if (active.length > 1) {
      const names = active.map(s => `@${s.session_name}`).join('、');
      await wecom.sendMessage(chatId, `有多个活跃会话：${names}\n你想发给谁？用 @会话名 <消息> 指定`);
    } else {
      await wecom.sendMessage(chatId, '没有活跃会话。用 @会话名 <消息> 开始新会话');
    }
    return;
  }

  const sessionName = atMatch[1];
  const message = atMatch[2];
  const sessionSlug = sessionName.replace(/[^a-zA-Z0-9一-鿿_-]/g, '_').slice(0, 30);

  // 命令
  if (message === 'stop' || message === '中断') {
    const session = database.getSession(chatId, sessionSlug);
    if (session) {
      await sessions.interruptSession(session.tmux_window);
      database.updateSessionStatus(session.id, 'idle');
      await wecom.sendMessage(chatId, `⏹ 已中断 @${sessionName}`);
    } else {
      await wecom.sendMessage(chatId, `找不到会话 @${sessionName}`);
    }
    return;
  }

  if (message === 'done' || message === '结束' || message === '关闭') {
    const session = database.getSession(chatId, sessionSlug);
    if (session) {
      await sessions.killSession(session.tmux_window);
      sessions.stopTail(session.tmux_window);
      database.endSession(session.id);
      await wecom.sendMessage(chatId, `✅ 已关闭 @${sessionName}`);
    } else {
      await wecom.sendMessage(chatId, `找不到会话 @${sessionName}`);
    }
    return;
  }

  // === 路由到指定会话 ===
  await routeToSession(chatId,
    database.getSession(chatId, sessionSlug),
    message, senderId,
    sessionName, sessionSlug,
    group
  );
}

// 实际路由逻辑
async function routeToSession(chatId, existingSession, message, senderId, sessionName, sessionSlug, group) {
  // 检查本地是否在线
  const online = await sessions.isLocalOnline();
  if (!online) {
    // 离线 → 入队
    database.enqueueTask(chatId, existingSession?.id || null, message, senderId);
    await wecom.sendMessage(chatId, '💻 主力机离线。任务已排队，上线后自动恢复。');
    return;
  }

  if (existingSession) {
    // 已有会话 → 直接发送
    database.touchSession(existingSession.id);
    database.auditLog(chatId, existingSession.id, 'in', message);
    await sessions.sendToSession(existingSession.tmux_window, message);

    // 确认尾部在运行
    if (!sessions.tailProcesses.has(existingSession.tmux_window)) {
      sessions.startTail(existingSession.tmux_window, chatId, existingSession.id,
        (cid, sid, text) => throttleOutput(cid, sid, sessionName || existingSession.session_name, text)
      );
    }
  } else {
    // 新会话 → 创建 tmux + Claude Code
    if (!sessionName || !sessionSlug) {
      await wecom.sendMessage(chatId, '用法：@会话名 <你的消息>');
      return;
    }

    // 检查是否选了历史会话（数字）
    let claudeSessionId = null;
    if (/^\d+$/.test(message)) {
      const idx = parseInt(message) - 1;
      const history = await sessions.listClaudeSessions(group.project_path);
      if (history[idx]) {
        claudeSessionId = history[idx].id;
      }
    }

    await wecom.sendMessage(chatId, `🆕 正在启动 @${sessionName}...`);

    try {
      const { pipeFile, tmuxWindow } = await sessions.createTmuxSession(
        sessionSlug, group.project_path, claudeSessionId
      );

      const result = database.createSession(
        chatId, sessionName, sessionSlug, claudeSessionId, tmuxWindow, pipeFile
      );

      // 开始 tail 管道
      sessions.startTail(tmuxWindow, chatId, result.lastInsertRowid,
        (cid, sid, text) => throttleOutput(cid, sid, sessionName, text)
      );

      // 如果是恢复历史会话，不需要额外注入消息
      if (claudeSessionId) {
        await wecom.sendMessage(chatId, `🟢 @${sessionName} 已恢复，Claude 等你的第一条消息`);
      } else if (message && !/^\d+$/.test(message)) {
        // 新会话：把第一条消息注入 Claude Code
        database.auditLog(chatId, result.lastInsertRowid, 'in', message);
        await sessions.sendToSession(tmuxWindow, message);
        database.touchSession(result.lastInsertRowid);
      }

    } catch (err) {
      console.error('Session creation error:', err);
      await wecom.sendMessage(chatId, `❌ 启动失败：${err.message}`);
    }
  }
}

// === Express 服务器 ===
const app = express();
app.use(express.text({ type: 'text/xml' }));
app.use(express.text({ type: 'application/xml' }));

// 企业微信回调 URL 验证（GET）
app.get('/webhook', (req, res) => {
  const { msg_signature, timestamp, nonce, echostr } = req.query;
  try {
    const echo = wecom.verifyUrl(timestamp, nonce, echostr, msg_signature);
    res.send(echo);
  } catch (err) {
    console.error('Verify error:', err.message);
    res.status(403).send('Forbidden');
  }
});

// 企业微信回调消息（POST）
app.post('/webhook', async (req, res) => {
  const { msg_signature, timestamp, nonce } = req.query;

  try {
    const parsed = await wecom.decryptMessage(req.body, msg_signature, timestamp, nonce);
    const msg = parsed.xml;

    if (msg.MsgType === 'text') {
      const chatId = msg.ChatId;
      const senderId = msg.From?.UserId || msg.FromUserName;
      const content = msg.Text?.Content || msg.Content;

      // 白名单检查
      if (config.whitelist && Object.keys(config.whitelist).length > 0) {
        if (!config.whitelist[chatId] && !config.whitelist[senderId]) {
          console.log(`Blocked message from ${chatId}/${senderId}`);
          res.send('success');
          return;
        }
      }

      // 异步处理消息
      handleMessage(chatId, senderId, content).catch(err => {
        console.error('Handle message error:', err);
      });
    }

    // 立即返回 success，不阻塞企业微信
    res.send('success');
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.send('success'); // 也返回 success，防止企业微信重试
  }
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// === 启动 ===
async function start() {
  try {
    // 连接 SSH
    await sessions.connect();
    console.log('SSH connected');

    // 启动 HTTP
    app.listen(config.port, '127.0.0.1', () => {
      console.log(`clawd Gateway listening on 127.0.0.1:${config.port}`);
    });

    // 空闲会话清理定时器
    setInterval(async () => {
      const idle = database.getIdleSessions(config.session.idleTimeoutHours);
      for (const s of idle) {
        const group = database.getGroup(s.chat_id);
        if (group) {
          await wecom.sendMessage(s.chat_id,
            `💤 @${s.session_name} 已闲置 ${config.session.idleTimeoutHours} 小时。\n回复 @${s.session_name} 继续聊天，或 @${s.session_name} done 关闭`
          ).catch(() => {});
        }
      }
    }, 60 * 60 * 1000); // 每小时检查一次

  } catch (err) {
    console.error('Startup error:', err);
    process.exit(1);
  }
}

// 优雅退出
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await sessions.disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await sessions.disconnect();
  process.exit(0);
});

start();
