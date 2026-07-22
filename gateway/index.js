const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { init: dbInit, getGroup, addGroup, removeGroup, createSession, upsertSession, getSessionByName, getSessionById, getActiveSessions, updateSessionStatus, touchSession, updateClaudeSessionId, enqueueTask, getAllPendingTasks, getSessionPendingTasks, markTaskProcessed, hideSession, unhideSession, getHiddenSessionIds, auditLog } = require('./db');
const wecom = require('./wecom');
const { execClaude, healthCheck, getProjects, findLatestSession, listSessions, agentCall, recordChronicle, syncChronicles } = require('./agent');

wecom.init(config);
dbInit(config.dbPath);

// ========== 会话执行锁 ==========
// 防止同一会话被同时执行（撞车）。Gateway 单进程，内存 Set 足够
const sessionBusy = new Set();   // session DB id → true
const sessionBusyUuids = new Set(); // claude_session_id (UUID) → true

function markBusy(sessionId, uuid) {
  sessionBusy.add(sessionId);
  if (uuid) sessionBusyUuids.add(uuid);
}
function markIdle(sessionId, uuid) {
  sessionBusy.delete(sessionId);
  if (uuid) sessionBusyUuids.delete(uuid);
}
function isBusy(sessionId) { return sessionBusy.has(sessionId); }
function isBusyUuid(uuid) { return sessionBusyUuids.has(uuid); }

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

// 项目列表序号有效期（毫秒）
const PROJECT_LIST_WINDOW = 60000;
const projectListTimers = new Map(); // chatId → timestamp

async function handleMessage(chatId, userId, text) {
  const group = getGroup(chatId);
  const trimmed = stripBotMention(text);

  // VS Code 的隐藏列表（缓存 5 分钟）
  let vscodeHiddenCache = null, vscodeHiddenCacheTime = 0;
  async function getVscodeHiddenIds() {
    if (vscodeHiddenCache && Date.now() - vscodeHiddenCacheTime < 300000) return vscodeHiddenCache;
    try {
      const res = await agentCall('GET', '/api/hidden-sessions', null, 10000);
      vscodeHiddenCache = res.hiddenSessionIds || [];
      vscodeHiddenCacheTime = Date.now();
    } catch { vscodeHiddenCache = []; }
    return vscodeHiddenCache;
  }

  async function filterHidden(history) {
    const hiddenIds = new Set(getHiddenSessionIds(chatId));
    const vscodeIds = await getVscodeHiddenIds();
    for (const id of vscodeIds) hiddenIds.add(id);
    return history.filter(h => !hiddenIds.has(h.id));
  }

  // 会话状态
  if (trimmed === '/status' || trimmed === '状态') {
    try {
      const res = await agentCall('GET', '/api/busy-sessions', null, 20000);
      const busy = res.busy || [];
      if (busy.length === 0) {
        await reply(chatId, userId, '⚪ 当前没有会话正在执行。');
      } else {
        let msg = `🔄 ${busy.length} 个会话正在执行：`;
        for (const s of busy) {
          const proj = s.project ? `[${s.project}] ` : '';
          msg += `\n  · ${proj}${s.name}`;
        }
        await reply(chatId, userId, msg);
      }
    } catch {
      await reply(chatId, userId, '❌ 无法获取会话状态（Agent 不可用）');
    }
    return;
  }

  // 帮助
  if (trimmed === '/help' || trimmed === '帮助') {
    await reply(chatId, userId,
      '🤖 Claude-Bridge 命令：\n' +
      '  项目列表 / /projects — 列出所有项目\n' +
      '  列表 / /list — 查看当前项目所有会话\n' +
      '  预览 <序号> — 查看会话详情\n' +
      '  序号(1,2,3…) — 续接/切换会话\n' +
      '  切换 <项目名> — 换一个项目\n' +
      '  退出 / /leave — 退出当前项目\n' +
      '  @会话名 <消息> — 发给指定会话\n' +
      '  @会话名 stop — 中断会话\n' +
      '  @会话名 done — 结束会话\n' +
      '  隐藏 <序号> / 取消隐藏 <序号> — 隐藏/恢复会话\n' +
      '  隐藏列表 / /hidden — 查看已隐藏的会话\n' +
      '  状态 / /status — 查看哪些会话正在执行\n' +
      '  关vscode / /kill-vscode — 手动关闭 VS Code\n' +
      '  直接发消息 — 发给当前活跃会话'
    );
    return;
  }

  // 预览会话详情
  const previewMatch = trimmed.match(/^(?:预览|preview)\s+(\d+)$/i);
  if (previewMatch) {
    const num = parseInt(previewMatch[1]);
    const active = getActiveSessions(chatId);
    let rawHistory = await listSessions(group.project_path);
    rawHistory = await filterHidden(rawHistory);
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
      let msg = `📋 会话预览 #${num}`;
      if (detail.sessionName) msg += ` — ${detail.sessionName}`;
      msg += `\n📅 ${detail.date} | 👤 ${detail.userCount}条消息 | 🤖 ${detail.assistantCount}条回复`;
      msg += `\n📏 ${(detail.size / 1024).toFixed(0)}KB | 共${detail.totalLines}行`;
      if (detail.topicMsgs && detail.topicMsgs.length > 0) {
        msg += `\n\n💬 话题：`;
        for (const t of detail.topicMsgs) msg += `\n  · ${t.slice(0, 120)}`;
      }
      if (detail.recentRounds && detail.recentRounds.length > 0) {
        msg += `\n\n📝 最近 ${detail.recentRounds.length} 轮对话：`;
        for (const r of detail.recentRounds) {
          msg += `\n  👤 ${r.user}`;
          if (r.assistant) msg += `\n  🤖 ${r.assistant}`;
          msg += '\n  ---';
        }
      }
      msg += `\n\n回复 ${num} 接入此会话`;
      await reply(chatId, userId, msg);
    } catch {
      await reply(chatId, userId, '❌ 获取会话详情失败');
    }
    return;
  }

  // 查看已隐藏的会话
  if (trimmed === '隐藏列表' || trimmed === '/hidden') {
    const hiddenIds = getHiddenSessionIds(chatId);
    if (hiddenIds.length === 0) {
      await reply(chatId, userId, '没有隐藏的会话');
    } else {
      let msg = `🙈 已隐藏 ${hiddenIds.length} 个会话：`;
      for (const id of hiddenIds) {
        msg += `\n  · ${id.slice(0, 12)}...`;
      }
      msg += '\n\n发「取消隐藏 <序号>」恢复';
      await reply(chatId, userId, msg);
    }
    return;
  }

  // 隐藏/取消隐藏 会话
  const hideMatch = trimmed.match(/^(?:隐藏|hide)\s+(\d+)$/i);
  const unhideMatch = trimmed.match(/^(?:取消隐藏|unhide)\s+(\d+)$/i);
  if (hideMatch || unhideMatch) {
    const num = parseInt((hideMatch || unhideMatch)[1]);
    const active = getActiveSessions(chatId);
    const rawHistory = await listSessions(group.project_path);
    const hiddenIds = new Set(getHiddenSessionIds(chatId));
    const activeClaudeIds = new Set(active.map(s => s.claude_session_id).filter(Boolean));
    const history = rawHistory.filter(h => !activeClaudeIds.has(h.id));
    let targetId = null;
    if (num >= 1 && num <= active.length) {
      targetId = active[num - 1].claude_session_id;
    } else {
      const histIdx = num - active.length - 1;
      if (histIdx >= 0 && histIdx < history.length) targetId = history[histIdx].id;
    }
    if (!targetId) { await reply(chatId, userId, `❌ 序号 ${num} 超出范围`); return; }
    if (hideMatch) {
      hideSession(chatId, targetId);
      await reply(chatId, userId, `🙈 已隐藏 #${num}。发「取消隐藏 ${num}」可恢复`);
    } else {
      unhideSession(chatId, targetId);
      await reply(chatId, userId, `🐵 已取消隐藏 #${num}`);
    }
    return;
  }

  // 查看会话列表
  if (trimmed === '列表' || trimmed === '/list') {
    const active = getActiveSessions(chatId);
    let rawHistory = await listSessions(group.project_path);
    rawHistory = await filterHidden(rawHistory);
    const history = active.filter(s => s.claude_session_id)
      ? rawHistory.filter(h => !active.some(a => a.claude_session_id === h.id))
      : rawHistory;
    // 用 Agent 返回的最新标题覆盖 DB 里的旧名
    const titleMap = {};
    for (const h of rawHistory) { if (h.summary) titleMap[h.id] = h.summary; }
    let msg = `📋 项目：${group.project_name}`;
    if (active.length > 0) {
      msg += '\n\n🟢 活跃中：';
      active.forEach((s, i) => {
        const raw = (s.claude_session_id && titleMap[s.claude_session_id]) || s.session_name;
	        const title = (raw && raw.startsWith('bridge-')) ? '[Bridge] ' + raw.slice(7) : raw;
        msg += `\n  ${i + 1}. @${title} (${s.message_count}轮)`;
      });
    }
    if (history.length > 0) {
      const startIdx = active.length;
      msg += '\n\n💻 历史会话：';
      history.slice(0, 10).forEach((s, i) => {
        const rawLabel = s.summary || s.name || s.date || s.id.slice(0, 8);
	        const label = s.source === 'bridge' ? '[Bridge] ' + (s.summary || (s.name ? s.name.slice(7) : rawLabel)) : rawLabel;
        msg += `\n  ${startIdx + i + 1}. ${label}`;
      });
    }
    msg += '\n\n回复序号切换会话，或直接发消息';
    await reply(chatId, userId, msg);
    return;
  }

  // 关 VS Code
  if (trimmed === '关vscode' || trimmed === '/kill-vscode') {
    try {
      await agentCall('POST', '/api/kill-vscode', {}, 5000);
      await reply(chatId, userId, '💻 VS Code 已关闭。下次重开会自动恢复所有会话。');
    } catch {
      await reply(chatId, userId, '❌ 关闭 VS Code 失败（电脑离线或 Agent 不可用）');
    }
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
      // 先把旧项目所有活跃会话结束，防止跨项目污染
      const oldActive = getActiveSessions(chatId);
      for (const s of oldActive) updateSessionStatus(s.id, 'ended');
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

  // 项目列表（未绑定项目时可用）
  if (trimmed === '项目列表' || trimmed === '/projects') {
    const projects = await discoverProjects();
    const names = Object.keys(projects).map((p, i) => `  ${i + 1}. ${p}`).join('\n') || '  (未发现 Claude 项目)';
    projectListTimers.set(chatId, Date.now()); // 激活序号选择窗口
    await reply(chatId, userId, '📁 可用项目（60秒内回复序号接入）：\n' + names);
    return;
  }

  if (!group) {
    const projects = await discoverProjects();
    const projList = Object.entries(projects);
    // 项目列表显示后 60 秒内数字可选项目
    const listShown = projectListTimers.get(chatId) || 0;
    if (/^\d+$/.test(trimmed) && (Date.now() - listShown < PROJECT_LIST_WINDOW)) {
      projectListTimers.delete(chatId);
      const idx = parseInt(trimmed) - 1;
      if (idx >= 0 && idx < projList.length) {
        const [name, cwd] = projList[idx];
        addGroup(chatId, name, cwd);
        const history = await filterHidden(await listSessions(cwd));
        let msg = `🟢 已接入项目：${name}`;
        if (history.length > 0) {
          msg += `\n\n💻 电脑上的历史会话（回复序号续接）：`;
          history.slice(0, 8).forEach((s, i) => {
            const rawLabel = s.summary ? s.summary.slice(0, 30) : s.date || '';
            const label = s.source === 'bridge' ? '[Bridge] ' + rawLabel : rawLabel;
            msg += `\n  ${i + 1}. ${label}`;
          });
          msg += '\n\n或 @会话名 <消息> 新建会话';
        }
        await reply(chatId, userId, msg);
      } else {
        await reply(chatId, userId, `❌ 序号 ${trimmed} 超出范围`);
      }
      return;
    }
    const match = projList.find(
      ([name]) => name.toLowerCase() === trimmed.toLowerCase()
    );
    if (match) {
      addGroup(chatId, match[0], match[1]);
      const history = await filterHidden(await listSessions(match[1]));
      let msg = `🟢 已接入项目：${match[0]}`;
      if (history.length > 0) {
        msg += `\n\n💻 电脑上的历史会话（回复序号续接）：`;
        history.slice(0, 8).forEach((s, i) => {
          const rawLabel = s.summary ? s.summary.slice(0, 30) : s.date || '';
          const label = s.source === 'bridge' ? '[Bridge] ' + rawLabel : rawLabel;
          msg += `\n  ${i + 1}. ${label}`;
        });
        msg += '\n\n或 @会话名 <消息> 新建会话';
      } else {
        msg += '\n用 @会话名 <消息> 开始对话';
      }
      await reply(chatId, userId, msg);
      return;
    }
    if (trimmed) await reply(chatId, userId, '👋 发「项目列表」查看可用项目\n或直接输入项目名接入');
    return;
  }

  const atMatch = trimmed.match(/^@(\S+)\s*(.*)/);

  if (!atMatch) {
    // 纯数字 → 选择会话（不发消息给 Claude）
    if (/^\d+$/.test(trimmed)) {
      const active = getActiveSessions(chatId);
      let rawHistory = await listSessions(group.project_path);
      rawHistory = await filterHidden(rawHistory);
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
        const label = (h.summary || h.name || h.date || h.id.slice(0, 8)).slice(0, 25);
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
    const history = await filterHidden(await listSessions(group.project_path));
    if (history.length > 0) {
      const startIdx = active.length;
      msg += '\n\n💻 电脑历史会话：';
      history.slice(0, 6).forEach((s, i) => {
        const rawLabel = s.summary || s.name || s.date || s.id.slice(0, 8);
	        const label = s.source === 'bridge' ? '[Bridge] ' + (s.summary || (s.name ? s.name.slice(7) : rawLabel)) : rawLabel;
        const busy = isBusyUuid(s.id) ? ' 🔄' : '';
        msg += `\n  ${startIdx + i + 1}. ${label}${busy}`;
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

// 查找目标会话（先 DB，再项目会话列表）
async function resolveTargetSession(chatId, targetName, group) {
  let s = getSessionByName(chatId, targetName);
  if (s) return s;
  const sessions = await listSessions(group.project_path);
  const found = sessions.find(s =>
    (s.name && s.name.includes(targetName)) ||
    (s.summary && s.summary.includes(targetName))
  );
  if (found) {
    upsertSession(chatId, targetName, 'bridge');
    updateClaudeSessionId(getSessionByName(chatId, targetName).id, found.id);
    return getSessionByName(chatId, targetName);
  }
  return null;
}

// Bridge 路由：解析 @bridge:ask / @bridge:notify，转发到目标会话
async function bridgeRoute(chatId, userId, output, group, sourceName) {
  // ===== @bridge:ask — 双向通信 =====
  const askMatch = output.match(/@bridge:ask\s+(\S+)\s+([\s\S]+)/);
  if (askMatch) {
    const [, targetName, askMsg] = askMatch;
    const cleanAskMsg = askMsg.trim();
    if (!cleanAskMsg) return null;

    const targetSession = await resolveTargetSession(chatId, targetName, group);
    if (!targetSession) {
      await reply(chatId, userId, `❌ Bridge: 未找到目标会话 "${targetName}"`);
      return { handled: true };
    }

    const sourceSession = getSessionByName(chatId, sourceName);
    const sourceUuid = sourceSession?.claude_session_id || '';

    await reply(chatId, userId, `🔗 @${sourceName} → @${targetName} (ask)\n⏳ @${targetName} 处理中...`);

    try {
      // Step 1: 运行目标会话 B
      const bMessage = `[bridge:from=${sourceName}] ${cleanAskMsg}`;
      const bResult = await execClaude(
        targetSession.claude_session_id, bMessage,
        { cwd: group.project_path }
      );
      const bOutput = (bResult.stdout || bResult.stderr || '(无输出)').slice(0, 3000);
      auditLog(chatId, targetSession.id, 'out', bOutput);
      touchSession(targetSession.id);
      if (bResult.newSessionId) updateClaudeSessionId(targetSession.id, bResult.newSessionId);

      // 公开记录 B 的 ask 执行
      recordChronicle(group.project_path, targetName, 'in', `[bridge:ask from @${sourceName}] ${cleanAskMsg}`, 'bridge');
      recordChronicle(group.project_path, targetName, 'out', bOutput, 'bridge');

      // Step 2: 把 B 的回复注入 A，带上下文缝合
      if (sourceUuid && sourceSession) {
        await reply(chatId, userId, `🔗 @${targetName} → @${sourceName} (reply)\n⏳ @${sourceName} 整合中...`);

        const aMessage = `[ASYNC EVENT]
你在上一轮执行中向 @${targetName} 发起了 ask 请求。
你当时的问题是："${cleanAskMsg.slice(0, 200)}"
以下是 @${targetName} 的回复：
---
${bOutput.slice(0, 2500)}
---
请基于上述回复，继续你未完成的任务。`;

        const aResult = await execClaude(sourceUuid, aMessage, { cwd: group.project_path });
        const aOutput = (aResult.stdout || aResult.stderr || '(无输出)').slice(0, 3800);
        auditLog(chatId, sourceSession.id, 'out', aOutput);
        touchSession(sourceSession.id);
        if (aResult.newSessionId) updateClaudeSessionId(sourceSession.id, aResult.newSessionId);

        // 公开记录 A 收到回复后的整合
        recordChronicle(group.project_path, sourceName, 'in', `[bridge:reply from @${targetName}]`, 'bridge');
        recordChronicle(group.project_path, sourceName, 'out', aOutput, 'bridge');

        await reply(chatId, userId, `✅ @${sourceName} 完成:\n${aOutput}`);
      } else {
        // 源会话无 UUID（新创建），直接展示 B 的回复
        await reply(chatId, userId, `🔗 @${targetName} 回复:\n${bOutput}`);
      }
    } catch (err) {
      await reply(chatId, userId, `❌ Bridge ask → @${targetName}: ${err.message.slice(0, 300)}`);
    }
    return { handled: true };
  }

  // ===== @bridge:notify — 单向通知（现有逻辑） =====
  const match = output.match(/@bridge:notify\s+(\S+)\s+([\s\S]+)/);
  if (!match) return null;

  const [, targetName, bridgeMsg] = match;
  const cleanMsg = bridgeMsg.trim();
  if (!cleanMsg) return null;

  const targetSession = await resolveTargetSession(chatId, targetName, group);

  if (!targetSession) {
    await reply(chatId, userId, `❌ Bridge: 未找到目标会话 "${targetName}"`);
    return { handled: true };
  }

  await reply(chatId, userId, `🔗 @${sourceName} → @${targetName}\n⏳ 处理中...`);

  try {
    const notifyMsg = `[bridge:notify from @${sourceName}] ${cleanMsg}`;
    const result = await execClaude(
      targetSession.claude_session_id, notifyMsg,
      { cwd: group.project_path }
    );
    const targetOutput = (result.stdout || result.stderr || '(无输出)').slice(0, 3800);
    await reply(chatId, userId, `🔗 @${targetName}:\n${targetOutput}`);
    auditLog(chatId, targetSession.id, 'out', targetOutput);
    touchSession(targetSession.id);
    if (result.newSessionId) updateClaudeSessionId(targetSession.id, result.newSessionId);

    // 公开记录 B 的 notify 执行
    recordChronicle(group.project_path, targetName, 'in', `[bridge:notify from @${sourceName}] ${cleanMsg}`, 'bridge');
    recordChronicle(group.project_path, targetName, 'out', targetOutput, 'bridge');
  } catch (err) {
    await reply(chatId, userId, `❌ Bridge → @${targetName}: ${err.message.slice(0, 300)}`);
  }

  return { handled: true };
}

// 排空指定会话的等待队列（递归，一个接一个执行）
async function drainSessionQueue(chatId, sessionId, group) {
  const tasks = getSessionPendingTasks(chatId, sessionId);
  if (tasks.length === 0) return;

  const task = tasks[0];
  const s = getSessionById(sessionId);
  const claudeSid = s?.claude_session_id || null;
  const sessionName = s?.session_name || '未知';

  markBusy(sessionId, claudeSid);
  try {
    await reply(task.chat_id, task.sender, `📤 @${sessionName} 排队任务开始执行...`);
    const result = await execClaude(claudeSid, task.message, { cwd: group.project_path });
    const output = (result.stdout || result.stderr || '(无输出)').slice(0, 3800);
    auditLog(chatId, sessionId, 'out', output);

    if (s) {
      touchSession(s.id);
      if (result.newSessionId) updateClaudeSessionId(s.id, result.newSessionId);
    }

    await reply(task.chat_id, task.sender, `Claude·${sessionName}:\n${output}`);
  } catch (err) {
    await reply(task.chat_id, task.sender, `❌ 排队任务失败: ${err.message.slice(0, 200)}`);
  } finally {
    markTaskProcessed(task.id);
    markIdle(sessionId, claudeSid);
    // 递归处理下一个排队任务
    await drainSessionQueue(chatId, sessionId, group);
  }
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

  // 🔒 会话执行锁：正在执行中的会话，新消息入队排队
  const s = existingSession || getSessionByName(chatId, name);
  if (s && isBusy(s.id)) {
    enqueueTask(chatId, s.id, message, userId);
    await reply(chatId, userId, `📥 @${name} 正在处理中，消息已排队（稍后自动执行）`);
    return;
  }
  if (s) markBusy(s.id, s.claude_session_id);

  await reply(chatId, userId, `Claude·${name}:\n⏳ 处理中...`);

  try {
    const result = await execClaude(claudeSid, message, { cwd: group.project_path });
    const fullOutput = result.stdout || result.stderr || '(无输出)';
    const output = fullOutput.slice(0, 3800);
    auditLog(chatId, existingSession?.id || null, 'out', output);

    // 公开记录：写入项目 .bridge/sessions/@name.md
    recordChronicle(group.project_path, name, 'in', message, 'user');
    recordChronicle(group.project_path, name, 'out', fullOutput, 'user');

    const _s = existingSession || getSessionByName(chatId, name);
    if (_s) {
      touchSession(_s.id);
      if (isNew && result.newSessionId) {
        updateClaudeSessionId(_s.id, result.newSessionId);
      } else if (!claudeSid && !isNew) {
        const newSid = await findLatestSession(group.project_path);
        if (newSid) updateClaudeSessionId(_s.id, newSid);
      }
    }

    // Bridge 路由：检测 @bridge:notify，拦截并转发到目标会话
    const bridgeResult = await bridgeRoute(chatId, userId, fullOutput, group, name);
    if (bridgeResult?.handled) return; // Bridge 已处理，不发原始输出

    await reply(chatId, userId, `Claude·${name}:\n${output}`);
  } catch (err) {
    await reply(chatId, userId, `Claude·${name}:\n❌ ${err.message.slice(0, 500)}`);
  } finally {
    // 🔓 释放锁 + 排空队列
    if (s) {
      markIdle(s.id, s.claude_session_id);
      drainSessionQueue(chatId, s.id, group).catch(e => console.error('Session drain error:', e));
    }
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
        wecom.sendMessage(chatId, '', '👋 Claude-Bridge 已就绪！\n请告诉我要接入的项目名：\n' + names)
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
let publicIp = 'unknown';
async function refreshPublicIp() {
  try {
    const http = require('http');
    publicIp = await new Promise(r => {
      http.get('http://ifconfig.me/ip', res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>r(d.trim())); });
    });
  } catch { try {
    const http = require('http');
    publicIp = await new Promise(r => {
      http.get('http://icanhazip.com', res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>r(d.trim())); });
    });
  } catch {} }
}
refreshPublicIp();
setInterval(refreshPublicIp, 3600000); // hourly

app.get('/health', (req, res) => res.json({ status: 'ok', publicIp }));

// POST /api/bridge/ask — 会话给会话发消息的标准入口（对称：发起和回复走同一个 API）
// 调此接口 → 立刻返回 → Gateway 异步驱动目标会话 → 企微可见
app.post('/api/bridge/ask', express.json(), async (req, res) => {
  const { projectPath, sourceName, targetName, targetSessionId, message } = req.body;
  if (!projectPath || !sourceName || !targetName || !message) {
    return res.status(400).json({ error: 'projectPath, sourceName, targetName, message required' });
  }

  const chatRow = dbGetChatId();
  if (!chatRow) return res.status(404).json({ error: 'no chat — send a WeChat message first' });
  const chatId = chatRow.chat_id;
  const cwd = projectPath.replace(/\//g, '\\');

  // 立刻返回，调用方结束本轮
  res.json({ status: 'queued', note: `@${sourceName} → @${targetName}` });

  // 异步驱动目标会话
  (async () => {
    try {
      await reply(chatId, chatId, `🔗 @${sourceName} → @${targetName}\n⏳ 处理中...`);

      markBusy(0, targetSessionId); // 用 UUID 追踪（DB id 为 placeholder）
      const bMessage = `[bridge:from=${sourceName}] ${message}`;
      const bResult = await execClaude(targetSessionId, bMessage, { cwd });
      const bOutput = (bResult.stdout || bResult.stderr || '(无输出)').slice(0, 3800);
      markIdle(0, targetSessionId);

      await reply(chatId, chatId, `✅ @${targetName}:\n${bOutput}`);
    } catch (err) {
      markIdle(0, targetSessionId);
      await reply(chatId, chatId, `❌ @${sourceName} → @${targetName}: ${err.message.slice(0, 300)}`);
    }
  })().catch(err => console.error('Bridge ask async error:', err.message));
});

// 直接从 audit_log 取最近 chat_id（不依赖 sessions 表）
function dbGetChatId() {
  try {
    const db = require('better-sqlite3')(config.dbPath);
    return db.prepare("SELECT chat_id FROM audit_log WHERE chat_id != '' ORDER BY created_at DESC LIMIT 1").get();
  } catch { return null; }
}

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
      // 跳过正忙的会话（会被 session drain 处理，避免重复执行）
      if (task.session_id && isBusy(task.session_id)) continue;

      const group = getGroup(task.chat_id);
      if (!group) {
        markTaskProcessed(task.id);
        continue;
      }
      try {
        const ts = task.session_id ? getSessionById(task.session_id) : null;
        if (ts) markBusy(task.session_id, ts.claude_session_id);
        await reply(task.chat_id, task.sender, `📤 重试排队任务...`);
        const result = await execClaude(null, task.message, { cwd: group.project_path });
        const output = (result.stdout || result.stderr || '(无输出)').slice(0, 3800);
        await reply(task.chat_id, task.sender, output);
      } catch (err) {
        console.error(`Drain task ${task.id} failed:`, err.message);
        await reply(task.chat_id, task.sender, `❌ 排队任务失败: ${err.message.slice(0, 200)}`);
      } finally {
        const ts2 = task.session_id ? getSessionById(task.session_id) : null;
        if (ts2) markIdle(task.session_id, ts2.claude_session_id);
        markTaskProcessed(task.id);
      }
    }
  } catch (err) {
    console.error('Drain error:', err.message);
  } finally {
    drainRunning = false;
  }
}
setInterval(drainPendingTasks, 30000);

// 定期扫描 VS Code 创建的会话，写入 chronicle
async function syncAllChronicles() {
  try {
    const n = await syncChronicles();
    if (n > 0) console.log(`Chronicle sync: ${n} new entries`);
  } catch {}
}
setInterval(syncAllChronicles, 60000);
syncAllChronicles(); // 启动时立即跑一次

app.listen(config.port, '0.0.0.0', () => console.log(`Claude-Bridge Gateway on 0.0.0.0:${config.port}`));
