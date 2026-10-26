# DolphinFabric · 海豚编文台

> 思如泉涌，如浪逐波。

简约本地小说续写台 —— 适配 SillyTavern 生态的小说生成器：支持ollmam和在线API，WorldBook一键植入，自带Python环境。

## 下载

**Windows / Android 客户端都在本页右侧的 [Releases](https://github.com/HristDolphin/DolphinFabric/releases/latest) 栏下载**，取最新一版即可：

- `DolphinFabric.win-<版本>.zip` —— Windows 版，解压后双击 `启动_续写台.bat`（自带便携 Python，无需安装环境）
- `DolphinFabric-D4C-<版本>.apk` —— Android 客户端，覆盖安装即可，原有数据与已保存的密钥保留

当前版本：PC **26.67.11** ／ D4C **1.0.4**

## 特性

- **三模式续写**：支持chat/complete/completion多模式
- **世界书体系**：完全对齐 SillyTavern 原版语义（constant / selective / vector 三种触发模式，深度/位置/递归/激活预算全支持）
- **提示词工具**：风格预设、提示词条目（对齐 ST extension_prompt：role / position / depth）、上下文模板、参数面板
- **双后端**：本地 Ollama（零成本、隐私） + 在线 API（自定义 OpenAI 兼容端点）
- **长思考控制**：默认关闭思考，三模式 system 约束兜底，在线通道按模型名路由参数
- **在线 API 账号安全**：本地哈希规则过滤（默认开启、可自行关闭），保护你自己的 API 账号
- **移动端**：窄屏适配，Android APP D4C 1.0.4.apk新增支持密钥保管、自动发现、主动连接、更新检查等多个特性

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
├── python/             # 便携 Python 运行时（可选）
└── prefs.json          # 用户预设（系统提示词/风格预设/参数等），首次保存时自动生成
```

> 预设为何落在服务端：浏览器 `localStorage` 按 origin（协议+主机+端口）隔离，电脑 IP 被路由器重分或换端口后就是一份全新空存储（表现为预设被重置）。因此预设以服务端 `prefs.json` 为准，`localStorage` 仅作离线兜底。

### 预设数据（服务端权威）

- **唯一权威源 = 服务端 `prefs.json`**：系统提示词 / 风格预设 / 提示词条目 / 参数等，换 IP、换端口、换浏览器都不丢
- 浏览器本地残留会被标记为**浏览器版本预设**（高亮边框），可**单条提交到服务器**或**一键清空**；**绝不自动覆盖服务端，也不作为启动默认值**
- 风格不再内置：点「＋ 新建风格」先从模板（治愈·日常流 / 史诗·暗黑壮烈 / 轻小说·对话向 / 硬核·写实 / 古风·文言语感 / 赛博朋克·冷硬 / 空白）中选一个，再自行修改；新建即写入服务端
- 接口：`GET/PUT /api/prefs`（全量，带 `expectedUpdatedAt` 乐观并发校验）、`POST /api/prefs/item`（单条提交）

## 安全与合规声明

本项目的「在线 API 账号安全」功能（**默认开启**，可在「提示词工具 - 开发者设置」自行关闭）用于**帮助使用者遵守所用 AI 服务的用户协议**：

- **仅在线模式生效**：量身打造的安全创作器
- **哈希词库**：仓库只分发不可逆哈希（blake2b-64bit），明文词表永不入库；用户可自建词库
- **条目粒度过滤**：命中违规特征的世界书条目等同关闭，不修改原数据，切回本地自动恢复
- **出站单向**：只做发送前的合规检查/脱敏，不审查模型输出，不做任何入站还原（无可逆编码规避）

合规机制不上传任何数据，全部检查在本地完成。

### 零密钥留存（可安全分发服务端）

- **服务端不持有任何 API 密钥**：在线密钥只存在于你自己的浏览器本地（`localStorage`）与会话请求头中；服务端 `/api/proxy` 只做目标白名单校验与转发，**不落盘、不回传、不代持**
- 服务端配置文件只保存地址类设置（`onlineBase` / `ollamaUrl`），旧版本遗留的 `onlineKey` 字段在读写时一律被忽略并清除
- 因此把服务端目录（含 `serve.py` 与前端）分发给他人，不会带走你的密钥

## 开源协议

[AGPL-3.0](LICENSE)

修改并部署本软件向公众提供服务时，需以相同许可证开源你的修改版本。
