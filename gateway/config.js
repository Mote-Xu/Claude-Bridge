// Claude-Bridge Gateway 配置
// 敏感信息从环境变量或 .env 文件读取，不写入代码

module.exports = {
  // Gateway 监听
  port: process.env.BRIDGE_PORT || 8933,

  // 企业微信 Bot 配置
  wecom: {
    corpid: process.env.WECOM_CORP_ID || '',
    corpsecret: process.env.WECOM_CORP_SECRET || '',
    agentid: process.env.WECOM_AGENT_ID || '1000003',
    token: process.env.WECOM_TOKEN || '',
    encodingAESKey: process.env.WECOM_AES_KEY || '',
  },

  // Windows Agent
  agent: {
    host: process.env.AGENT_HOST || '100.80.205.79',
    port: parseInt(process.env.AGENT_PORT) || 9877,
    timeout: parseInt(process.env.AGENT_TIMEOUT) || 10000,
  },

  // 数据库
  dbPath: process.env.BRIDGE_DB_PATH || '/mnt/data/claude-bridge/bridge.db',
};
