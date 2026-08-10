// Telegram Bot 通道 — 对标 wecom.js，无加解密（TG 明文 JSON）
const axios = require('axios');

let botToken, webhookPath, proxyUrl;

function init(cfg) {
  botToken = cfg.telegram?.botToken || '';
  webhookPath = cfg.telegram?.webhookPath || '/telegram-webhook';
  proxyUrl = cfg.telegram?.proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
}

// ========== axios 实例 ==========

function getClient() {
  const opts = { timeout: 15000 };
  if (proxyUrl) {
    // 解析 proxy URL: http://host:port
    const m = proxyUrl.match(/https?:\/\/([^:]+):(\d+)/);
    if (m) opts.proxy = { host: m[1], port: parseInt(m[2]), protocol: 'http' };
  }
  return axios.create(opts);
}

// ========== 基础 API 调用 ==========

async function apiCall(method, body = null) {
  if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN not set');
  try {
    const res = await getClient().post(
      `https://api.telegram.org/bot${botToken}/${method}`,
      body || {}
    );
    if (!res.data.ok) throw new Error(`TG API ${method}: ${res.data.description || 'unknown error'}`);
    return res.data.result;
  } catch (err) {
    // axios throws on non-2xx; extract TG's own error description
    const tgDesc = err.response?.data?.description || '';
    if (tgDesc) throw new Error(`TG API ${method}: ${tgDesc}`);
    throw err;
  }
}

// ========== Webhook 管理 ==========

async function setWebhook(baseUrl) {
  if (!botToken) return;
  const url = `${baseUrl}${webhookPath}`;
  try {
    await apiCall('setWebhook', { url, allowed_updates: ['message', 'callback_query'] });
    console.log(`TG webhook set: ${url}`);
  } catch (err) {
    console.error('TG setWebhook failed:', err.message);
  }
  // 同时注册 Bot 命令菜单
  try {
    await apiCall('setMyCommands', {
      commands: [
        { command: 'projects', description: '📁 项目列表' },
        { command: 'list', description: '📋 会话列表' },
        { command: 'switch', description: '🔄 切换项目 (例: /switch home-lab)' },
        { command: 'status', description: '📊 查看执行状态' },
        { command: 'help', description: '❓ 帮助' },
        { command: 'hidden', description: '🙈 隐藏列表' },
        { command: 'leave', description: '🚪 退出当前项目' },
        { command: 'kill_vscode', description: '💻 关闭 VS Code' },
      ],
    });
    // 设置输入框旁的菜单按钮（显示命令列表）
    await apiCall('setChatMenuButton', {
      menu_button: { type: 'commands' },
    });
    console.log('TG commands + menu button registered');
  } catch (err) {
    console.error('TG setMyCommands failed:', err.message);
  }
}

async function getWebhookInfo() {
  return apiCall('getWebhookInfo');
}

// ========== 发送消息 ==========

// sendMessage(chatId, text, options)
// options: { replyMarkup, parseMode }
// 清理非法 UTF-8 / 控制字符（TG 拒绝 0x00-0x1F 除了 \t\n\r）
function sanitizeText(text) {
  // Strip C0 controls (except \t\n\r), C1 controls (0x80-0x9F), DEL,
  // Unicode noncharacters, and LONE surrogates (keep valid surrogate pairs = emoji)
  let s = String(text || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
  // Lone high surrogate (not followed by low surrogate)
  s = s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '');
  // Lone low surrogate (not preceded by high surrogate)
  s = s.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
  return s;
}

async function sendMessage(chatId, text, options = {}) {
  const useHtml = options.parseMode !== 'text'; // 默认 HTML
  const formatted = sanitizeText(useHtml ? markdownToHtml(text) : text);
  const body = {
    chat_id: chatId,
    text: formatted.slice(0, 4000),
    parse_mode: useHtml ? 'HTML' : '',
  };
  if (options.replyMarkup) body.reply_markup = options.replyMarkup;
  try {
    return await apiCall('sendMessage', body);
  } catch (err) {
    // HTML parse / UTF-8 错误 → 回退纯文本
    const msg = err.response?.data?.description || err.message || '';
    if (/UTF-8|cant.?parse|parse.?error|Bad Request/i.test(msg)) {
      console.error('[TG:SEND] First attempt failed:', msg, '| text hex sample:', Buffer.from(body.text.slice(0, 200)).toString('hex').slice(0, 200));
      body.parse_mode = '';
      body.text = sanitizeText(String(text)).slice(0, 4000);
      console.error('[TG:SEND] Retrying plain, text hex:', Buffer.from(body.text.slice(0, 200)).toString('hex').slice(0, 200));
      return apiCall('sendMessage', body);
    }
    throw err;
  }
}

// 编辑消息文本 + 键盘
async function editMessageText(chatId, messageId, text, replyMarkup, plainText) {
  const formatted = sanitizeText(plainText ? text : markdownToHtml(text));
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text: formatted.slice(0, 4000),
    parse_mode: plainText ? '' : 'HTML',
  };
  // null/undefined → 移除键盘；对象 → 设置键盘
  body.reply_markup = replyMarkup || { inline_keyboard: [] };
  return apiCall('editMessageText', body);
}

// 编辑消息键盘（用于更新 inline keyboard 状态）
async function editMessageReplyMarkup(chatId, messageId, replyMarkup) {
  return apiCall('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup,
  });
}

// 回复 callback query（关闭 loading 状态）
async function answerCallbackQuery(queryId, text) {
  return apiCall('answerCallbackQuery', { callback_query_id: queryId, text: sanitizeText(text || '') });
}

// ========== HTML 格式化 ==========

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 简单 Markdown → TG HTML（代码块 + 粗体 + 斜体 + 行内代码）
function markdownToHtml(text) {
  const parts = [];
  let remaining = text;
  // 代码块 ```...``` → <pre>...</pre>
  while (true) {
    const idx = remaining.indexOf('```');
    if (idx === -1) break;
    // 前面的文本
    if (idx > 0) parts.push({ type: 'text', content: remaining.slice(0, idx) });
    remaining = remaining.slice(idx + 3);
    // 找到结束的 ```
    const end = remaining.indexOf('```');
    if (end === -1) {
      // 没闭合，当普通文本
      parts.push({ type: 'text', content: '```' + remaining });
      remaining = '';
      break;
    }
    const code = remaining.slice(0, end);
    // 去掉开头的语言标识（如 "python\n"）
    const codeBody = code.replace(/^[a-zA-Z0-9_+#-]*\n?/, '');
    parts.push({ type: 'code', content: codeBody });
    remaining = remaining.slice(end + 3);
  }
  if (remaining) parts.push({ type: 'text', content: remaining });

  // 处理每段
  return parts.map(p => {
    if (p.type === 'code') {
      return '<pre>' + escapeHtml(p.content.trimEnd()) + '</pre>';
    }
    // 文本段：HTML 转义 + 粗体/斜体/行内代码
    let t = escapeHtml(p.content);
    t = t.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    t = t.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, '<i>$1</i>');
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    return t;
  }).join('\n');
}

// ========== Inline Keyboard 工具 ==========

// buttons: 二维 [[row1], [row2]] 或一维（自动每行 rowSize 个）
function buildInlineKeyboard(buttons, rowSize = 2) {
  if (!buttons || buttons.length === 0) return null;
  // Sanitize each button — TG rejects invalid UTF-8 in keyboard strings
  const cleanBtn = btn => ({
    text: sanitizeText(btn.text).slice(0, 64),
    callback_data: sanitizeText(btn.data).slice(0, 64),
  });
  if (Array.isArray(buttons[0])) {
    return {
      inline_keyboard: buttons.map(row => row.map(cleanBtn)),
    };
  }
  const rows = [];
  for (let i = 0; i < buttons.length; i += rowSize) {
    rows.push(buttons.slice(i, i + rowSize));
  }
  return {
    inline_keyboard: rows.map(row => row.map(cleanBtn)),
  };
}

function escapeMd(text) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

module.exports = {
  init, setWebhook, getWebhookInfo,
  sendMessage, editMessageText, editMessageReplyMarkup, answerCallbackQuery,
  buildInlineKeyboard, escapeMd, markdownToHtml, escapeHtml,
};
