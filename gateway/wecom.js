const crypto = require('crypto');
const axios = require('axios');
const { parseStringPromise } = require('xml2js');

let config;

function init(cfg) {
  config = cfg.wecom;
}

function decrypt(encryptText) {
  const key = Buffer.from(config.encodingAESKey + '=', 'base64');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, key.slice(0, 16));
  decipher.setAutoPadding(false);
  let decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptText, 'base64')),
    decipher.final(),
  ]);
  const padLen = decrypted[decrypted.length - 1];
  decrypted = decrypted.slice(0, decrypted.length - padLen);
  const content = decrypted.slice(20);
  const msgLen = decrypted.readUInt32BE(16);
  const msg = content.slice(0, msgLen);
  return { message: msg.toString('utf8') };
}

function verifySignature(timestamp, nonce, encryptText) {
  const arr = [config.token, timestamp, nonce, encryptText].sort();
  return crypto.createHash('sha1').update(arr.join('')).digest('hex');
}

function verifyUrl(timestamp, nonce, echostr, msgSignature) {
  const sig = verifySignature(timestamp, nonce, echostr);
  if (sig !== msgSignature) throw new Error('Signature verification failed');
  const { message } = decrypt(echostr);
  return message;
}

async function decryptMessage(xmlBody, msgSignature, timestamp, nonce) {
  const parsed = await parseStringPromise(xmlBody, { explicitArray: false });
  const encryptText = parsed.xml.Encrypt;
  const sig = verifySignature(timestamp, nonce, encryptText);
  if (sig !== msgSignature) throw new Error('Signature verification failed');
  const { message } = decrypt(encryptText);
  return await parseStringPromise(message, { explicitArray: false });
}

let accessToken = null;
let tokenExpires = 0;

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpires) return accessToken;
  const res = await axios.get('https://qyapi.weixin.qq.com/cgi-bin/gettoken', {
    params: { corpid: config.corpid, corpsecret: config.corpsecret },
  });
  if (res.data.errcode !== 0) throw new Error(`gettoken: ${res.data.errmsg}`);
  accessToken = res.data.access_token;
  tokenExpires = Date.now() + (res.data.expires_in - 300) * 1000;
  return accessToken;
}

// 发消息：自动判断群聊还是私聊
async function sendMessage(targetId, senderId, text) {
  const token = await getAccessToken();
  const body = {
    msgtype: 'text',
    agentid: config.agentid,
    text: { content: text },
    safe: 0,
  };
  // targetId 可能是 ChatId（群聊）也可能是和 senderId 相同（私聊）
  // 私聊时 ChatId 为空或等于 UserId
  if (!targetId || targetId === senderId) {
    body.touser = senderId;
  } else {
    body.chatid = targetId;
    body.touser = senderId;  // 群聊里也要指定接收方
  }
  const res = await axios.post(
    `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`,
    body
  );
  if (res.data.errcode !== 0) {
    throw new Error(`send failed: ${res.data.errmsg} (code ${res.data.errcode})`);
  }
  return res.data;
}

module.exports = { init, verifyUrl, decryptMessage, sendMessage };
