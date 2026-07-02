// clawd Gateway 配置
// 部署到 mote-home 后根据实际值修改

module.exports = {
  // Gateway 监听
  port: 8933,

  // 企业微信 Bot 配置（从企业微信管理后台获取）
  wecom: {
    corpid: 'YOUR_CORP_ID',       // 企业 ID
    corpsecret: 'YOUR_CORP_SECRET', // 应用 Secret
    agentid: 'YOUR_AGENT_ID',     // 应用 AgentId
    token: 'YOUR_TOKEN',          // 回调 Token
    encodingAESKey: 'YOUR_AES_KEY', // 回调 EncodingAESKey
  },

  // chat_id 白名单（只有这些群/人能控制 clawd）
  whitelist: {
    // 格式：'群名或用户ID': true
    // 留空 = 所有消息都处理（开发阶段）
  },

  // 本地机器（WSL2）
  local: {
    host: '100.x.x.x',           // 本地机器 Tailscale IP（替换为实际值）
    username: 'mote',            // WSL2 用户名
    privateKey: '/home/mote/.ssh/id_rsa', // SSH 私钥路径
    tmuxSocket: '/tmp/clawd-tmux', // tmux socket 文件
    pipeDir: '/tmp/clawd/',      // Claude Code 输出管道目录
  },

  // 项目路径映射（群名 → 本地 WSL2 路径）
  projects: {
    // 示例：
    // 'Stardust_Chat': '/mnt/e/Desktop/Deepseek_V4_API/Stardust_Chat',
    // 'Mobile_Dev': '/mnt/e/Desktop/Mobile_Dev/Mobile_Development',
  },

  // Claude Code 相关
  claude: {
    // Claude Code 启动后的预热时间（秒）
    warmupSeconds: 5,
    // 单次会话费用上限（元）
    costLimit: 2.0,
  },

  // 会话管理
  session: {
    // 空闲超时（小时），超时后提醒清理
    idleTimeoutHours: 24,
    // 输出节流：每次最多连续发几条消息
    maxBurstMessages: 5,
    // 输出节流：批量间隔（毫秒）
    burstIntervalMs: 500,
  },

  // 数据库
  dbPath: '/mnt/data/clawd/clawd.db',
};
