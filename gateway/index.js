const express = require('express');
const config = require('./config');
const { init: dbInit, getGroup, addGroup, removeGroup, createSession, getSessionByName, getActiveSessions, updateSessionStatus, touchSession, updateClaudeSessionId, enqueueTask, auditLog } = require('./db');
const wecom = require('./wecom');
const { execClaude, healthCheck, getProjects, findLatestSession, listSessions } = require('./ssh');

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

async function handleMessage(chatId, userId, text) {
  const group = getGroup(chatId);
  const trimmed = text.trim();

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
        const label = s.date || s.id.slice(0, 8);
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
    if (msg.MsgType === 'text') {
      const userId = msg.FromUserName || msg.From?.UserId || '';
      handleMessage(msg.ChatId || userId, userId, msg.Text?.Content || msg.Content)
        .catch(err => console.error('Handle error:', err));
    }
  } catch (err) { console.error('Webhook error:', err.message); }
  res.send('success');
});
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.listen(config.port, '127.0.0.1', () => console.log(`clawd Gateway on 127.0.0.1:${config.port}`));
