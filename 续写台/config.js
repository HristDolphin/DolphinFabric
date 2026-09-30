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
  // 在线 API 账号安全:buildPrompt 拼装时自动过滤违规条目(本地哈希规则,无模型调用)。
  // 默认开启,可在「提示词工具-开发者设置」关闭;字段名沿用 safeGate 以兼容既有本地配置。
  // 扩展位:判定实现约定返回 {violation, cats, labels}(见 app.js 的 SG_ACTIVE / 闸门调用点),
  //         将来替换为服务端规则或模型侧审查时只需换实现,调用方无需改动。
  safeGate: true,
  fontScale: 1,   // 界面字号档位:0.9375小 / 1中 / 1.0625大 / 1.125特大(只改字号基准)
};

// 内置系统提示词已移除（任务书需求 5）：不再回退任何内置默认值；
// 通用输出约束改由「风格模板」自带（见下方 STYLE_TEMPLATES 的 sysPrompt）。
// 原文与恢复方式见 续写台/archives/style_templates_20260916/REMOVED_恢复内置.md


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

// ============ 风格模板（仅作新建参考，不自动写入用户风格列表） ============
// 任务书需求 6：7 个内置风格预设不再默认内置、不再启动即注入。
// 本表只在用户点【＋ 新建风格】时作为可选模板展示；选中后才写入服务端 prefs.json。
// 每个模板的 sysPrompt 是自包含的：角色/输出约束 + 可执行技法 + 明确禁令
// （因为已不再有全局内置系统提示词兜底）。
const CUSTOM_STYLE = { id: "custom", name: "自定义（不套用）", desc: "无风格偏移：完全使用模型层基准参数" };

/* ============ 风格偏移映射表(20260916) ============
 * 模型层给"基准值"(绝对值,来自模型配置/内置模型预设/手动调参),风格层只给"偏移":
 *     Δp = 方向 dir ∈ {-1,0,+1}  ×  强度 s ∈ [0,1]  ×  上限 MAX[p]
 *   然后量化到步长 STEP[p]、clamp 到 BOUND[p]。单向叠加:基准永远不被风格改写(不做加权平均)。
 * 上限取值依据(业界常用区间):温度创作 0.8~1.2(>1.5 易崩)、top_p 0.9~0.95、top_k 40~100(0=关)、
 * repeat_penalty 1.1~1.3(>1.5 危险)、min_p 0.05~0.1(0=关);llama.cpp dynatemp 的 ±range 0.2~0.5 是同类思路。
 * max_tokens 不参与偏移:它是"长度"(模型/场景级),不是文风。
 */
const OFFSET_MAX   = { temperature:0.25, top_p:0.08, top_k:20, repeat_penalty:0.12, min_p:0.04 };
const OFFSET_BOUND = { temperature:[0.05,1.5], top_p:[0.5,0.98], top_k:[0,100], repeat_penalty:[1.0,1.4], min_p:[0,0.2] };
const OFFSET_STEP  = { temperature:0.01, top_p:0.01, top_k:1, repeat_penalty:0.01, min_p:0.01 };

const STYLE_TEMPLATES = [
  {
    id: "tpl_blank",
    name: "空白（自己写）",
    desc: "只带基本输出约束，文风自己填",
    sysPrompt: "你是小说续写引擎。只输出续写正文：不解释、不点评、不总结、不重复前文、不用引号或代码块包裹，直接从断点接着写。严格保持原文的人称、视角与世界观一致。",
    dir: {}, s: 0
  },
  {
    id: "tpl_healing",
    name: "治愈·日常流",
    desc: "生活流、五感细节、情绪靠动作渗出",
    sysPrompt: "你是小说续写引擎。只输出续写正文：不解释、不点评、不总结、不重复前文、不用引号或代码块包裹，直接从断点接着写。\n\n文风：治愈系日常流。\n- 视角：第三人称限知，贴着主角的感受写。\n- 节奏：慢。允许停顿、留白、没有事件的片刻。\n- 细节：用五感写小物（热气、光斑、布的触感、屋里的味道），以物写情。\n- 情绪：克制。不写“他很开心”，写他做了什么；情绪靠动作与细节渗出来。\n- 对话：短句、口语，留半句没说出口的话。\n\n禁止：激烈冲突、说教、总结升华、网红式金句、形容词堆叠。",
    dir: { temperature:1, top_p:1, top_k:1, repeat_penalty:-1, min_p:-1 }, s: 0.5
  },
  {
    id: "tpl_epic",
    name: "史诗·暗黑壮烈",
    desc: "宏大格局、宿命压迫、冷硬意象",
    sysPrompt: "你是小说续写引擎。只输出续写正文：不解释、不点评、不总结、不重复前文、不用引号或代码块包裹，直接从断点接着写。\n\n文风：史诗·暗黑壮烈。\n- 视角：第三人称，可有限全知；镜头先拉远看局势，再切近看代价。\n- 句式：长短交替，关键处用短句落锤（五到九字）。\n- 意象：铁、灰烬、风雪、旗帜、旧誓约等冷硬意象，堆叠出宿命压迫感。\n- 人物：每个抉择都标价，选了就要付。\n\n禁止：热血口号、网络梗、轻浮调侃、大团圆式和解、空喊信念。",
    dir: { temperature:-1, top_p:-1, min_p:1, repeat_penalty:1 }, s: 0.6
  },
  {
    id: "tpl_light",
    name: "轻小说·对话向",
    desc: "对话驱动、短段多空行、吐槽点到即止",
    sysPrompt: "你是小说续写引擎。只输出续写正文：不解释、不点评、不总结、不重复前文、不用引号或代码块包裹，直接从断点接着写。\n\n文风：轻小说·对话向。\n- 对话驱动：七成内容靠对话推进，叙述只做必要的动作与场景点染。\n- 台词个性化：每人有口癖与节奏；吐槽点到即止，不解释笑点。\n- 排版：段落短，多空行；内心吐槽可用括号或短句插入。\n- 节奏：轻快，但每段至少推进一点信息或人物关系。\n\n禁止：大段设定说明、文绉绉的抒情、把吐槽写成解说、连续三行以上纯叙述。",
    dir: { temperature:1, top_p:1, top_k:1, min_p:-1 }, s: 0.6
  },
  {
    id: "tpl_hard",
    name: "硬核·写实",
    desc: "可观察细节优先、零粉饰、去副词",
    sysPrompt: "你是小说续写引擎。只输出续写正文：不解释、不点评、不总结、不重复前文、不用引号或代码块包裹，直接从断点接着写。\n\n文风：硬核·写实。\n- 只写能被镜头拍到的东西：动作、位置、声响、光线、物证。\n- 用词精确，术语不多不少；时间与空间连续，不跳切。\n- 心理尽量外化为动作与生理反应（呼吸、手抖、口干）。\n- 句式干净，去掉副词与形容词的装饰。\n\n禁止：抒情、比喻堆叠、长篇心理独白、上帝视角点评、戏剧化巧合。",
    dir: { temperature:-1, top_p:-1, top_k:-1, min_p:1, repeat_penalty:1 }, s: 0.7
  },
  {
    id: "tpl_guwen",
    name: "古风·文言语感",
    desc: "半文半白、以景写情、含蓄有韵",
    sysPrompt: "你是小说续写引擎。只输出续写正文：不解释、不点评、不总结、不重复前文、不用引号或代码块包裹，直接从断点接着写。\n\n文风：古风·文言语感。\n- 半文半白：句式取文言节奏（短句、对仗、省略主语），词汇以常见雅词为限，不生僻。\n- 以景写情，情景相生；叙事含蓄，重言外之意。\n- 对话用白话打底，偶带雅称与敬语，不写成纯文言。\n\n禁止：现代词、网络语、翻译腔、大段铺陈辞藻、生僻典故掉书袋。",
    dir: { repeat_penalty:1, min_p:1 }, s: 0.4
  },
  {
    id: "tpl_cyber",
    name: "赛博朋克·冷硬",
    desc: "霓虹金属质感、名词密度高、疏离感",
    sysPrompt: "你是小说续写引擎。只输出续写正文：不解释、不点评、不总结、不重复前文、不用引号或代码块包裹，直接从断点接着写。\n\n文风：赛博朋克·冷硬。\n- 质感：雨、霓虹、金属与塑料；声音与气味先行。\n- 视角：第三人称限知，带疏离感；不做情绪解释。\n- 语言：名词密度高，科技名词自然嵌入（不加解释）；句短、断句多、可碎片化。\n- 世界：身体与资本、义体与债务的冷硬现实。\n\n禁止：浪漫化的科技赞美、说明书式解释、温情怀旧、连续长句。",
    dir: { temperature:1, top_k:1, repeat_penalty:1 }, s: 0.5
  }
];

