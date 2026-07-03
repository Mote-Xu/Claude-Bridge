// clawd Gateway 配置
// 部署到 mote-home 后根据实际值修改

module.exports = {
  // Gateway 监听
  port: 8933,

  // 企业微信 Bot 配置（从企业微信管理后台获取）
  wecom: {
    corpid: 'YOUR_CORP_ID',
    corpsecret: 'YOUR_CORP_SECRET',
    agentid: 'YOUR_AGENT_ID',
    token: 'YOUR_TOKEN',
    encodingAESKey: 'YOUR_AES_KEY',
  },

  // Windows Agent
  agent: {
    host: '100.80.205.79',       // Windows Tailscale IP
    port: 9877,
    timeout: 10000,
  },

  // 数据库
  dbPath: '/mnt/data/clawd/clawd.db',
};
