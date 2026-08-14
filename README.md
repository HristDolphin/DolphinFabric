# DolphinFabric · 海豚编文台

> 思如泉涌，如浪逐波。

简约本地小说续写台 —— 适配 SillyTavern 生态的小说生成器：支持ollmam和在线API，WorldBook一键植入，自带Python环境。

## 特性

- **三模式续写**：支持chat/complete/completion多模式
- **世界书体系**：完全对齐 SillyTavern 原版语义（constant / selective / vector 三种触发模式，深度/位置/递归/激活预算全支持）
- **提示词工具**：风格预设、提示词条目（对齐 ST extension_prompt：role / position / depth）、上下文模板、参数面板
- **双后端**：本地 Ollama（零成本、隐私） + 在线 API（自定义 OpenAI 兼容端点）
- **长思考控制**：默认关闭思考，三模式 system 约束兜底，在线通道按模型名路由参数
- **安全闸门 SafeGate**：合规过滤保护你的API账户
- **移动端**：窄屏适配，移动端包含 Android APP（自动发现局域网服务）

## 快速开始

```bash
# 双击 启动_续写台.bat 即可（自带便携 Python，无需安装环境）
# 或手动启动：
python serve.py xietai --port 8000
```

浏览器打开 `http://127.0.0.1:8000/`。局域网/手机访问：启动时控制台会打印 `LAN/phone access: http://<本机IP>:8000/`。

### 本地模型

- 安装 [Ollama](https://ollama.com) 后 `ollama pull <模型>`（如 `qwen3:8b`）
- 局域网跨机访问需 `OLLAMA_HOST=0.0.0.0` 且 `OLLAMA_ORIGINS=*`

### 在线 API

密钥仅存本浏览器 localStorage（不建议在公共电脑使用）。

## 目录结构

```
├── serve.py            # 单文件后端：静态服务 + 数据 REST API + 在线代理
├── 续写台/             # 前端（原生 JS 单页应用，无构建步骤）
│   ├── index.html
│   ├── app.js
│   ├── config.js
│   └── styles.css
├── rules/              # SafeGate 哈希词库（三层：official / community / user）
├── tools/              # 词库构建工具
└── python/             # 便携 Python 运行时（可选）
```

## 安全与合规声明

本项目的 SafeGate 安全闸门功能用于**帮助使用者遵守所用 AI 服务的用户协议**：

- **仅在线模式生效**：量身打造的安全创作器
- **哈希词库**：仓库只分发不可逆哈希（blake2b-64bit），明文词表永不入库；用户可自建词库
- **条目粒度过滤**：命中违规特征的世界书条目等同关闭，不修改原数据，切回本地自动恢复
- **出站单向**：只做发送前的合规检查/脱敏，不审查模型输出，不做任何入站还原（无可逆编码规避）

合规机制不上传任何数据，全部检查在本地完成。

## 开源协议

[AGPL-3.0](LICENSE) —— 与 SillyTavern 相同的许可证。

修改并部署本软件向公众提供服务时，需以相同许可证开源你的修改版本。
