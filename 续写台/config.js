// 全局配置（可被 localStorage 覆盖）
const CONFIG = {
  ollamaUrl: "http://127.0.0.1:11434", // 直连你的 Ollama（远程映射到本机）。固定 127.0.0.1 避免浏览器把 localhost 解析成 IPv6 ::1 导致连不上；若浏览器报 CORS，需在远程机设 OLLAMA_ORIGINS=*
  defaultTailChars: 6000,   // 发送给模型的前文窗口（字符数）。中文约 1.5 字/token，6000≈4000 token
  defaultMaxTokens: 900,    // 单次续写最大生成 token
  think: false,             // 默认关闭长思考(Qwen3/Youtu 系续写更快更省);需要思考的模型(如 DS R1 系)在设置弹窗改回 true
  autoSummary: true,        // B2：超窗口自动摘要前文
  completeTailChars: 1500, // 续笔（completion）模式的前文窗口：短窗口、低延迟，纯断点接龙
  // ---- 后端双模式：local=本地 Ollama / online=在线 OpenAI 兼容 API（硅基流动 SiliconFlow 等） ----
  backend: "local",          // 当前后端
  onlineBase: "https://api.siliconflow.cn/v1",  // 在线 API Base URL（OpenAI 兼容格式）
  onlineKey: "",             // 在线 API 密钥
  embedModel: "mxbai-embed-large",  // 本地向量模型
  vectorThreshold: 0.6,      // 向量匹配相似度阈值
  safeGate: true,            // 安全闸门:buildPrompt 拼装时自动过滤违规条目(本地哈希规则,无模型);默认开启(发布版不提供 UI 关闭)
  fontScale: 1,   // 界面字号档位:0.9375小 / 1中 / 1.0625大 / 1.125特大(只改字号基准)
};

// 默认系统提示词（可在弹窗里编辑、按模型保存）
const DEFAULT_SYSPROMPT =
"你是一位小说续写助手。只输出续写的正文，不要解释、不要重复前文、不要用引号或代码块包裹。严格保持原文的文风、视角与世界观一致。";

// 上下文模板：不同模型对“system/user 怎么组织”有不同规范。
// chat  = 标准 Chat Completions 格式（system + user 两段），Ollama /api/chat 原生支持
// alpaca = 单段拼接（<s>### Instruction: ... ### Response:），适配部分旧模板模型
// 切换模型时若该模型有专属模板则自动套用。
const TEMPLATES = {
  chat: {
    label: "Chat（system/user 两段）",
    build(sysParts, usrParts){
      // system 段：系统提示词 + 常驻设定 + 摘要
      const sys = sysParts.join("\n\n---\n\n");
      // user 段：参考设定 + 前文 + 指令
      const user = usrParts.join("\n\n---\n\n");
      return { system: sys, user };
    }
  },
  alpaca: {
    label: "Alpaca（单段拼接）",
    build(sysParts, usrParts){
      const sys = sysParts.join("\n\n---\n\n");
      const user = usrParts.join("\n\n---\n\n");
      return {
        system: "",
        user: "<s>\n### System:\n" + sys + "\n### Instruction:\n" + user + "\n### Response:\n"
      };
    }
  }
};
const DEFAULT_TEMPLATE = "chat";

// ============ 文风库（风格预设，提示词工具页可编辑） ============
// 每套 = 文风描述(仅差异部分) + 采样参数。与系统提示词机制完全独立：
// 通用约束（"你是小说续写助手…"）只放 DEFAULT_SYSPROMPT/系统设置，风格词只写文风差异，避免重复注入。
const STYLE_PRESETS = [
  {
    id: "custom",
    name: "自定义（不套用）",
    desc: "保持当前 system 词与参数不变",
    sysPrompt: "",
    params: null
  },
  {
    id: "xiaomeng_warm",
    name: "小梦·治愈日常",
    desc: "轻柔治愈、生活流、人物心理细腻",
    sysPrompt: "文风：轻柔治愈，生活流叙事，注重人物细微心理与感官细节（光影、气味、触感）。节奏舒缓，允许留白与安静的瞬间。第三人称限知视角。",
    params: { temperature:0.9, top_p:0.95, top_k:60, repeat_penalty:1.08, min_p:0.05, max_tokens:900 }
  },
  {
    id: "epic_dark",
    name: "史诗·暗黑壮烈",
    desc: "宏大世界观、宿命感、冷峻笔力",
    sysPrompt: "文风：史诗感，暗黑壮烈，世界观宏大而冷峻。善用短句与意象堆叠营造宿命压迫感，人物抉择带代价。第三人称，可有限全知。",
    params: { temperature:0.75, top_p:0.85, top_k:40, repeat_penalty:1.15, min_p:0.08, max_tokens:900 }
  },
  {
    id: "light_novel",
    name: "轻小说·对话向",
    desc: "轻松、吐槽、对话驱动",
    sysPrompt: "文风：轻小说风格，对话驱动，节奏明快，带适度吐槽与角色互动。允许口语化与个性台词，但保持叙事连贯。第三人称或角色视角切换均可。",
    params: { temperature:1.0, top_p:0.95, top_k:80, repeat_penalty:1.05, min_p:0.03, max_tokens:900 }
  },
  {
    id: "hard_real",
    name: "硬核·写实",
    desc: "冷静克制、物证优先、零粉饰",
    sysPrompt: "文风：硬核写实，冷静克制，以动作与可观察细节推进，避免抒情与心理独白堆砌。用词准确，零粉饰。第三人称限知。",
    params: { temperature:0.65, top_p:0.8, top_k:30, repeat_penalty:1.2, min_p:0.1, max_tokens:900 }
  },
  {
    id: "guwen",
    name: "古风·文言语感",
    desc: "半文半白、意境为先",
    sysPrompt: "文风：古风，半文半白，重意境与留白，辞藻雅致但不生僻。景物与情致相生，叙事含蓄有韵。第三人称。",
    params: { temperature:0.8, top_p:0.9, top_k:50, repeat_penalty:1.1, min_p:0.06, max_tokens:900 }
  },
  {
    id: "cyberpunk",
    name: "赛博朋克·冷硬",
    desc: "霓虹、科技冷感、碎片化",
    sysPrompt: "文风：赛博朋克，冷硬锐利，霓虹与金属质感，科技名词自然嵌入。叙事碎片化、信息密度高，带疏离感。第三人称限知。",
    params: { temperature:0.85, top_p:0.9, top_k:50, repeat_penalty:1.12, min_p:0.07, max_tokens:900 }
  }
];
