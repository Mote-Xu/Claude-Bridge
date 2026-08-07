const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { init: dbInit, getGroup, addGroup, removeGroup, getGroupPlatform, createSession, upsertSession, getSessionByName, getSessionById, getActiveSessions, updateSessionStatus, touchSession, updateClaudeSessionId, enqueueTask, getAllPendingTasks, getSessionPendingTasks, markTaskProcessed, hideSession, unhideSession, getHiddenSessionIds, getBridgeSessionIds, auditLog } = require('./db');
const wecom = require('./wecom');
const telegram = require('./telegram');
const { execClaude, execClaudeStream, writeStdin, healthCheck, getProjects, findLatestSession, listSessions, agentCall, recordChronicle, syncChronicles } = require('./agent');

wecom.init(config);
telegram.init(config);
dbInit(config.dbPath);

// ========== 会话执行锁 ==========
// 防止同一会话被同时执行（撞车）。Gateway 单进程，内存 Set 足够
const sessionBusy = new Set();   // session DB id → true
const sessionBusyUuids = new Set(); // claude_session_id (UUID) → true

// ========== TG 权限交互状态 ==========
// TG 用户在 Claude 权限提示时点击 [批准]/[拒绝] 按钮后，Gateway 继续驱动
const tgPermissionState = new Map(); // chatId → { pendingSessionId, sessionName, tgPendingMsgId, group, s, existingSession, isNew, accumulatedOutput, claudeSid, permissionCount }
const streamReqs = new Map(); // sessionId → http.ClientRequest（用于 x:stop 中断流式请求）

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

async function reply(chatId, userId, text, platform) {
  if (platform === 'telegram') {
    await telegram.sendMessage(chatId, text.slice(0, 4000));
  } else {
    await wecom.sendMessage(chatId, userId, text.slice(0, 4000));
  }
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

// TG Inline Keyboard 回调缓存：存按钮对应的数据列表
// { projects: [...], sessions: [...], activeCount: N, ttl: timestamp }
const callbackCache = new Map();
function cacheSet(chatId, data) {
  // 保留 _kbdMsgs 不被覆盖（键盘追踪跨多次 cacheSet）
  const prev = callbackCache.get(chatId);
  const kbdMsgs = data._kbdMsgs || (prev?._kbdMsgs) || [];
  callbackCache.set(chatId, { ...prev, ...data, _kbdMsgs: kbdMsgs, ttl: Date.now() + 300000 });
}
function cacheGet(chatId) {
  const d = callbackCache.get(chatId);
  if (!d || Date.now() > d.ttl) { callbackCache.delete(chatId); return null; }
  return d;
}

// ── 键盘追踪（模块级，handleMessage 和 handleSessionMessage 共用）──
function trackKeyboardMsg(msgId, chatId) {
  const c = cacheGet(chatId) || {};
  if (!c._kbdMsgs) c._kbdMsgs = [];
  c._kbdMsgs.push(msgId);
  cacheSet(chatId, c);
  console.log(`[KBD] Tracked msg ${msgId} for chat ${chatId}, total: ${c._kbdMsgs.length}`);
}
function clearAllKeyboards(cid) {
  const c = cacheGet(cid);
  if (c?._kbdMsgs && c._kbdMsgs.length > 0) {
    console.log(`[KBD] Clearing ${c._kbdMsgs.length} keyboards for chat ${cid}:`, c._kbdMsgs);
    for (const id of c._kbdMsgs) {
      telegram.editMessageReplyMarkup(cid, id, {}).catch(err => console.error(`[KBD] Failed to clear msg ${id}:`, err.message));
    }
    c._kbdMsgs = [];
    cacheSet(cid, c);
  } else {
    console.log(`[KBD] No keyboards to clear for chat ${cid}`);
  }
}

async function handleMessage(chatId, userId, text, platform = 'wecom') {
  const group = getGroup(chatId);

  // 快捷 reply：自动使用当前消息的 platform
  async function rp(text_, markup) {
    if (platform === 'telegram' && markup) {
      const res = await telegram.sendMessage(chatId, text_.slice(0, 4000), { replyMarkup: markup });
      if (res?.message_id) trackKeyboardMsg(res.message_id, chatId);
      return res;
    } else {
      await reply(chatId, userId, text_, platform);
      return null;
    }
  }
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

  // ── TG Inline Keyboard 回调 ──
  if (platform === 'telegram' && /^[a-z]:/.test(trimmed)) {
    const cached = cacheGet(chatId);
    // p:N → 选项目
    const pMatch = trimmed.match(/^p:(\d+)$/);
    if (pMatch && cached?.projects) {
      const idx = parseInt(pMatch[1]);
      const proj = cached.projects[idx];
      if (proj) {
        addGroup(chatId, proj.name, proj.cwd, 'telegram');
        const history = await filterHidden(await listSessions(proj.cwd));
        const active = getActiveSessions(chatId);
        const bridgeSessionIds = new Set(getBridgeSessionIds(chatId));
        const activeClaudeIds = new Set(active.map(s => s.claude_session_id).filter(Boolean));
        const historyOnly = history.filter(h => !activeClaudeIds.has(h.id));
        let msg = `🟢 已接入项目：${proj.name}`;
        const btns = [];
        let btnIdx = 0;
        if (active.length > 0) {
          msg += '\n\n🟢 活跃中：';
          active.forEach((s, i) => {
            msg += `\n  ${i + 1}. @${s.session_name} (${s.message_count}轮)`;
            btns.push({ text: `${i + 1}`, data: `s:${btnIdx++}` });
          });
        }
        const display = historyOnly.slice(0, 12);
        if (display.length > 0) {
          msg += '\n\n💻 电脑上的历史会话：';
          display.forEach((s, i) => {
            const rl = (s.summary || s.name || s.date || s.id.slice(0, 8)).slice(0, 25);
            const label = (s.source === 'bridge' || bridgeSessionIds.has(s.id)) ? '[🌉] ' + rl : rl;
            msg += `\n  ${btnIdx + 1}. ${label}`;
            btns.push({ text: `${btnIdx + 1}`, data: `s:${btnIdx++}` });
          });
        }
        msg += '\n\n或 @会话名 <消息> 新建会话';
        cacheSet(chatId, { projects: cached.projects, sessions: display, activeCount: active.length, projectName: proj.name });
        clearAllKeyboards(chatId);
        const kb = telegram.buildInlineKeyboard(btns, 4);
        await rp(msg, kb);
      } else {
        await rp('❌ 项目序号已过期，请重新发送「项目列表」');
      }
      return;
    }
    // s:N → 选会话
    const sMatch = trimmed.match(/^s:(\d+)$/);
    if (sMatch && cached?.sessions) {
      const idx = parseInt(sMatch[1]);
      await selectSessionByIndex(chatId, userId, idx, cached, group);
      return;
    }
    // v:N:P → 预览翻页（原地编辑，不刷屏）
    const vMatch = trimmed.match(/^v:(\d+):(\d+)$/);
    if (vMatch && cached?.preview) {
      const { num, detail } = cached.preview;
      const msgId = cached._previewMsgId; // 第一条预览消息的 ID
      await renderPreviewPage(chatId, userId, num, parseInt(vMatch[2]), detail, platform, msgId);
      return;
    }
    // /list → 返回会话列表（恢复原列表消息的键盘 + 隐藏预览消息键盘）
    if (trimmed === '/list' && group) {
      const active2 = getActiveSessions(chatId);
      const bridgeSessionIds2 = new Set(getBridgeSessionIds(chatId));
      const history2 = await filterHidden(await listSessions(group.project_path));
      const display2 = history2.slice(0, 8);
      const btnsL = [];
      let msg2 = `📋 项目：${group.project_name}`;
      if (active2.length > 0) {
        msg2 += '\n\n🟢 活跃中：';
        active2.forEach((s, i) => { msg2 += `\n  ${i + 1}. @${s.session_name} (${s.message_count}轮)`; btnsL.push({ text: `${i+1}`, data: `s:${i}` }); });
      }
      if (display2.length > 0) {
        const si = active2.length;
        msg2 += '\n\n💻 历史会话：';
        display2.forEach((s, i) => {
          const rl = s.summary || s.name || s.date || s.id.slice(0, 8);
          const lb = bridgeSessionIds2.has(s.id) ? '[🌉] ' + rl : rl;
          msg2 += `\n  ${si + i + 1}. ${lb}`;
          btnsL.push({ text: `${si+i+1}`, data: `s:${si+i}` });
        });
      }
      cacheSet(chatId, { sessions: display2, activeCount: active2.length, projectName: group.project_name });
      clearAllKeyboards(chatId);
      const kb2 = telegram.buildInlineKeyboard(btnsL, 4);
      if (btnsL.length > 0) {
        await rp(msg2, kb2);
      }
      return;
    }
    // y:ok / n:no → TG 权限批准/拒绝
    if (trimmed === 'y:ok' || trimmed === 'n:no') {
      const permState = tgPermissionState.get(chatId);
      if (!permState) { await rp('⌛ 权限请求已过期'); return; }
      tgPermissionState.delete(chatId);

      const input = trimmed === 'y:ok' ? 'yes' : 'no';
      const { pendingSessionId, sessionName, tgPendingMsgId, group: permGroup, s: permS, existingSession, isNew, accumulatedOutput, claudeSid } = permState;

      // 标记"处理中"
      if (tgPendingMsgId) {
        telegram.editMessageText(chatId, tgPendingMsgId, `Claude·${sessionName}:\n⏳ 处理中...`, null, true).catch(() => {});
      }

      try {
        const result = await writeStdin(pendingSessionId, input, permGroup.project_path);
        const permRound = (permState.permissionCount || 0) + 1;

        if (result.status === 'permission_needed') {
          // 权限循环上限：最多 5 轮，超过自动拒绝
          if (permRound > 5) {
            await rp(`Claude·${sessionName}:\n⚠️ 权限请求超过上限（5次），已自动拒绝`);
            if (permS) { markIdle(permS.id, permS.claude_session_id); drainSessionQueue(chatId, permS.id, permGroup).catch(() => {}); }
            return;
          }
          // 又一次权限提示 —— 重新显示按钮
          tgPermissionState.set(chatId, {
            ...permState,
            pendingSessionId: result.pendingSessionId || pendingSessionId,
            accumulatedOutput: result.stdout,
            permissionCount: permRound,
          });
          const permKb = telegram.buildInlineKeyboard([
            [{ text: '✅ 批准', data: 'y:ok' }, { text: '❌ 拒绝', data: 'n:no' }],
            [{ text: '⏹ 停止', data: 'x:stop' }],
          ], 2);
          const tail = (result.stdout || '').slice(-1500);
          if (tgPendingMsgId) {
            await telegram.editMessageText(chatId, tgPendingMsgId, `Claude·${sessionName}:\n${tail}\n\n_需要你的批准_`, permKb, false);
          } else {
            await rp(`Claude·${sessionName}:\n${tail}\n\n_需要你的批准_`, permKb);
          }
          return;
        }

        // 完成
        const fullOutput = result.stdout || result.stderr || '(无输出)';
        const output = fullOutput.slice(0, 3800);
        auditLog(chatId, permS?.id || null, 'out', output);

        recordChronicle(permGroup.project_path, sessionName, 'in', `[permission: ${input}]`, 'user');
        recordChronicle(permGroup.project_path, sessionName, 'out', fullOutput, 'user');

        if (permS) {
          touchSession(permS.id);
          if (result.newSessionId) updateClaudeSessionId(permS.id, result.newSessionId);
        }

        if (tgPendingMsgId && permS && !isBusy(permS.id)) {
          const partial = output || '(无输出)';
          await telegram.editMessageText(chatId, tgPendingMsgId, `Claude·${sessionName}:\n${partial}\n\n⏹ 已中断`, null, true);
        } else if (tgPendingMsgId) {
          await telegram.editMessageText(chatId, tgPendingMsgId, `Claude·${sessionName}:\n${output}`, null, true);
        } else {
          await rp(`Claude·${sessionName}:\n${output}`);
        }

        // 释放锁 + 排空队列
        if (permS) {
          markIdle(permS.id, permS.claude_session_id);
          drainSessionQueue(chatId, permS.id, permGroup).catch(e => console.error('Session drain error:', e));
        }
      } catch (err) {
        if (tgPendingMsgId) {
          await telegram.editMessageText(chatId, tgPendingMsgId, `Claude·${sessionName}:\n❌ ${err.message.slice(0, 500)}`, null, true);
        } else {
          await rp(`Claude·${sessionName}:\n❌ ${err.message.slice(0, 500)}`);
        }
        if (permS) {
          markIdle(permS.id, permS.claude_session_id);
          drainSessionQueue(chatId, permS.id, permGroup).catch(e => console.error('Session drain error:', e));
        }
      }
      return;
    }

    // x:stop → 停止当前活跃会话（杀 Claude 进程 + 显示部分输出）
    if (trimmed === 'x:stop') {
      // ── 如果在 TG 权限等待中，直接用 pendingSessionId 杀进程 ──
      const permState = tgPermissionState.get(chatId);
      if (permState) {
        tgPermissionState.delete(chatId);
        if (permState.pendingSessionId) {
          agentCall('POST', '/api/stop-claude', { sessionId: permState.pendingSessionId }, 5000).catch(() => {});
        }
        if (permState.s) {
          updateSessionStatus(permState.s.id, 'idle');
          markIdle(permState.s.id, permState.s.claude_session_id);
          drainSessionQueue(chatId, permState.s.id, permState.group).catch(e => console.error('Session drain error:', e));
        }
        if (permState.tgPendingMsgId) {
          const partial = (permState.accumulatedOutput || '(无输出)').slice(0, 3500);
          telegram.editMessageText(chatId, permState.tgPendingMsgId, `Claude·${permState.sessionName}:\n${partial}\n\n⏹ 已中断`, null, true).catch(() => {});
        }
        return;
      }

      const activeStop = getActiveSessions(chatId);
      for (const as of activeStop) {
        updateSessionStatus(as.id, 'idle');
        markIdle(as.id, as.claude_session_id);
        // 中断流式请求（如果正在流式输出）
        const sreq = streamReqs.get(as.id);
        if (sreq) { sreq.destroy(); streamReqs.delete(as.id); }
        // 调 Agent 杀掉正在跑的 Claude 进程
        if (as.claude_session_id) {
          agentCall('POST', '/api/stop-claude', { sessionId: as.claude_session_id }, 5000).catch(() => {});
        }
      }
      // 编辑"处理中"消息 → 等待 execClaude 返回部分输出后自动覆盖
      const pendingId = cached?._pendingMsgId;
      if (pendingId) {
        telegram.editMessageText(chatId, pendingId, '⏹ 正在中断...', null, true).catch(() => {});
      }
      return;
    }
    // 未识别的 callback，忽略
    return;
  }

  // 会话状态
  if (trimmed === '/status' || trimmed === '状态') {
    try {
      const res = await agentCall('GET', '/api/busy-sessions', null, 20000);
      const busy = res.busy || [];
      if (busy.length === 0) {
        await rp('⚪ 当前没有会话正在执行。');
      } else {
        let msg = `🔄 ${busy.length} 个会话正在执行：`;
        for (const s of busy) {
          const proj = s.project ? `[${s.project}] ` : '';
          msg += `\n  · ${proj}${s.name}`;
        }
        await rp(msg);
      }
    } catch {
      await rp('❌ 无法获取会话状态（Agent 不可用）');
    }
    return;
  }

  // 帮助
  if (trimmed === '/help' || trimmed === '帮助') {
    await rp(
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

    let targetId = null;
    if (num >= 1 && num <= active.length) {
      targetId = active[num - 1].claude_session_id;
    } else {
      const histIdx = num - active.length - 1;
      if (histIdx >= 0 && histIdx < history.length) targetId = history[histIdx].id;
    }
    if (!targetId) { await rp(`❌ 序号 ${num} 超出范围`); return; }

    try {
      const detail = await agentCall('POST', '/api/session-preview', { projectPath: group.project_path, sessionId: targetId }, 10000);
      // TG: 缓存全部轮次，分页展示
      if (platform === 'telegram' && detail.allRounds && detail.allRounds.length > 0) {
        const pages = Math.ceil(detail.allRounds.length / 2);
        clearAllKeyboards(chatId);
        cacheSet(chatId, {
          preview: { num, detail, targetId, allRounds: detail.allRounds },
          ttl: Date.now() + 600000,
        });
        await renderPreviewPage(chatId, userId, num, 0, detail, platform);
      } else {
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
        await rp(msg);
      }
    } catch {
      await rp('❌ 获取会话详情失败');
    }
    return;
  }

  // 查看已隐藏的会话
  if (trimmed === '隐藏列表' || trimmed === '/hidden') {
    const hiddenIds = getHiddenSessionIds(chatId);
    if (hiddenIds.length === 0) {
      await rp('没有隐藏的会话');
    } else {
      let msg = `🙈 已隐藏 ${hiddenIds.length} 个会话：`;
      for (const id of hiddenIds) {
        msg += `\n  · ${id.slice(0, 12)}...`;
      }
      msg += '\n\n发「取消隐藏 <序号>」恢复';
      await rp(msg);
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
    if (!targetId) { await rp(`❌ 序号 ${num} 超出范围`); return; }
    if (hideMatch) {
      hideSession(chatId, targetId);
      await rp(`🙈 已隐藏 #${num}。发「取消隐藏 ${num}」可恢复`);
    } else {
      unhideSession(chatId, targetId);
      await rp(`🐵 已取消隐藏 #${num}`);
    }
    return;
  }

  // 查看会话列表
  if (trimmed === '列表' || trimmed === '/list') {
    const active = getActiveSessions(chatId);
    const bridgeSessionIds = new Set(getBridgeSessionIds(chatId));
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
	        const label = (s.source === 'bridge' || bridgeSessionIds.has(s.id)) ? '[🌉] ' + rawLabel : rawLabel;
        msg += `\n  ${startIdx + i + 1}. ${label}`;
      });
    }
    const btns = [];
    if (active.length > 0) active.forEach((s, i) => btns.push({ text: (i+1).toString(), data: 's:'+i }));
    const displayHistory = history.slice(0, 10);
    if (displayHistory.length > 0) {
      const si = active.length;
      displayHistory.forEach((s, i) => btns.push({ text: (si+i+1).toString(), data: 's:'+(si+i) }));
    }
    if (platform === 'telegram' && btns.length > 0) {
      cacheSet(chatId, { sessions: displayHistory, activeCount: active.length, projectName: group.project_name });
      const res = await rp(msg, telegram.buildInlineKeyboard(btns, 4));
    } else {
      msg += '\n\n回复序号切换会话，或直接发消息';
      await rp(msg);
    }
    return;
  }

  // 关 VS Code
  if (trimmed === '关vscode' || trimmed === '/kill-vscode' || trimmed === '/kill_vscode') {
    try {
      await agentCall('POST', '/api/kill-vscode', {}, 5000);
      await rp('💻 VS Code 已关闭。下次重开会自动恢复所有会话。');
    } catch {
      await rp('❌ 关闭 VS Code 失败（电脑离线或 Agent 不可用）');
    }
    return;
  }

  // 切换项目
  if (trimmed === '/switch' || trimmed === '切换') {
    // 不带参数 → 显示项目列表选
    const projects = await discoverProjects();
    const projList3 = Object.entries(projects);
    if (platform === 'telegram' && projList3.length > 0) {
      cacheSet(chatId, { projects: projList3.map(([name, cwd]) => ({ name, cwd })) });
      const btns3 = projList3.map(([name], i) => ({ text: name, data: `p:${i}` }));
      await rp('🔄 切换到哪个项目？', telegram.buildInlineKeyboard(btns3, 1));
    } else {
      const names = projList3.map((p, i) => `  ${i + 1}. ${p[0]}`).join('\n') || '  (未发现 Claude 项目)';
      await rp('🔄 可用项目：\n' + names);
    }
    return;
  }
  if (trimmed.startsWith('切换 ') || trimmed.startsWith('/switch ')) {
    const target = trimmed.split(/\s+/)[1];
    const projects = await discoverProjects();
    const match = Object.entries(projects).find(
      ([name]) => name.toLowerCase() === target.toLowerCase()
    );
    if (match) {
      clearAllKeyboards(chatId);
      callbackCache.delete(chatId);
      tgPermissionState.delete(chatId);
      // 先把旧项目所有活跃会话结束，防止跨项目污染
      const oldActive = getActiveSessions(chatId);
      for (const s of oldActive) updateSessionStatus(s.id, 'ended');
      addGroup(chatId, match[0], match[1], platform);
      await rp(`🔄 已切换到项目：${match[0]}`);
    } else {
      await rp(`❌ 未找到项目 "${target}"`);
    }
    return;
  }

  // 退出
  if (trimmed === '退出' || trimmed === '/leave') {
    if (group) {
      clearAllKeyboards(chatId);
      callbackCache.delete(chatId);
      tgPermissionState.delete(chatId);
      removeGroup(chatId);
      await rp('👋 已退出项目。发送项目名重新接入');
    } else {
      await rp('当前未接入项目');
    }
    return;
  }

  // 项目列表（未绑定项目时可用）
  if (trimmed === '项目列表' || trimmed === '/projects' || (platform === 'telegram' && (trimmed === '/start'))) {
    const projects = await discoverProjects();
    const projList = Object.entries(projects);
    if (projList.length === 0) {
      await rp('📁 未发现 Claude 项目\n（电脑离线或 Agent 未启动）');
      return;
    }
    if (platform === 'telegram') {
      cacheSet(chatId, { projects: projList.map(([name, cwd]) => ({ name, cwd })) });
      const btns = projList.map(([name], i) => ({ text: name, data: `p:${i}` }));
      const kb = telegram.buildInlineKeyboard(btns, 1); // 每行 1 个，项目名可能很长
      await rp('📁 选择项目：', kb);
    } else {
      const names = projList.map((p, i) => `  ${i + 1}. ${p[0]}`).join('\n');
      projectListTimers.set(chatId, Date.now());
      await rp('📁 可用项目（60秒内回复序号接入）：\n' + names);
    }
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
        const bridgeSessionIds = new Set(getBridgeSessionIds(chatId));
        const history = await filterHidden(await listSessions(cwd));
        let msg = `🟢 已接入项目：${name}`;
        if (history.length > 0) {
          msg += `\n\n💻 电脑上的历史会话（回复序号续接）：`;
          history.slice(0, 8).forEach((s, i) => {
            const rawLabel = s.summary ? s.summary.slice(0, 30) : s.date || '';
            const label = (s.source === 'bridge' || bridgeSessionIds.has(s.id)) ? '[🌉] ' + rawLabel : rawLabel;
            msg += `\n  ${i + 1}. ${label}`;
          });
          msg += '\n\n或 @会话名 <消息> 新建会话';
        }
        await rp(msg);
      } else {
        await rp(`❌ 序号 ${trimmed} 超出范围`);
      }
      return;
    }
    const match = projList.find(
      ([name]) => name.toLowerCase() === trimmed.toLowerCase()
    );
    if (match) {
      addGroup(chatId, match[0], match[1], platform);
      const bridgeSessionIds = new Set(getBridgeSessionIds(chatId));
      const history = await filterHidden(await listSessions(match[1]));
      let msg = `🟢 已接入项目：${match[0]}`;
      if (history.length > 0) {
        msg += `\n\n💻 电脑上的历史会话（回复序号续接）：`;
        history.slice(0, 8).forEach((s, i) => {
          const rawLabel = s.summary ? s.summary.slice(0, 30) : s.date || '';
          const label = (s.source === 'bridge' || bridgeSessionIds.has(s.id)) ? '[🌉] ' + rawLabel : rawLabel;
          msg += `\n  ${i + 1}. ${label}`;
        });
        msg += '\n\n或 @会话名 <消息> 新建会话';
      } else {
        msg += '\n用 @会话名 <消息> 开始对话';
      }
      await rp(msg);
      return;
    }
    if (trimmed) await rp('👋 发「项目列表」查看可用项目\n或直接输入项目名接入');
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
        await rp(`📋 @${s.session_name} (${s.message_count}轮)\n发消息继续对话`);
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
        await rp(`📋 ${label}\n已接入，发消息继续对话`);
        return;
      }

      // TG: 如果 DB 没有会话，尝试从缓存取（按钮选项目后还没在 DB 建 session）
      if (active.length === 0 && history.length === 0) {
        const cached = cacheGet(chatId);
        if (cached?.sessions && platform === 'telegram') {
          await selectSessionByIndex(chatId, userId, num - 1, { ...cached, activeCount: 0 }, group);
          return;
        }
      }

      await rp(`❌ 序号 ${trimmed} 超出范围`);
      return;
    }

    const active = getActiveSessions(chatId);
    const bridgeSessionIds = new Set(getBridgeSessionIds(chatId));
    // 只有唯一活跃会话 → 直接路由
    if (active.length === 1) {
      await handleSessionMessage(chatId, userId, active[0], trimmed, group);
      return;
    }
    // 列出所有可选会话（活跃 + 历史）
    let msg = `你想跟哪个会话聊？`;
    const btns2 = [];
    const history2 = await filterHidden(await listSessions(group.project_path));
    const displayHistory2 = history2.slice(0, 8);

    if (active.length > 0) {
      msg += `

🟢 活跃中：`;
      active.forEach((s, i) => { msg += `
  ${i + 1}. @${s.session_name} (${s.message_count}轮)`; btns2.push({ text: `${i+1}`, data: `s:${i}` }); });
    }
    if (displayHistory2.length > 0) {
      const startIdx = active.length;
      msg += `

💻 电脑历史会话：`;
      displayHistory2.forEach((s, i) => {
        const rawLabel = s.summary || s.name || s.date || s.id.slice(0, 8);
        const label = (s.source === 'bridge' || bridgeSessionIds.has(s.id)) ? `[🌉] ` + rawLabel : rawLabel;
        const busy = isBusyUuid(s.id) ? ` 🔄` : ``;
        msg += `
  ${startIdx + i + 1}. ${label}${busy}`;
        btns2.push({ text: `${startIdx+i+1}`, data: `s:${startIdx+i}` });
      });
    }

    if (platform === `telegram` && btns2.length > 0) {
      cacheSet(chatId, { sessions: displayHistory2, activeCount: active.length, projectName: group.project_name });
      await rp(msg, telegram.buildInlineKeyboard(btns2, 4));
    } else {
      msg += `

或直接说 @会话名 <消息>`;
      await rp(msg);
    }
    return;
  }

  const sessionName = atMatch[1];
  const message = atMatch[2];

  if (message === 'stop') {
    const s = getSessionByName(chatId, sessionName);
    if (s) { updateSessionStatus(s.id, 'idle'); await rp(`⏹ 已中断 @${sessionName}`); }
    return;
  }
  if (message === 'done') {
    const s = getSessionByName(chatId, sessionName);
    if (s) { updateSessionStatus(s.id, 'ended'); await rp(`✅ 已结束 @${sessionName}`); }
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
  const pf = group?.platform || 'wecom';
  // ===== @bridge:ask — 双向通信 =====
  // 要求行首匹配，防止 Claude 输出中提及 @bridge:ask 被误触发
  const askMatch = output.match(/(?:^|\n)@bridge:ask\s+(\S+)\s+([\s\S]+)/);
  if (askMatch) {
    const [, targetName, askMsg] = askMatch;
    const cleanAskMsg = askMsg.trim();
    if (!cleanAskMsg) return null;

    const targetSession = await resolveTargetSession(chatId, targetName, group);
    if (!targetSession) {
      await reply(chatId, userId, `❌ Bridge: 未找到目标会话 "${targetName}"`, pf);
      return { handled: true };
    }

    const sourceSession = getSessionByName(chatId, sourceName);
    const sourceUuid = sourceSession?.claude_session_id || '';

    await reply(chatId, userId, `🔗 @${sourceName} → @${targetName} (ask)\n⏳ @${targetName} 处理中...`, pf);

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
        await reply(chatId, userId, `🔗 @${targetName} → @${sourceName} (reply)\n⏳ @${sourceName} 整合中...`, pf);

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

        await reply(chatId, userId, `✅ @${sourceName} 完成:\n${aOutput}`, pf);
      } else {
        // 源会话无 UUID（新创建），直接展示 B 的回复
        await reply(chatId, userId, `🔗 @${targetName} 回复:\n${bOutput}`, pf);
      }
    } catch (err) {
      await reply(chatId, userId, `❌ Bridge ask → @${targetName}: ${err.message.slice(0, 300)}`, pf);
    }
    return { handled: true };
  }

  // ===== @bridge:notify — 单向通知（现有逻辑） =====
  // 要求行首匹配
  const match = output.match(/(?:^|\n)@bridge:notify\s+(\S+)\s+([\s\S]+)/);
  if (!match) return null;

  const [, targetName, bridgeMsg] = match;
  const cleanMsg = bridgeMsg.trim();
  if (!cleanMsg) return null;

  const targetSession = await resolveTargetSession(chatId, targetName, group);

  if (!targetSession) {
    await reply(chatId, userId, `❌ Bridge: 未找到目标会话 "${targetName}"`, pf);
    return { handled: true };
  }

  await reply(chatId, userId, `🔗 @${sourceName} → @${targetName}\n⏳ 处理中...`, pf);

  try {
    const notifyMsg = `[bridge:notify from @${sourceName}] ${cleanMsg}`;
    const result = await execClaude(
      targetSession.claude_session_id, notifyMsg,
      { cwd: group.project_path }
    );
    const targetOutput = (result.stdout || result.stderr || '(无输出)').slice(0, 3800);
    await reply(chatId, userId, `🔗 @${targetName}:\n${targetOutput}`, pf);
    auditLog(chatId, targetSession.id, 'out', targetOutput);
    touchSession(targetSession.id);
    if (result.newSessionId) updateClaudeSessionId(targetSession.id, result.newSessionId);

    // 公开记录 B 的 notify 执行
    recordChronicle(group.project_path, targetName, 'in', `[bridge:notify from @${sourceName}] ${cleanMsg}`, 'bridge');
    recordChronicle(group.project_path, targetName, 'out', targetOutput, 'bridge');
  } catch (err) {
    await reply(chatId, userId, `❌ Bridge → @${targetName}: ${err.message.slice(0, 300)}`, pf);
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
  const pf = group?.platform || 'wecom';

  markBusy(sessionId, claudeSid);
  try {
    await reply(task.chat_id, task.sender, `📤 @${sessionName} 排队任务开始执行...`, pf);
    const result = await execClaude(claudeSid, task.message, { cwd: group.project_path });
    const output = (result.stdout || result.stderr || '(无输出)').slice(0, 3800);
    auditLog(chatId, sessionId, 'out', output);

    if (s) {
      touchSession(s.id);
      if (result.newSessionId) updateClaudeSessionId(s.id, result.newSessionId);
    }

    await reply(task.chat_id, task.sender, `Claude·${sessionName}:\n${output}`, pf);
  } catch (err) {
    await reply(task.chat_id, task.sender, `❌ 排队任务失败: ${err.message.slice(0, 200)}`, pf);
  } finally {
    markTaskProcessed(task.id);
    markIdle(sessionId, claudeSid);
    // 递归处理下一个排队任务
    await drainSessionQueue(chatId, sessionId, group);
  }
}

// TG 预览分页渲染（msgId 存在则原地编辑，否则发新消息）
async function renderPreviewPage(chatId, userId, num, page, detail, platform, msgId) {
  const allRounds = detail.allRounds;
  const perPage = 2;
  const totalPages = Math.ceil(allRounds.length / perPage);
  const p = Math.max(0, Math.min(page, totalPages - 1));
  const start = allRounds.length - (p + 1) * perPage;
  const end = allRounds.length - p * perPage;
  const pageRounds = allRounds.slice(Math.max(0, start), end);

  let msg = `📋 会话预览 #${num}`;
  if (detail.sessionName) msg += ` — ${detail.sessionName}`;
  msg += `\n📅 ${detail.date} | 👤 ${detail.userCount}条 | 🤖 ${detail.assistantCount}条`;
  msg += `\n📏 ${(detail.size / 1024).toFixed(0)}KB | 共${detail.totalLines}行 | 页 ${p + 1}/${totalPages}`;

  // 话题（仅首页显示）
  if (p === 0 && detail.topicMsgs && detail.topicMsgs.length > 0) {
    msg += `\n\n💬 话题：`;
    for (const t of detail.topicMsgs) msg += `\n  · ${t.slice(0, 120)}`;
  }

  // 当前页的轮次
  if (pageRounds.length > 0) {
    msg += `\n\n📝 轮次：`;
    for (const r of pageRounds) {
      msg += `\n  👤 ${r.user.slice(0, 300)}`;
      if (r.assistant) msg += `\n  🤖 ${r.assistant.slice(0, 300)}`;
      msg += '\n  ---';
    }
  }

  // 导航按钮
  const navBtns = [];
  if (p > 0) navBtns.push({ text: '◀ 上一页', data: `v:${num}:${p - 1}` });
  navBtns.push({ text: `${p + 1}/${totalPages}`, data: 'v:noop' });
  if (p < totalPages - 1) navBtns.push({ text: '下一页 ▶', data: `v:${num}:${p + 1}` });
  const row2 = [{ text: `回复 ${num} 接入`, data: `s:${num - 1}` }, { text: '🔙 返回列表', data: '/list' }];
  const kb = telegram.buildInlineKeyboard([navBtns, row2], navBtns.length);

  if (msgId) {
    await telegram.editMessageText(chatId, msgId, msg.slice(0, 4000), kb);
  } else {
    const sent = await telegram.sendMessage(chatId, msg.slice(0, 4000), { replyMarkup: kb });
    if (sent?.message_id) trackKeyboardMsg(sent.message_id, chatId);
  }
}

// TG 按钮选择会话
async function selectSessionByIndex(chatId, userId, idx, cached, group) {
  const active = getActiveSessions(chatId);
  const activeCount = cached.activeCount || 0;
  // 清理旧活跃会话
  for (const s of active) updateSessionStatus(s.id, 'ended');

  // 活跃中
  if (idx < activeCount && idx < active.length) {
    const s = active[idx];
    updateSessionStatus(s.id, 'active');
    await reply(chatId, userId, `📋 @${s.session_name} (${s.message_count}轮)\n发消息继续对话`, 'telegram');
    return;
  }
  // 历史
  const histIdx = idx - activeCount;
  if (histIdx >= 0 && histIdx < cached.sessions.length) {
    const h = cached.sessions[histIdx];
    const label = h.summary || h.name || h.date || h.id.slice(0, 8);
    createSession(chatId, label.slice(0, 25), '');
    const s = getSessionByName(chatId, label.slice(0, 25));
    if (s) updateClaudeSessionId(s.id, h.id);
    await reply(chatId, userId, `📋 ${label.slice(0, 25)}\n已接入，发消息继续对话`, 'telegram');
    return;
  }
  await reply(chatId, userId, '❌ 会话序号已过期，请重新发送「列表」', 'telegram');
}

async function handleSessionMessage(chatId, userId, existingSession, message, group, sessionName) {
  const pf = group?.platform || 'wecom';
  const online = await healthCheck();
  if (!online) {
    enqueueTask(chatId, existingSession?.id || null, message, userId);
    await reply(chatId, userId, '💻 主力机离线。任务已排队。', pf);
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
    await reply(chatId, userId, `📥 @${name} 正在处理中，消息已排队（稍后自动执行）`, pf);
    return;
  }
  if (s) markBusy(s.id, s.claude_session_id);

  // TG: 发"处理中"带[停止]按钮，存 msgId 以便完成后原地编辑
  let tgPendingMsgId = null;
  if (pf === 'telegram') {
    const stopKb = telegram.buildInlineKeyboard([[{ text: '⏹ 停止', data: 'x:stop' }]], 1);
    const sent = await telegram.sendMessage(chatId, `Claude·${name}:\n⏳ 处理中...`, { replyMarkup: stopKb });
    tgPendingMsgId = sent?.message_id;
    if (tgPendingMsgId) { const c3 = cacheGet(chatId) || {}; c3._pendingMsgId = tgPendingMsgId; cacheSet(chatId, c3); trackKeyboardMsg(tgPendingMsgId, chatId); }
  } else {
    await reply(chatId, userId, `Claude·${name}:\n⏳ 处理中...`, pf);
  }

  try {
    let result;
    // ── TG 流式：NDJSON 逐行驱动 TG 消息原地刷新 ──
    if (pf === 'telegram') {
      let accumulated = '';
      let lastEditTime = 0;
      let streamReq = null;
      const EDIT_DEBOUNCE = 500; // ms，节流 TG 编辑

      const editLive = async (text, markup) => {
        if (!tgPendingMsgId) return;
        const now = Date.now();
        if (markup) { lastEditTime = 0; } // 权限键盘立即刷
        if (now - lastEditTime < EDIT_DEBOUNCE) return;
        lastEditTime = now;
        await telegram.editMessageText(chatId, tgPendingMsgId, text, markup || null, true).catch(() => {});
      };

      result = await new Promise((resolve) => {
        streamReq = execClaudeStream(claudeSid, message, { cwd: group.project_path, platform: 'telegram' }, {
          onChunk(text) {
            accumulated += text;
            // 只显示末尾 ~3500 字符（TG 上限 4096）
            const display = accumulated.length > 3500
              ? `...${accumulated.slice(-3500)}`
              : accumulated;
            editLive(`Claude·${name}:\n${display}\n\n⏳ 生成中...`);
          },
          onPermission(evt) {
            resolve({ status: 'permission_needed', pendingSessionId: evt.pendingSessionId, stdout: evt.stdout, stderr: evt.stderr || '' });
          },
          onDone(evt) {
            resolve({
              status: evt.status || 'completed',
              stdout: evt.stdout || accumulated || '',
              stderr: evt.stderr || '',
              code: evt.code || 0,
              newSessionId: evt.newSessionId || null,
            });
          },
        });
        if (s) streamReqs.set(s.id, streamReq);
      });
      if (s) streamReqs.delete(s.id);

      // ── TG 权限交互 ──
      if (result.status === 'permission_needed') {
        tgPermissionState.set(chatId, {
          pendingSessionId: result.pendingSessionId,
          sessionName: name,
          tgPendingMsgId,
          group,
          s,
          existingSession,
          isNew,
          accumulatedOutput: result.stdout,
          claudeSid,
          permissionCount: 1,
        });
        const permKb = telegram.buildInlineKeyboard([
          [{ text: '✅ 批准', data: 'y:ok' }, { text: '❌ 拒绝', data: 'n:no' }],
          [{ text: '⏹ 停止', data: 'x:stop' }],
        ], 2);
        const tail = (result.stdout || '').slice(-1500);
        if (tgPendingMsgId) {
          await telegram.editMessageText(chatId, tgPendingMsgId, `Claude·${name}:\n${tail}\n\n_需要你的批准_`, permKb, false);
        }
        return; // 不释放锁 —— 等待用户按钮响应
      }

      const fullOutput = result.stdout || result.stderr || '(无输出)';
      const output = fullOutput.slice(0, 3800);
      auditLog(chatId, existingSession?.id || null, 'out', output);

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

      const bridgeResult = await bridgeRoute(chatId, userId, fullOutput, group, name);
      if (bridgeResult?.handled) { if (s) { markIdle(s.id, s.claude_session_id); drainSessionQueue(chatId, s.id, group).catch(e => console.error('Session drain error:', e)); } return; }

      // 最终编辑：去掉"生成中"后缀
      if (tgPendingMsgId && s && !isBusy(s.id)) {
        await telegram.editMessageText(chatId, tgPendingMsgId, `Claude·${name}:\n${output}\n\n⏹ 已中断`, null, true);
      } else if (tgPendingMsgId) {
        await telegram.editMessageText(chatId, tgPendingMsgId, `Claude·${name}:\n${output}`, null, true);
      } else {
        await reply(chatId, userId, `Claude·${name}:\n${output}`, pf);
      }
      // 释放锁 + 排空队列
      if (s) {
        markIdle(s.id, s.claude_session_id);
        drainSessionQueue(chatId, s.id, group).catch(e => console.error('Session drain error:', e));
      }
      return;
    }

    // ── 非 TG（企微）：一次性全部输出 ──
    result = await execClaude(claudeSid, message, { cwd: group.project_path, platform: pf });
    const fullOutput = result.stdout || result.stderr || '(无输出)';
    const output = fullOutput.slice(0, 3800);
    auditLog(chatId, existingSession?.id || null, 'out', output);

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

    const bridgeResult = await bridgeRoute(chatId, userId, fullOutput, group, name);
    if (bridgeResult?.handled) return;

    await reply(chatId, userId, `Claude·${name}:\n${output}`, pf);
  } catch (err) {
    if (pf === 'telegram' && tgPendingMsgId) {
      await telegram.editMessageText(chatId, tgPendingMsgId, `Claude·${name}:\n❌ ${err.message.slice(0, 500)}`, null, true);
    } else {
      await reply(chatId, userId, `Claude·${name}:\n❌ ${err.message.slice(0, 500)}`, pf);
    }
  } finally {
    // 🔓 释放锁 + 排空队列（TG 在内部 return 前已手动释放）
    if (pf !== 'telegram' && s) {
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
      handleMessage(msg.ChatId || userId, userId, msg.Text?.Content || msg.Content, 'wecom')
        .catch(err => console.error('Handle error:', err));
    }
  } catch (err) { console.error('Webhook error:', err.message); }
  res.send('success');
});

// ========== Telegram Webhook ==========
// TG 通过 Cloudflare Tunnel 推送消息，明文 JSON，无需加解密
app.post(config.telegram.webhookPath, express.json(), async (req, res) => {
  res.sendStatus(200); // 立即 ack，防止 TG 重试
  try {
    const update = req.body;
    // 处理 inline keyboard callback
    if (update.callback_query) {
      const cq = update.callback_query;
      if (!cq.message || !cq.from) return; // 消息已被删除或非聊天回调
      const chatId = String(cq.message.chat.id);
      const userId = String(cq.from.id);
      const data = cq.data;
      const msgId = cq.message.message_id;
      // ack callback query
      telegram.answerCallbackQuery(cq.id, '').catch(() => {});
      // 把回调消息 ID 存到缓存（预览翻页用）
      const existingCache = cacheGet(chatId) || {};
      existingCache._previewMsgId = msgId;
      cacheSet(chatId, existingCache);
      // 非翻页回调：移除原消息键盘
      if (!data.startsWith('v:')) {
        telegram.editMessageReplyMarkup(chatId, msgId, {}).catch(() => {});
      }
      await handleMessage(chatId, userId, data, 'telegram');
      return;
    }
    // 普通文本消息
    const msg = update.message || update.edited_message;
    if (!msg || !msg.text || !msg.chat || !msg.from) return;
    const chatId = String(msg.chat.id);
    const userId = String(msg.from.id);
    // 群聊中 @bot 或 /command@bot 前缀剥离
    let text = msg.text;
    if (msg.chat.type !== 'private') {
      text = text.replace(/^\/\w+(@\w+)?\s*/, '').replace(/^@\w+\s*/, '').trim() || msg.text;
    }
    await handleMessage(chatId, userId, text, 'telegram');
  } catch (err) {
    console.error('TG webhook error:', err.message);
  }
});

async function getPublicIp() {
  const http = require('http');
  // icanhazip.com
  try {
    return await new Promise((resolve, reject) => {
      const req = http.get({ hostname: 'ipv4.icanhazip.com', family: 4 }, res => {
        let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(d.trim()));
      });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    });
  } catch {}
  // fallback: ifconfig.me
  try {
    return await new Promise((resolve, reject) => {
      const req = http.get({ hostname: 'ifconfig.me', path: '/ip', family: 4 }, res => {
        let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(d.trim()));
      });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    });
  } catch {}
  return 'unknown';
}

app.get('/health', async (req, res) => {
  const publicIp = await getPublicIp();
  res.json({ status: 'ok', publicIp });
});

// POST /api/bridge/ask — 会话给会话发消息的标准入口（对称：发起和回复走同一个 API）
// 调此接口 → 立刻返回 → Gateway 异步驱动目标会话 → 企微可见
app.post('/api/bridge/ask', express.json(), async (req, res) => {
  const { projectPath, sourceName, targetName, targetSessionId, message } = req.body;
  if (!projectPath || !sourceName || !targetName || !message) {
    return res.status(400).json({ error: 'projectPath, sourceName, targetName, message required' });
  }

  const chatRow = dbGetChatId();
  if (!chatRow) return res.status(404).json({ error: 'no chat — send a message first' });
  const chatId = chatRow.chat_id;
  const pf = getGroupPlatform(chatId) || 'wecom';
  const cwd = projectPath.replace(/\//g, '\\');

  // 立刻返回，调用方结束本轮
  res.json({ status: 'queued', note: `@${sourceName} → @${targetName}` });

  // 异步驱动目标会话
  (async () => {
    try {
      await reply(chatId, chatId, `🔗 @${sourceName} → @${targetName}\n⏳ 处理中...`, pf);

      markBusy(0, targetSessionId); // 用 UUID 追踪（DB id 为 placeholder）
      const bMessage = `[bridge:from=${sourceName}] ${message}`;
      const bResult = await execClaude(targetSessionId, bMessage, { cwd });
      const bOutput = (bResult.stdout || bResult.stderr || '(无输出)').slice(0, 3800);
      markIdle(0, targetSessionId);

      await reply(chatId, chatId, `✅ @${targetName}:\n${bOutput}`, pf);
    } catch (err) {
      markIdle(0, targetSessionId);
      await reply(chatId, chatId, `❌ @${sourceName} → @${targetName}: ${err.message.slice(0, 300)}`, pf);
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
        const pf = group?.platform || 'wecom';
        const ts = task.session_id ? getSessionById(task.session_id) : null;
        if (ts) markBusy(task.session_id, ts.claude_session_id);
        await reply(task.chat_id, task.sender, `📤 重试排队任务...`, pf);
        const result = await execClaude(null, task.message, { cwd: group.project_path });
        const output = (result.stdout || result.stderr || '(无输出)').slice(0, 3800);
        await reply(task.chat_id, task.sender, output, pf);
      } catch (err) {
        console.error(`Drain task ${task.id} failed:`, err.message);
        await reply(task.chat_id, task.sender, `❌ 排队任务失败: ${err.message.slice(0, 200)}`, group?.platform || 'wecom');
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

app.listen(config.port, '0.0.0.0', () => {
  console.log(`Claude-Bridge Gateway on 0.0.0.0:${config.port}`);
  // 启动时注册 TG webhook（异步，不阻塞）
  if (config.telegram?.botToken) {
    telegram.setWebhook('https://claude-tunnel.mote-pal.xyz').catch(() => {});
  }
});
