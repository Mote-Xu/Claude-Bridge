const { NodeSSH } = require('node-ssh');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const config = require('./config');

class SessionManager extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.ssh = new NodeSSH();
    this.connected = false;
    this.tailProcesses = new Map(); // sessionId → { chatId, tailStream }
  }

  async connect() {
    if (this.connected) return;
    const { local } = config;
    await this.ssh.connect({
      host: local.host,
      username: local.username,
      privateKey: fs.readFileSync(local.privateKey, 'utf8'),
      readyTimeout: 10000,
    });
    this.connected = true;
    console.log(`SSH connected to ${local.host}`);
  }

  async disconnect() {
    if (!this.connected) return;
    this.stopAllTails();
    this.ssh.dispose();
    this.connected = false;
  }

  // === 健康检查 ===
  async isLocalOnline() {
    try {
      const result = await this.ssh.execCommand('echo ok', { timeout: 5000 });
      return result.stdout.trim() === 'ok';
    } catch {
      return false;
    }
  }

  // === 列出项目 ===
  async listProjects() {
    const projects = config.projects;
    const result = [];
    for (const [name, projectPath] of Object.entries(projects)) {
      try {
        const r = await this.ssh.execCommand(
          `ls ${path.join(projectPath, 'CLAUDE.md')} 2>/dev/null && echo "EXISTS" || echo "NO_CLAUDEMD"`
        );
        const hasClaudeMd = r.stdout.includes('EXISTS');
        result.push({ name, path: projectPath, hasClaudeMd });
      } catch {
        result.push({ name, path: projectPath, hasClaudeMd: false });
      }
    }
    return result;
  }

  // === 列出项目的 Claude Code 会话 ===
  async listClaudeSessions(projectPath) {
    try {
      // 读 Claude Code 的 projects 目录，找到对应项目
      const r = await this.ssh.execCommand(
        `find ~/.claude/projects/ -name "*.json" -exec grep -l "${projectPath}" {} \\; 2>/dev/null`
      );
      const projectFile = r.stdout.trim().split('\n')[0];
      if (!projectFile) return [];

      const cat = await this.ssh.execCommand(`cat ${projectFile}`);
      const data = JSON.parse(cat.stdout);
      return (data.sessions || []).map(s => ({
        id: s.id,
        updatedAt: s.updatedAt,
        summary: s.summary || '(无标题)',
      }));
    } catch {
      return [];
    }
  }

  // === 创建/恢复 tmux session ===
  async createTmuxSession(sessionSlug, projectPath, claudeSessionId) {
    const { local } = config;

    // 确保管道目录存在
    await this.ssh.execCommand(`mkdir -p ${local.pipeDir}`);

    const pipeFile = path.join(local.pipeDir, `${sessionSlug}.log`);
    const tmuxCmd = [
      // 新建 tmux session（使用独立 socket 避免冲突）
      `tmux -S ${local.tmuxSocket} new-session -d -s ${sessionSlug}`,
      `tmux -S ${local.tmuxSocket} send-keys -t ${sessionSlug} 'cd ${projectPath} && clear' Enter`,
    ];

    if (claudeSessionId) {
      // 恢复历史会话
      tmuxCmd.push(
        `tmux -S ${local.tmuxSocket} send-keys -t ${sessionSlug} 'claude --resume ${claudeSessionId} 2>&1 | tee ${pipeFile}' Enter`
      );
    } else {
      // 新建会话
      tmuxCmd.push(
        `tmux -S ${local.tmuxSocket} send-keys -t ${sessionSlug} 'claude 2>&1 | tee ${pipeFile}' Enter`
      );
    }

    const cmd = tmuxCmd.join(' ; ');
    const result = await this.ssh.execCommand(cmd);
    if (result.code !== 0 && result.stderr) {
      throw new Error(`tmux create failed: ${result.stderr}`);
    }

    // 等 Claude Code 初始化
    await sleep(config.claude.warmupSeconds * 1000);

    return { pipeFile, tmuxWindow: sessionSlug };
  }

  // === 发送消息到 tmux session ===
  async sendToSession(sessionSlug, message) {
    const { local } = config;
    // 转义单引号防止 shell 解析
    const escaped = message.replace(/'/g, "'\\''");
    const result = await this.ssh.execCommand(
      `tmux -S ${local.tmuxSocket} send-keys -t ${sessionSlug} '${escaped}' Enter`
    );
    return result.code === 0;
  }

  // === 中断 session ===
  async interruptSession(sessionSlug) {
    const { local } = config;
    const result = await this.ssh.execCommand(
      `tmux -S ${local.tmuxSocket} send-keys -t ${sessionSlug} C-c`
    );
    return result.code === 0;
  }

  // === 关闭 session ===
  async killSession(sessionSlug) {
    const { local } = config;
    await this.ssh.execCommand(
      `tmux -S ${local.tmuxSocket} send-keys -t ${sessionSlug} C-d ; sleep 1 ; tmux -S ${local.tmuxSocket} kill-session -t ${sessionSlug} 2>/dev/null`
    );
    // 清理管道文件
    await this.ssh.execCommand(`rm -f ${path.join(local.pipeDir, `${sessionSlug}.log`)} 2>/dev/null`);
  }

  // === 开始 tail 管道文件（流式输出） ===
  startTail(sessionSlug, chatId, sessionId, onOutput) {
    const { local } = config;
    const pipeFile = path.join(local.pipeDir, `${sessionSlug}.log`);

    // 先 touch 文件确保存在
    this.ssh.execCommand(`touch ${pipeFile}`).catch(() => {});

    // 用 tail -f 持续读取
    const tailCmd = `tail -f -n 0 ${pipeFile} 2>/dev/null`;

    // 通过 SSH exec 启动 tail，监听 stdout
    this.ssh.execCommand(tailCmd, {
      onStdout: (chunk) => {
        onOutput(chatId, sessionId, chunk.toString());
      },
      onStderr: () => {},
    }).then(() => {
      // tail 退出（session 被关闭或管道被删）
      this.tailProcesses.delete(sessionSlug);
    }).catch(() => {
      this.tailProcesses.delete(sessionSlug);
    });

    this.tailProcesses.set(sessionSlug, { chatId, sessionId });
  }

  stopTail(sessionSlug) {
    // tail -f 进程会在 ssh exec 结束时自动退出
    // 这里只需要清理引用
    this.tailProcesses.delete(sessionSlug);
  }

  stopAllTails() {
    for (const [slug] of this.tailProcesses) {
      this.tailProcesses.delete(slug);
    }
  }

  // === 获取 tmux capture-pane（弹窗盲操） ===
  async capturePane(sessionSlug) {
    const { local } = config;
    const result = await this.ssh.execCommand(
      `tmux -S ${local.tmuxSocket} capture-pane -t ${sessionSlug} -p -S -20`
    );
    return result.stdout;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = SessionManager;
