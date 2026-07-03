const express = require('express');
const config = require('./config');
const { init, getGroup, addGroup, createSession, getSessionByName, getActiveSessions, listSessions, updateSessionStatus, touchSession, updateClaudeSessionId, enqueueTask, auditLog } = require('./db');
const wecom = require('./wecom');
const { execClaude, healthCheck, getProjects, findLatestSession } = require('./ssh');

wecom.init(config);
init(config.dbPath);

async function reply(chatId, userId, text) {
  await wecom.sendMessage(chatId, userId, text.slice(0, 4000));
}

// 自动发现本地所有 Claude Code 项目
let projectsCache = null;
let projectsCacheTime = 0;

async function discoverProjects() {
  if (projectsCache && Date.now() - projectsCacheTime < 60000) return projectsCache;
  try {
    projectsCache = await getProjects();
    projectsCacheTime = Date.now();
  } catch { /* use cache */ }
  return projectsCache || {};
}

async function handleMessage(chatId, userId, text) {
  const group = getGroup(chatId);
  const trimmed = text.trim();

  if (!group) {
    const projects = await discoverProjects();
    const match = Object.entries(projects).find(
      ([name]) => name.toLowerCase() === trimmed.toLowerCase()
    );
    if (match) {
      addGroup(chatId, match[0], match[1]);
      await reply(chatId, userId, `🟢 已接入项目：${match[0]}\n用 @会话名 <消息> 开始对话`);
      return;
    }
    const names = Object.keys(projects).map(p => `  · ${p}`).join('\n') || '  (未发现 Claude 项目)';
    await reply(chatId, userId, '👋 请告诉我项目名：\n' + names);
    return;
  }

  const atMatch = trimmed.match(/^@(\S+)\s*(.*)/);

  if (!atMatch) {
    const active = getActiveSessions(chatId);
    if (active.length === 1) {
      await handleSessionMessage(chatId, userId, active[0], trimmed, group);
    } else if (active.length === 0) {
      await reply(chatId, userId, '用 @会话名 <消息> 开始对话');
    } else {
      const names = active.map(s => `@${s.session_name}`).join('、');
      await reply(chatId, userId, `有多个会话：${names}\n用 @会话名 指定`);
    }
    return;
  }

  const sessionName = atMatch[1];
  const message = atMatch[2];

  if (message === 'stop' || message === '中断') {
    const s = getSessionByName(chatId, sessionName);
    if (s) {
      updateSessionStatus(s.id, 'idle');
      await reply(chatId, userId, `⏹ 已中断 @${sessionName}`);
    }
    return;
  }

  const existing = getSessionByName(chatId, sessionName);
  await handleSessionMessage(chatId, userId, existing, message, group, sessionName);
}

async function handleSessionMessage(chatId, userId, existingSession, message, group, sessionName) {
  const online = await healthCheck();
  if (!online) {
    enqueueTask(chatId, existingSession?.id || null, message, userId);
    await reply(chatId, userId, '💻 主力机离线。任务已排队，上线后恢复。');
    return;
  }

  const name = sessionName || existingSession?.session_name;
  const isNew = !existingSession;
  const claudeSessionId = existingSession?.claude_session_id || null;

  auditLog(chatId, existingSession?.id || null, 'in', message);

  if (isNew) {
    createSession(chatId, name, message.slice(0, 50));
  }

  await reply(chatId, userId, `Claude·${name}:\n⏳ 处理中...`);

  try {
    const result = await execClaude(claudeSessionId, message, {
      cwd: group.project_path,
    });

    const output = (result.stdout || result.stderr || '(无输出)').slice(0, 3800);
    await reply(chatId, userId, `Claude·${name}:\n${output}`);
    auditLog(chatId, existingSession?.id || null, 'out', output);

    const s = existingSession || getSessionByName(chatId, name);
    if (s) {
      touchSession(s.id);
      if (isNew) {
        // 第一条消息后自动发现 Claude session ID
        const sid = await findLatestSession(group.project_path);
        if (sid) updateClaudeSessionId(s.id, sid);
      }
    }
  } catch (err) {
    await reply(chatId, userId, `Claude·${name}:\n❌ ${err.message.slice(0, 500)}`);
  }
}

// Express
const app = express();
app.use(express.text({ type: 'text/xml' }));
app.use(express.text({ type: 'application/xml' }));

app.get('/webhook', (req, res) => {
  try {
    res.send(wecom.verifyUrl(req.query.timestamp, req.query.nonce, req.query.echostr, req.query.msg_signature));
  } catch { res.status(403).send('Forbidden'); }
});

app.post('/webhook', async (req, res) => {
  try {
    const parsed = await wecom.decryptMessage(req.body, req.query.msg_signature, req.query.timestamp, req.query.nonce);
    const msg = parsed.xml;
    if (msg.MsgType === 'text') {
      const userId = msg.FromUserName || msg.From?.UserId || '';
      const chatId = msg.ChatId || userId;
      handleMessage(chatId, userId, msg.Text?.Content || msg.Content)
        .catch(err => console.error('Handle error:', err));
    }
  } catch (err) { console.error('Webhook error:', err.message); }
  res.send('success');
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(config.port, '127.0.0.1', () => {
  console.log(`clawd Gateway on 127.0.0.1:${config.port}`);
});
