const express = require('express');
const config = require('./config');
const { init: dbInit, getGroup, addGroup, removeGroup, createSession, getSessionByName, getActiveSessions, updateSessionStatus, touchSession, updateClaudeSessionId, enqueueTask, getAllPendingTasks, markTaskProcessed, auditLog } = require('./db');
const wecom = require('./wecom');
// Agent HTTP 优先，SSH 自动 fallback
const { execClaude, healthCheck, getProjects, findLatestSession, listSessions, agentCall } = require('./agent');

wecom.init(config);
dbInit(config.dbPath);

async function reply(chatId, userId, text) {
  await wecom.sendMessage(chatId, userId, text.slice(0, 4000));
}

let projectsCache = null, projectsCacheTime = 0;
async function discoverProjects() {
  if (projectsCache && Date.now() - projectsCacheTime < 60000) return projectsCache;
  try {
    projectsCache = await Promise.race([
      getProjects(),
      new Promise(r => setTimeout(() => r({}), 5000))
    ]);
    projectsCacheTime = Date.now();
  } catch {}
  // 如果自动发现失败，用 config 里的 projects 兜底
  return Object.keys(projectsCache || {}).length > 0 ? projectsCache : (config.projects || {});
}

// 剥离群聊 @Bot 前缀（群聊消息格式：@BotName 实际内容）
function stripBotMention(text) {
  return text.replace(/^@\S+\s*/, '').trim();
}

async function handleMessage(chatId, userId, text) {
  const group = getGroup(chatId);
  // 剥离 @Bot 前缀（群聊会有，私聊没有也不影响）
  const trimmed = stripBotMention(text);

  // 帮助
  if (trimmed === '/help' || trimmed === '帮助') {
    await reply(chatId, userId,
      '🤖 Clawd 命令：\n' +
      '  列表 / /list — 查看当前项目所有会话\n' +
      '  序号(1,2,3…) — 切换会话\n' +
      '  切换 <项目名> — 换一个项目\n' +
      '  退出 / /leave — 退出当前项目\n' +
      '  @会话名 <消息> — 发给指定会话\n' +
      '  @会话名 stop — 中断会话\n' +
      '  @会话名 done — 结束会话\n' +
      '  序号 — 续接历史会话\n' +
      '  直接发消息 — 发给当前活跃会话'
    );
    return;
  }

  // 预览会话详情
  const previewMatch = trimmed.match(/^(?:预览|preview)\s+(\d+)$/i);
  if (previewMatch) {
    const num = parseInt(previewMatch[1]);
    const active = getActiveSessions(chatId);
    const rawHistory = await listSessions(group.project_path);
    const activeClaudeIds = new Set(active.map(s => s.claude_session_id).filter(Boolean));
    const history = rawHistory.filter(h => !activeClaudeIds.has(h.id));

    // 确定要预览的会话 ID
    let targetId = null;
    if (num >= 1 && num <= active.length) {
      targetId = active[num - 1].claude_session_id;
    } else {
      const histIdx = num - active.length - 1;
      if (histIdx >= 0 && histIdx < history.length) targetId = history[histIdx].id;
    }
    if (!targetId) { await reply(chatId, userId, `❌ 序号 ${num} 超出范围`); return; }

    // 调 Agent 取详情
    try {
      const detail = await agentCall('POST', '/api/session-preview', { projectPath: group.project_path, sessionId: targetId }, 10000);
      let msg = `📋 会话预览 #${num}\n`;
      msg += `📅 ${detail.date} | 👤 ${detail.userCount}条消息 | 🤖 ${detail.assistantCount}条回复\n`;
      msg += `📏 ${(detail.size / 1024).toFixed(0)}KB | 共${detail.totalLines}行\n`;
      msg += `\n💬 第一条消息：\n${detail.firstMessage || '(无)'}`;
      if (detail.recentMessages && detail.recentMessages.length > 0) {
        msg += `\n\n📝 最近 ${detail.recentMessages.length} 条：`;
        for (const m of detail.recentMessages) {
          const icon = m.role === 'user' ? '👤' : '🤖';
          msg += `\n  ${icon} ${m.text}`;
        }
      }
      msg += `\n\n回复 ${num} 接入此会话`;
      await reply(chatId, userId, msg);
    } catch {
      await reply(chatId, userId, '❌ 获取会话详情失败');
    }
    return;
  }

  // 查看会话列表
  if (trimmed === '列表' || trimmed === '/list') {
    const active = getActiveSessions(chatId);
    const rawHistory = await listSessions(group.project_path);
    const history = active.filter(s => s.claude_session_id)
      ? rawHistory.filter(h => !active.some(a => a.claude_session_id === h.id))
      : rawHistory;
    let msg = `📋 项目：${group.project_name}`;
    if (active.length > 0) {
      msg += '\n\n🟢 活跃中：';
      active.forEach((s, i) => { msg += `\n  ${i + 1}. @${s.session_name} (${s.message_count}轮)`; });
    }
    if (history.length > 0) {
      const startIdx = active.length;
      msg += '\n\n💻 历史会话：';
      history.slice(0, 10).forEach((s, i) => {
        const label = s.summary || s.date || s.id.slice(0, 8);
        msg += `\n  ${startIdx + i + 1}. ${label}`;
      });
    }
    msg += '\n\n回复序号切换会话，或直接发消息';
    await reply(chatId, userId, msg);
    return;
  }

  // 切换项目
  if (trimmed.startsWith('切换 ') || trimmed.startsWith('/switch ')) {
    const target = trimmed.split(/\s+/)[1];
    const projects = await discoverProjects();
    const match = Object.entries(projects).find(
      ([name]) => name.toLowerCase() === target.toLowerCase()
    );
    if (match) {
      addGroup(chatId, match[0], match[1]);
      await reply(chatId, userId, `🔄 已切换到项目：${match[0]}`);
    } else {
      await reply(chatId, userId, `❌ 未找到项目 "${target}"`);
    }
    return;
  }

  // 退出
  if (trimmed === '退出' || trimmed === '/leave') {
    if (group) {
      removeGroup(chatId);
      await reply(chatId, userId, '👋 已退出项目。发送项目名重新接入');
    } else {
      await reply(chatId, userId, '当前未接入项目');
    }
    return;
  }

  if (!group) {
    const projects = await discoverProjects();
    const match = Object.entries(projects).find(
      ([name]) => name.toLowerCase() === trimmed.toLowerCase()
    );
    if (match) {
      addGroup(chatId, match[0], match[1]);
      const history = await listSessions(match[1]);
      let msg = `🟢 已接入项目：${match[0]}`;
      if (history.length > 0) {
        msg += `\n\n💻 电脑上的历史会话（回复序号续接）：`;
        history.slice(0, 8).forEach((s, i) => {
          const label = s.summary ? s.summary.slice(0, 30) : s.date || '';
          msg += `\n  ${i + 1}. ${label}`;
        });
        msg += '\n\n或 @会话名 <消息> 新建会话';
      } else {
        msg += '\n用 @会话名 <消息> 开始对话';
      }
      await reply(chatId, userId, msg);
      return;
    }
    const names = Object.keys(projects).map(p => `  · ${p}`).join('\n') || '  (未发现 Claude 项目)';
    await reply(chatId, userId, '👋 请告诉我项目名：\n' + names);
    return;
  }

  const atMatch = trimmed.match(/^@(\S+)\s*(.*)/);

  if (!atMatch) {
    // 纯数字 → 选择会话（不发消息给 Claude）
    if (/^\d+$/.test(trimmed)) {
      const active = getActiveSessions(chatId);
      const rawHistory = await listSessions(group.project_path);
      // 去掉已激活的历史会话，避免同一会话占两个序号
      const activeClaudeIds = new Set(active.map(s => s.claude_session_id).filter(Boolean));
      const history = rawHistory.filter(h => !activeClaudeIds.has(h.id));
      const num = parseInt(trimmed);

      // 清理所有旧活跃会话，确保选中后唯一定向
      for (const s of active) updateSessionStatus(s.id, 'ended');

      // 匹配活跃会话
      if (num >= 1 && num <= active.length) {
        const s = active[num - 1];
        updateSessionStatus(s.id, 'active');
        await reply(chatId, userId, `📋 @${s.session_name} (${s.message_count}轮)\n发消息继续对话`);
        return;
      }

      // 匹配历史会话
      const histIdx = num - active.length - 1;
      if (histIdx >= 0 && histIdx < history.length) {
        const h = history[histIdx];
        const label = (h.summary || h.date || h.id.slice(0, 8)).slice(0, 25);
        createSession(chatId, label, '');
        const s = getSessionByName(chatId, label);
        if (s) updateClaudeSessionId(s.id, h.id);
        await reply(chatId, userId, `📋 ${label}\n已接入，发消息继续对话`);
        return;
      }

      await reply(chatId, userId, `❌ 序号 ${trimmed} 超出范围`);
      return;
    }

    const active = getActiveSessions(chatId);
    // 只有唯一活跃会话 → 直接路由
    if (active.length === 1) {
      await handleSessionMessage(chatId, userId, active[0], trimmed, group);
      return;
    }
    // 列出所有可选会话（活跃 + 历史）
    let msg = '你想跟哪个会话聊？回复序号或 @会话名：';
    if (active.length > 0) {
      msg += '\n\n🟢 活跃中：';
      active.forEach((s, i) => { msg += `\n  ${i + 1}. @${s.session_name} (${s.message_count}轮)`; });
    }
    const history = await listSessions(group.project_path);
    if (history.length > 0) {
      const startIdx = active.length;
      msg += '\n\n💻 电脑历史会话：';
      history.slice(0, 6).forEach((s, i) => {
        const label = s.summary || s.date || s.id.slice(0, 8);
        msg += `\n  ${startIdx + i + 1}. ${label}`;
      });
    }
    msg += '\n\n或直接说 @会话名 <消息>';
    await reply(chatId, userId, msg);
    return;
  }

  const sessionName = atMatch[1];
  const message = atMatch[2];

  if (message === 'stop') {
    const s = getSessionByName(chatId, sessionName);
    if (s) { updateSessionStatus(s.id, 'idle'); await reply(chatId, userId, `⏹ 已中断 @${sessionName}`); }
    return;
  }
  if (message === 'done') {
    const s = getSessionByName(chatId, sessionName);
    if (s) { updateSessionStatus(s.id, 'ended'); await reply(chatId, userId, `✅ 已结束 @${sessionName}`); }
    return;
  }

  const existing = getSessionByName(chatId, sessionName);
  await handleSessionMessage(chatId, userId, existing, message, group, sessionName);
}

async function handleSessionMessage(chatId, userId, existingSession, message, group, sessionName) {
  const online = await healthCheck();
  if (!online) {
    enqueueTask(chatId, existingSession?.id || null, message, userId);
    await reply(chatId, userId, '💻 主力机离线。任务已排队。');
    return;
  }

  const isNew = !existingSession;
  const name = sessionName || existingSession?.session_name;

  auditLog(chatId, existingSession?.id || null, 'in', message);

  // 处理历史会话序号
  let claudeSid = existingSession?.claude_session_id || null;
  if (isNew && /^\d+$/.test(message)) {
    const history = await listSessions(group.project_path);
    const idx = parseInt(message) - 1;
    if (history[idx]) claudeSid = history[idx].id;
  }

  if (isNew) createSession(chatId, name, message.slice(0, 50));

  await reply(chatId, userId, `Claude·${name}:\n⏳ 处理中...`);

  try {
    const result = await execClaude(claudeSid, message, { cwd: group.project_path });
    const output = (result.stdout || result.stderr || '(无输出)').slice(0, 3800);
    await reply(chatId, userId, `Claude·${name}:\n${output}`);
    auditLog(chatId, existingSession?.id || null, 'out', output);

    const s = existingSession || getSessionByName(chatId, name);
    if (s) {
      touchSession(s.id);
      if (isNew && result.newSessionId) {
        updateClaudeSessionId(s.id, result.newSessionId);
      } else if (!claudeSid && !isNew) {
        const newSid = await findLatestSession(group.project_path);
        if (newSid) updateClaudeSessionId(s.id, newSid);
      }
    }
  } catch (err) {
    await reply(chatId, userId, `Claude·${name}:\n❌ ${err.message.slice(0, 500)}`);
  }
}

// Express
const app = express();
app.use(express.text({ type: 'text/xml' })); app.use(express.text({ type: 'application/xml' }));
app.get('/webhook', (req, res) => {
  try { res.send(wecom.verifyUrl(req.query.timestamp, req.query.nonce, req.query.echostr, req.query.msg_signature)); }
  catch { res.status(403).send('Forbidden'); }
});
app.post('/webhook', async (req, res) => {
  try {
    const parsed = await wecom.decryptMessage(req.body, req.query.msg_signature, req.query.timestamp, req.query.nonce);
    const msg = parsed.xml;

    // 事件消息：Bot 被拉入群聊
    if (msg.MsgType === 'event') {
      if (msg.Event === 'add_to_chat' || msg.Event === 'enter_chat') {
        const chatId = msg.ChatId || msg.FromUserName;
        const projects = await discoverProjects();
        const names = Object.keys(projects).map(p => `  · ${p}`).join('\n') || '  (未发现电脑上的 Claude 项目)';
        wecom.sendMessage(chatId, '', '👋 Clawd 已就绪！\n请告诉我要接入的项目名：\n' + names)
          .catch(err => console.error('Welcome error:', err));
      }
      return res.send('success');
    }

    if (msg.MsgType === 'text') {
      const userId = msg.FromUserName || msg.From?.UserId || '';
      handleMessage(msg.ChatId || userId, userId, msg.Text?.Content || msg.Content)
        .catch(err => console.error('Handle error:', err));
    }
  } catch (err) { console.error('Webhook error:', err.message); }
  res.send('success');
});
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// 定时 drain：每 30 秒检查电脑是否恢复在线，自动重试 pending 任务
let drainRunning = false;
async function drainPendingTasks() {
  if (drainRunning) return;
  drainRunning = true;
  try {
    const online = await healthCheck();
    if (!online) return;

    const tasks = getAllPendingTasks();
    if (tasks.length === 0) return;

    console.log(`Drain: ${tasks.length} pending task(s), computer is online`);
    for (const task of tasks) {
      const group = getGroup(task.chat_id);
      if (!group) {
        markTaskProcessed(task.id);
        continue;
      }
      try {
        await reply(task.chat_id, task.sender, `📤 重试排队任务...`);
        const result = await execClaude(null, task.message, { cwd: group.project_path });
        const output = (result.stdout || result.stderr || '(无输出)').slice(0, 3800);
        await reply(task.chat_id, task.sender, output);
      } catch (err) {
        console.error(`Drain task ${task.id} failed:`, err.message);
        await reply(task.chat_id, task.sender, `❌ 排队任务失败: ${err.message.slice(0, 200)}`);
      }
      markTaskProcessed(task.id);
    }
  } catch (err) {
    console.error('Drain error:', err.message);
  } finally {
    drainRunning = false;
  }
}
setInterval(drainPendingTasks, 30000);

app.listen(config.port, '127.0.0.1', () => console.log(`clawd Gateway on 127.0.0.1:${config.port}`));
