const crypto = require('crypto');
const axios = require('axios');
const { parseStringPromise, Builder } = require('xml2js');

let config;

function init(cfg) {
  config = cfg.wecom;
}

// === AES 解密（企业微信回调消息） ===
function decrypt(encryptText) {
  const key = Buffer.from(config.encodingAESKey + '=', 'base64');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, key.slice(0, 16));
  decipher.setAutoPadding(false);
  let decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptText, 'base64')),
    decipher.final(),
  ]);

  // 去掉 PKCS#7 padding
  const padLen = decrypted[decrypted.length - 1];
  decrypted = decrypted.slice(0, decrypted.length - padLen);

  // 去掉 16 字节随机串 + 4 字节网络序 msg_len
  const content = decrypted.slice(20);
  const msgLen = decrypted.readUInt32BE(16);
  const msg = content.slice(0, msgLen);
  const corpId = content.slice(msgLen).toString('utf8');

  return { message: msg.toString('utf8'), corpId };
}

// === 验证签名 ===
function verifySignature(timestamp, nonce, encryptText) {
  const arr = [config.token, timestamp, nonce, encryptText].sort();
  const str = arr.join('');
  return crypto.createHash('sha1').update(str).digest('hex');
}

// === 验证回调 URL（GET 请求） ===
function verifyUrl(timestamp, nonce, echostr, msgSignature) {
  const sig = verifySignature(timestamp, nonce, echostr);
  if (sig !== msgSignature) {
    throw new Error('Signature verification failed');
  }
  const { message } = decrypt(echostr);
  return message;
}

// === 解密回调消息（POST 请求） ===
async function decryptMessage(xmlBody, msgSignature, timestamp, nonce) {
  const parsed = await parseStringPromise(xmlBody, { explicitArray: false });
  const encryptText = parsed.xml.Encrypt;
  const sig = verifySignature(timestamp, nonce, encryptText);
  if (sig !== msgSignature) {
    throw new Error('Signature verification failed');
  }
  const { message } = decrypt(encryptText);
  return await parseStringPromise(message, { explicitArray: false });
}

// === 获取 access_token ===
let accessToken = null;
let tokenExpires = 0;

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpires) {
    return accessToken;
  }
  const res = await axios.get('https://qyapi.weixin.qq.com/cgi-bin/gettoken', {
    params: { corpid: config.corpid, corpsecret: config.corpsecret },
  });
  if (res.data.errcode !== 0) {
    throw new Error(`gettoken failed: ${res.data.errmsg}`);
  }
  accessToken = res.data.access_token;
  tokenExpires = Date.now() + (res.data.expires_in - 300) * 1000;
  return accessToken;
}

// === 发送消息到群聊 ===
async function sendMessage(chatId, content, options = {}) {
  const token = await getAccessToken();
  const body = {
    touser: options.touser,
    toparty: options.toparty,
    totag: options.totag,
    msgtype: 'text',
    agentid: config.agentid,
    text: { content },
    safe: 0,
  };

  // 群聊消息：不设 touser 则用 chatid 发送
  if (chatId && !options.touser) {
    body.chatid = chatId;
  }

  const res = await axios.post(
    `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`,
    body
  );
  if (res.data.errcode !== 0) {
    throw new Error(`send message failed: ${res.data.errmsg}`);
  }
  return res.data;
}

// === 发送 Markdown 消息（支持更丰富的格式） ===
async function sendMarkdown(chatId, content) {
  const token = await getAccessToken();
  const body = {
    chatid: chatId,
    msgtype: 'markdown',
    agentid: config.agentid,
    markdown: { content },
    safe: 0,
  };
  const res = await axios.post(
    `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`,
    body
  );
  return res.data;
}

module.exports = {
  init,
  verifyUrl,
  decryptMessage,
  getAccessToken,
  sendMessage,
  sendMarkdown,
};
