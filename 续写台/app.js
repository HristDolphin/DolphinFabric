/* ============ 续写台 · 核心逻辑(A3 标签匹配 + B2 窗口+摘要) ============ */

const LS_PROJECTS = "xietai.projects.v1";
const LS_POOL     = "xietai.pool.v1";
const LS_PACKS    = "xietai.packs.v1";    // 三层设定包:{packs:[{id,name,entries}], activePackId}
const LS_CONFIG   = "xietai.config.v1";
const LS_PRESETS  = "xietai.userpresets.v1";   // 旧手写预设(已并入 modelCfg,保留键名避免旧缓存)
const LS_MODEL    = "xietai.lastmodel.v1";      // 上次选择的模型
const LS_PARAMS   = "xietai.params.v1";         // 上次滑块值
const LS_PARAMOPEN= "xietai.paramopen.v1";      // 参数面板是否展开(已弃用,保留键名避免旧缓存报错)
const LS_MODELCFG = "xietai.modelcfg.v1";     // 每模型专属配置:系统提示词/模板/参数
const LS_MODE     = "xietai.mode.v1";        // 续写模式:chat(续写) / complete(代笔·断点直续) / completion(补全·真补全)
const LS_STYLE    = "xietai.style.v1";      // 当前生效的风格预设 id
const LS_STYLES   = "xietai.styles.v1";     // 风格预设库(提示词工具页编辑,localStorage 覆盖内置)
const LS_PROMPTITEMS = "xietai.promptitems.v1"; // 提示词条目库(对齐 ST extension_prompt: role/position/depth)
const LS_THINK_BL = "xietai.thinkblacklist.v1"; // 不支持 thinking 的模型名集合(运行时探测写入)
const LS_LASTNAV = "xietai.lastnav.v1";        // 导航状态:页面+宇宙/作品/章节(刷新后恢复)
/* 字号档位:只改 html 基准(乘系数),间距均为 px 不受影响 */
function applyFontScale(f){
  const v = Number(f) || 1;
  document.documentElement.style.setProperty("--fs-scale", v);
}

// 远程访问(手机/平板):API 请求全部经服务端 /api/proxy 转发 —— 密钥/Ollama 都在电脑端,远程设备零配置
const REMOTE = !!(location.hostname && location.hostname !== "localhost" && location.hostname !== "127.0.0.1");
async function apiFetch(url, opts={}){
  if(!REMOTE) return fetch(url, opts);
  // 同源/相对路径(存档、cleanup、servercfg 等本地 API)→ 浏览器直连,不走代理;
  // 仅外部 API(ollama/在线 Base)经 /api/proxy 转发(手机访问时由电脑端代持连接)
  try{
    const u = new URL(url, location.origin);
    if(u.origin === location.origin) return fetch(url, opts);
  }catch(e){ return fetch(url, opts); }
  const res = await fetch("/api/proxy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      method: opts.method || "GET",
      headers: opts.headers || {},
      body: (opts.body !== undefined && opts.body !== null) ? String(opts.body) : undefined
    }),
    signal: opts.signal
  });
  return res;
}

// Ollama 支持的采样参数(UI 暴露的子集)
const PARAM_KEYS = ["temperature","top_p","top_k","repeat_penalty","min_p"];
const DEFAULT_PARAMS = { temperature:0.8, top_p:0.9, top_k:40, repeat_penalty:1.1, min_p:0.05 };

// 运行时状态
const state = {
  cfg: loadJSON(LS_CONFIG, { ...CONFIG }),
  pools: loadJSON(LS_POOL, defaultPool()),
  // 三层设定包:{packs:[{id,name,entries:[{id,title,body,level,tags,src?}]}], activePackId}
  packs: loadPacks(),
  projects: loadJSON(LS_PROJECTS, null) || [newProject("未命名作品-1")],
  curPid: null,
  model: "",
  generating: false,
  probeTimer: null,   // 连接轮询定时器
  thinkBlacklist: new Set(loadJSON(LS_THINK_BL, [])),  // 不支持 thinking 的模型名集合
  appliedModel: null, // 已套用预设的模型(防止轮询重复覆盖手调参数)
  params: loadJSON(LS_PARAMS, { ...DEFAULT_PARAMS, max_tokens: Number(CONFIG.defaultMaxTokens) }),
  modelCfg: loadJSON(LS_MODELCFG, {}),     // 每模型专属配置:{sysPrompt, template, params}
  sysPrompt: (loadJSON("xietai.sysglobal.v1", null)||{}).sysPrompt || DEFAULT_SYSPROMPT,  // 全局系统提示词(不随模型重置)
  template: DEFAULT_TEMPLATE,              // 当前生效的上下文模板 key(随模型自动识别,原样)
  mode: loadJSON(LS_MODE, "chat"),         // 续写模式:chat=续写 / complete=代笔 / completion=补全
  style: loadJSON(LS_STYLE, "custom"),     // 当前风格预设 id(影响 effectiveSysPrompt;提示词工具页可编辑)
  styles: loadJSON(LS_STYLES, null) || JSON.parse(JSON.stringify(STYLE_PRESETS)),  // 风格预设库(编辑后存 localStorage,内置兜底;深拷贝防污染内置常量)
  promptItems: loadJSON(LS_PROMPTITEMS, []),  // 提示词条目库:[{id,name,content,role,position,depth,enabled}]
  history: [],                             // 续写历史版本:{text, ts, model}
  _pushT: null,                             // 静默推送防抖定时器
  initDone: false,                          // init 完成标记(完成后才自动推服务端)
};

// 撤销栈(线性分支)
let undoStack = [];

/* ---------------- 存储 ---------------- */
function loadJSON(k, def){ try{ const v=localStorage.getItem(k); return v?JSON.parse(v):def; }catch{ return def; } }
// 保存当前章节到后端（防抖，避免每键击一次请求）
let _chSaveT = null;
function saveProjects(){
  const ch = V2.curChapter, w = V2.curWork;
  if(!ch || !w) return;
  if(_chSaveT) clearTimeout(_chSaveT);
  _chSaveT = setTimeout(async ()=>{
    try{ await saveChapter(w.id, ch.id, ch); }
    catch(e){ console.warn("章节保存失败:", e); }
  }, 350);
}
function savePool(){ localStorage.setItem(LS_POOL, JSON.stringify(state.pools)); if(state.initDone) schedulePush(); }
function schedulePush(){ clearTimeout(state._pushT); state._pushT = setTimeout(()=>{ if(state.initDone) pushToServer(true); }, 1500); }
function savePacks(){ localStorage.setItem(LS_PACKS, JSON.stringify(state.packs)); if(state.initDone) syncLorebooks(true); }
function loadPacks(){
  const raw = loadJSON(LS_PACKS, null);
  if(raw && Array.isArray(raw.packs)){
    if(!raw.packs.length){ raw.packs=[{ id:"pack_default", name:"默认设定包", entries:[] }]; raw.activePacks=["pack_default"]; raw.editPackId="pack_default"; return raw; }
  } else {
    return { packs:[], activePacks:[], editPackId:"" };
  }
  // 归一化:任何畸形/旧版数据都补齐 activePacks / editPackId，防止 .includes 崩溃
  if(!Array.isArray(raw.activePacks)) raw.activePacks = [];
  if(!raw.packs.length){
    raw.packs = [{ id:"pack_default", name:"默认设定包", entries:[] }];
    raw.activePacks = ["pack_default"];
    raw.editPackId = "pack_default";
    return raw;
  }
  // 补齐激活列表:旧数据没有 activePacks 时，默认激活第一个包
  if(!raw.activePacks.length) raw.activePacks = [raw.packs[0].id];
  // 补齐编辑中包 id
  if(!raw.editPackId || !raw.packs.some(p=>p.id===raw.editPackId)) raw.editPackId = raw.packs[0].id;
  return raw;
}
// 激活的设定包(注入生效):多包组合
function activePacks(){
  const packs = state.packs && state.packs.packs;
  const ap = state.packs && state.packs.activePacks;
  if(!Array.isArray(packs) || !Array.isArray(ap)) return [];
  return packs.filter(p=>ap.includes(p.id));
}
// 聚合所有激活包的条目
function activeEntries(){ return activePacks().flatMap(pk=>pk.entries||[]); }
// 编辑中的包(侧栏显示的那个)
function editPack(){ return state.packs.packs.find(p=>p.id===state.packs.editPackId) || state.packs.packs[0] || null; }
// ---- 设定包管理 ----
function newPack(name){
  const pk = { id:"pack_"+Date.now()+Math.floor(Math.random()*1000), name: name||"新建设定包", entries:[] };
  state.packs.packs.push(pk);
  state.packs.editPackId = pk.id;
  if(!state.packs.activePacks.includes(pk.id)) state.packs.activePacks.push(pk.id);
  savePacks(); renderPoolHeader(); renderPool();
}
// 侧栏切换"正在编辑"的包（不改变激活状态）
function editPackSwitch(id){
  state.packs.editPackId = id;
  renderPoolHeader(); renderPool();
}
// 激活/停用某包(影响注入);可多包同时激活
function togglePack(id, on){
  const arr = state.packs.activePacks;
  const i = arr.indexOf(id);
  if(on && i<0) arr.push(id);
  if(!on && i>=0) arr.splice(i,1);
  savePacks(); renderPoolHeader();
}
function renamePack(id, name){ const pk=state.packs.packs.find(p=>p.id===id); if(pk){ pk.name=name||pk.name; savePacks(); renderPoolHeader(); } }
function deletePack(id){
  const i = state.packs.packs.findIndex(p=>p.id===id);
  if(i<0) return;
  if(state.packs.packs.length<=1){ alert("至少保留一个设定包"); return; }
  if(!confirm("删除设定包「"+state.packs.packs[i].name+"」及其全部条目?")) return;
  state.packs.packs.splice(i,1);
  state.packs.activePacks = state.packs.activePacks.filter(x=>x!==id);
  if(state.packs.editPackId===id) state.packs.editPackId = (state.packs.packs[0]&&state.packs.packs[0].id)||"";
  savePacks(); renderPoolHeader(); renderPool();
}
function renderPoolHeader(){
  const box = el("packList");
  if(!box) return;
  box.innerHTML = (state.packs.packs||[]).map(p=>{
    const on = Array.isArray(state.packs.activePacks) && state.packs.activePacks.includes(p.id);
    const editing = p.id===state.packs.editPackId;
    return `<div class="pack-row${editing?" editing":""} ${on?"on":"off"}" data-id="${p.id}">
        <input type="checkbox" class="pack-on" ${on?"checked":""} title="激活/停用(决定是否注入续写)"/>
        <span class="pack-name" title="点击编辑此包">${esc(p.name)} (${p.entries.length})</span>
        <button class="pack-edit-mini" title="编辑">✎</button>
        <button class="pack-del-mini" title="删除">✕</button>
      </div>`;
  }).join("");
  box.querySelectorAll(".pack-row").forEach(row=>{
    const id = row.dataset.id;
    row.querySelector(".pack-on").onchange = e=> togglePack(id, e.target.checked);
    row.querySelector(".pack-name").onclick = ()=> editPackSwitch(id);
    row.querySelector(".pack-edit-mini").onclick = (e)=>{ e.stopPropagation(); editPackSwitch(id); };
    row.querySelector(".pack-del-mini").onclick = (e)=>{ e.stopPropagation(); deletePack(id); };
  });
}

// 把当前 packs 同步到服务端 lorebooks/ 独立文件夹(无声)
async function syncLorebooks(silent){
  try{
    const r = await fetchWithTimeout(serverUrl().replace(/\/$/,"")+"/api/lorebooks", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ packs: state.packs.packs, activePacks: state.packs.activePacks, editPackId: state.packs.editPackId })
    }, 10000);
    if(!r.ok){ if(!silent) alert("设定包同步失败:"+r.status); return false; }
    return true;
  }catch(e){ if(!silent) alert("设定包同步失败:"+describeErr(e, serverUrl())); return false; }
}
async function pullLorebooks(){
  try{
    const r = await fetchWithTimeout(serverUrl().replace(/\/$/,"")+"/api/lorebooks", { cache:"no-store" }, 10000);
    if(!r.ok){ alert("拉取设定包失败:"+r.status); return; }
    const j = await r.json();
    if(!j.packs || !j.packs.length){ alert("服务端暂无设定包"); return; }
    if(!confirm("将从服务端 lorebooks 拉取设定包并覆盖本地(当前本地改动会丢失)。确定?")) return;
    state.packs = { packs: j.packs, activePacks: j.activePacks || (j.packs[0]&&j.packs[0].id?[j.packs[0].id]:[]), editPackId: j.editPackId || (j.packs[0]&&j.packs[0].id)||"" };
    savePacks(); renderPoolHeader(); renderPool();
    alert("已拉取 "+j.packs.length+" 个设定包");
  }catch(e){ alert("拉取失败:"+describeErr(e, serverUrl())); }
}

// ---- SillyTavern 世界书 import/export ----
function importLorebook(json){
  // json: {entries:{uid:{key,keysecondary,comment,content,constant,selective,disable,probability,...}}}
  const ents = json.entries || {};
  const entries = Object.keys(ents).map(uid=>{
    const e = ents[uid];
    const keys = [].concat(e.key||[], e.keysecondary||[]).filter(Boolean);
    const level = e.disable ? "disabled" : (e.constant ? "always" : "optional");
    return {
      id: "e"+uid+"_"+Date.now(),
      title: e.comment || (Array.isArray(e.key)&&e.key[0]) || ("条目"+uid),
      body: e.content || "",
      level,
      tags: keys.map(k=>String(k).replace(/^#/,"")),
      src: { key:e.key, keysecondary:e.keysecondary, constant:e.constant, selective:e.selective,
             probability:e.probability, selectiveLogic:e.selectiveLogic, order:e.order, position:e.position,
             role:e.role, group:e.group } // 保留原字段,导出时回写
    };
  });
  const name = json.name || (json.comment) || ("导入的设定包 "+new Date().toLocaleDateString());
  const pk = { id:"pack_"+Date.now()+Math.floor(Math.random()*1000), name, entries };
  state.packs.packs.push(pk);
  state.packs.editPackId = pk.id;
  if(!state.packs.activePacks.includes(pk.id)) state.packs.activePacks.push(pk.id);
  savePacks(); renderPoolHeader(); renderPool();
}
function exportLorebook(pack){
  // 反向映射:本结构 -> ST 世界书 entries
  const entries = {};
  pack.entries.forEach((e, i)=>{
    const src = e.src || {};
    const keys = (src.key && src.key.length) ? src.key : (e.tags&&e.tags.length? [e.tags[0]] : [e.title]);
    const keys2 = (src.keysecondary && src.keysecondary.length) ? src.keysecondary : (e.tags&&e.tags.length>1? [e.tags.slice(1).join(" ")] : []);
    entries[String(i)] = {
      uid: i, key: keys, keysecondary: keys2, comment: e.title||"", content: e.body||"",
      constant: e.level==="always", selective: true, selectiveLogic: src.selectiveLogic??2,
      addMemo: true, order: src.order??0, position: src.position??4, disable: e.level==="disabled",
      excludeRecursion: true, probability: src.probability??100, useProbability: true,
      displayIndex: i, group: src.group||"", groupOverride: false, groupWeight: 100,
      sticky: 0, cooldown: 0, delay: 0, depth: 4, role: src.role??0, vectorized: false,
      preventRecursion: true, delayUntilRecursion: true, scanDepth: null, caseSensitive: null,
      matchWholeWords: null, useGroupScoring: null, automationId: ""
    };
  });
  return { entries };
}

function saveStyle(){ try{ localStorage.setItem(LS_STYLE, state.style); }catch{} }
function saveStyles(){ try{ localStorage.setItem(LS_STYLES, JSON.stringify(state.styles||[])); }catch{} }
/* ---------------- 风格预设(提示词工具页可编辑;选择器在「全局|世界传说」旁) ----------------
 * 选风格 = 套用该预设的 system 提示词 + 采样参数;选「自定义」不覆盖(保持模型预设/手调)。
 * 风格词由 effectiveSysPrompt 读取(不写入 state.sysPrompt,保持手调值干净)。
 */
function applyStyle(id, persist){
  const preset = (state.styles||[]).find(p=>p.id===id) || null;
  state.style = id;
  if(persist) saveStyle();
  if(id !== "custom" && preset && preset.params){
    state.params = { ...state.params, ...preset.params };
  } else if(id === "custom"){
    // 「自定义(不套用)」= 真正关闭风格：清掉之前风格套用的参数残留。
    // 恢复顺序：当前模型绑定配置优先 → 否则默认参数(max_tokens 保持)。
    const mc = getModelCfg(state.model);
    if(mc.params){
      state.params = { ...mc.params };
    } else {
      state.params = { ...DEFAULT_PARAMS, max_tokens: state.params.max_tokens };
    }
  }
  syncParamUI();
  const sp = el("sysPrompt"); if(sp) sp.value = effectiveSysPrompt();
}
function populateStyleSel(){
  const sel = el("styleSel"); if(!sel) return;
  sel.innerHTML = "";
  (state.styles||[]).forEach(p=>{
    const o = document.createElement("option");
    o.value = p.id; o.textContent = p.name;
    if(p.desc) o.title = p.desc;
    if(p.id === state.style) o.selected = true;
    sel.appendChild(o);
  });
}
/* 风格下拉变化:套用预设(写入 params 并持久化;风格词由 effectiveSysPrompt 读取) */
function onStyleChange(){
  const id = el("styleSel").value;
  applyStyle(id, true);
}
function saveCfg(){ localStorage.setItem(LS_CONFIG, JSON.stringify(state.cfg)); }
function saveModelCfg(){ localStorage.setItem(LS_MODELCFG, JSON.stringify(state.modelCfg)); }
function saveThinkBlacklist(){ try{ localStorage.setItem(LS_THINK_BL, JSON.stringify([...state.thinkBlacklist])); }catch{} }

/* ---------------- 服务端存储(跨设备接力) ----------------
 * 服务目录下的 projects_store.json 作为跨设备共享存档。
 * pushToServer:本地 -> 服务端(last-write-wins,带 updatedAt)。
 * pullFromServer:服务端 -> 本地覆盖(用于换设备/浏览器接力)。
 */
function serverUrl(){ return location.origin + "/api/projects"; }
function currentSnapshot(){ return { updatedAt: Date.now(), data: { projects: state.projects, pool: state.pools } }; }
function setSyncStatus(text, cls){
  const s = el("syncStatus");
  if(!s) return;
  s.textContent = text || "";
  s.className = "sync-status" + (cls ? " "+cls : "");
}
async function pushToServer(silent){
  try{
    setSyncStatus("同步中…", "busy");
    const r = await fetchWithTimeout(serverUrl(),
      { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(currentSnapshot()) }, 10000);
    if(r.status === 409){
      if(!silent) alert("未覆盖:" + (j.error||"服务端已有更新存档"));
      setSyncStatus("冲突未覆盖", "err"); setTimeout(()=>setSyncStatus(""), 2500);
      return false;
    }
    if(!r.ok){ setSyncStatus("同步失败 "+r.status, "err"); setTimeout(()=>setSyncStatus(""), 3000); if(!silent) alert("同步失败:"+r.status); return false; }
    const j = await r.json().catch(()=>({}));
    setSyncStatus("已同步 ✓", "ok"); setTimeout(()=>setSyncStatus(""), 2000);
    return true;
  }catch(e){ setSyncStatus("同步失败", "err"); setTimeout(()=>setSyncStatus(""), 3000); if(!silent) alert("同步失败:"+describeErr(e, serverUrl())); return false; }
}
async function pullFromServer(){
  try{
    const r = await fetchWithTimeout(serverUrl(), { cache:"no-store" }, 10000);
    if(!r.ok){ alert("拉取失败:" + r.status); return; }
    const j = await r.json();
    const data = j.data || {};
    if(!data.projects || !data.projects.length){ alert("服务端暂无存档"); return; }
    if(!confirm("将从服务端拉取存档并覆盖本地(当前本地改动会丢失)。确定?")) return;
    state.projects = data.projects;
    if(data.pool) state.pools = data.pool;
    state.curPid = state.projects[0].id;
    saveProjects(); savePool();
    renderAll();
    alert("已拉取服务端存档(" + new Date(j.updatedAt||Date.now()).toLocaleString() + ")");
  }catch(e){ alert("拉取失败:" + describeErr(e, serverUrl())); }
}
function bindSyncBtn(){
  if(el("syncBtn")) el("syncBtn").onclick = async ()=>{
    try{
      await loadGlobal(); await loadWorldBooks(); await loadUniverses(); await loadWorks();
      renderWorldBrowser(); renderV2UniverseBar(); renderV2WorkBar();
      if(typeof renderV2GlobalSheet === "function") renderV2GlobalSheet();
      v2Toast("已刷新：世界书库 / 全局激活 / 宇宙 / 作品", "ok");
    }catch(e){ v2Toast("刷新失败", "err"); }
  };
}
function bindPackUI(){
  const add = el("packAdd"); if(add) add.onclick = ()=>{ const n=prompt("新建设定包名称:","新设定包"); if(n!==null) newPack(n); };
  const ren = el("packRename"); if(ren) ren.onclick = ()=>{ const pk=editPack(); if(pk){ const n=prompt("重命名设定包:", pk.name); if(n!==null) renamePack(pk.id, n); } };
  const del = el("packDel"); if(del) del.onclick = ()=>{ const pk=editPack(); if(pk) deletePack(pk.id); };
  const imp = el("packImport"); if(imp) imp.onclick = ()=>{ const f=el("packFile"); if(f) f.click(); };
  const file = el("packFile");
  if(file) file.onchange = e=>{
    const fl = e.target.files && e.target.files[0]; if(!fl) return;
    const rd = new FileReader();
    rd.onload = ()=>{ try{ const j=JSON.parse(rd.result); importLorebook(j); alert("已导入设定包("+ (editPack()?editPack().entries.length:0) +" 条)"); }
      catch(err){ alert("导入失败:JSON 解析错误\n"+err.message); } file.value=""; };
    rd.readAsText(fl);
  };
  const exp = el("packExport"); if(exp) exp.onclick = ()=>{ const pk=editPack(); if(!pk) return; const j=exportLorebook(pk);
    const blob = new Blob([JSON.stringify(j, null, 2)], {type:"application/json"}); const a=document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = (pk.name||"lorebook")+".json"; a.click(); URL.revokeObjectURL(a.href); };
  const pull = el("packPull"); if(pull) pull.onclick = pullLorebooks;
}
// 取某模型专属配置;不存在返回空对象
function getModelCfg(name){ return (name && state.modelCfg[name]) ? state.modelCfg[name] : {}; }
// 「系统提示词」层:全局手调 > 默认(不再随模型切换重置;风格词独立由 systemPromptParts() 第二段注入)。
function effectiveSysPrompt(){
  return state.sysPrompt || DEFAULT_SYSPROMPT;
}
/* 系统提示词(全局)持久化——只存系统词,模板随模型(原样) */
function saveSysSettings(){
  try{ localStorage.setItem("xietai.sysglobal.v1", JSON.stringify({ sysPrompt: state.sysPrompt })); }catch(e){}
}
/* 分层组装系统区(对齐 ST story_string 的独立字段拼接):
 *  [before 条目] [系统提示词] [风格预设词] [常驻设定] [in 条目]
 *  每层独立存在,不互相覆盖;promptItems 按 role/position 注入。
 *  两套机制完全独立:系统提示词 = 全局手调(系统设置);风格词 = 仅文风差异(不重复通用约束)。
 */
function systemPromptParts(){
  const parts = [];
  for(const it of (state.promptItems||[])){
    if(!it.enabled || it.position !== "before") continue;
    if(it.content && it.content.trim()) parts.push(it.content.trim());
  }
  const sys = effectiveSysPrompt();
  if(sys && sys.trim()) parts.push(sys.trim());
  const sp = (state.styles||[]).find(p=>p.id===state.style);
  if(state.style !== "custom" && sp && sp.sysPrompt && sp.sysPrompt.trim()) parts.push(sp.sysPrompt.trim());
  for(const it of (state.promptItems||[])){
    if(!it.enabled || it.position !== "in") continue;
    if(it.content && it.content.trim()) parts.push(it.content.trim());
  }
  return parts;
}
/* 前文窗口内的 in_chat 条目(按 depth 从窗口尾部插入,0=紧贴断点前)
 * extras: 世界书 position=4 的条目 [{content, depth}]，与提示词条目同机制注入 */
function chatPromptItems(text, extras){
  const items = (state.promptItems||[]).filter(it=>it.enabled && it.position === "in_chat" && it.content && it.content.trim())
    .map(it=>({ content: it.content.trim(), depth: Number(it.depth)||0 }));
  (extras||[]).forEach(x=>{ if(x && x.content && x.content.trim()) items.push({ content: x.content.trim(), depth: Number(x.depth)||0 }); });
  if(!items.length) return text;
  const segs = String(text||"").split(/\n{2,}/);
  const maxD = Math.max(0, ...items.map(i=>i.depth));
  for(const it of items){
    const d = Math.min(it.depth, maxD);
    const idx = Math.max(0, segs.length - 1 - d);
    segs.splice(idx, 0, it.content);
  }
  return segs.join("\n\n");
}
function effectiveTemplate(){
  const mc = getModelCfg(state.model);
  if(mc.template && TEMPLATES[mc.template]) return mc.template;
  return state.template || DEFAULT_TEMPLATE;
}

function newProject(name){
  return { id: "p"+Date.now()+Math.floor(Math.random()*1000), name, text:"", summary:null, ts:Date.now() };
}
function curProject(){
  // 新语义：当前章节即"文档"。提供旧接口 {id,name,text,summary} 供 buildPrompt/摘要等复用。
  const ch = V2.curChapter;
  if(ch) return { id: ch.id, name: ch.title || "未命名", text: ch.body || "", summary: ch.summary || null };
  return null;
}
function defaultPool(){
  // 开箱示例:一条常驻文风约束。用户自行增删。
  return [
    { id:"seed1", title:"文风约束", tags:[], level:"always",
      body:"避免现代口语与网络用语;保持第三人称限知视角;描写克制、不堆砌形容词;不替读者解释潜台词。" }
  ];
}

/* ---------------- 设定池:标签匹配 ---------------- */
function tailChars(){ return Number(state.cfg.tailChars || CONFIG.defaultTailChars); }

// 从前文尾部扫描活跃标签(#xxx)
function activeTags(text){
  const tail = text.slice(-3000);
  const set = new Set();
  const re = /#([A-Za-z0-9一-龥]+)/g; let m;
  while((m = re.exec(tail))) set.add(m[1]);
  return set;
}

// 可选设定:标签命中活跃标签才注入;无标签的可选设定视为"随时可用"也注入
function matchOptional(pools, text){
  const act = activeTags(text);
  return pools.filter(p=>{
    if(p.level!=="optional") return false;
    if(!p.tags || p.tags.length===0) return true;
    return p.tags.some(t=>act.has(t));
  });
}

/* ---------------- 摘要(B2) ---------------- */
function getCachedSummary(project){
  const ch = V2.curChapter;
  if(!ch) return null;
  const t = ch.body || "";
  if(t.length <= tailChars()) return null;
  const beyond = t.slice(0, t.length - tailChars());
  const c = ch.summary;
  if(c && c.forLen && Math.abs(c.forLen - beyond.length) < 2000) return c.text;
  return null;
}
async function ensureSummary(project){
  const ch = V2.curChapter;
  if(!ch) return;
  if(!state.cfg.autoSummary) { ch.summary = null; return; }
  const t = ch.body || "";
  if(t.length <= tailChars()){ ch.summary = null; return; }
  const beyond = t.slice(0, t.length - tailChars());
  const c = ch.summary;
  if(c && c.forLen && Math.abs(c.forLen - beyond.length) < 2000) return;
  const sum = await generateSummary(beyond);
  ch.summary = { text: sum, forLen: beyond.length };
  saveProjects();
}
async function generateSummary(beyond){
  const sys = "你是小说编辑助手。请把下面的前文压缩成一段连贯的剧情摘要,保留:已出场人物及其关系、已埋伏笔、关键事件、世界观/设定线索。不要评价,不要改写,用第三人称、客观、紧凑。限 300 字以内。";
  let acc="";
  for await (const piece of streamChat(state.model, [{role:"system",content:sys},{role:"user",content:beyond}], { think:false })){
    acc += piece;
  }
  return acc.trim().slice(0, 800);
}

/* ---------------- 文本格式归一化 ----------------
 * 激进模式:任何连续换行(含 \r\n / \r)-> 压缩为单个换行,彻底清空行距。
 */
function normalizeBlankLines(text){
  return String(text||"")
    .replace(/\r\n?/g, "\n")   // 先统一换行符
    .replace(/\n{2,}/g, "\n"); // 任意连续换行 -> 1 个
}

/* ---------------- 模型参数预设 ----------------
 * 加载 model_presets.json(工程里手写,非 localStorage)。
 */
let BUILTIN_PRESETS = { defaultPreset: { label:"通用默认", params:{...DEFAULT_PARAMS} }, presets: [] };
async function loadBuiltinPresets(){
  try{
    const r = await fetch("model_presets.json", { cache:"no-store" });
    if(r.ok) BUILTIN_PRESETS = await r.json();
  }catch(e){ /* 文件缺失就用默认 */ }
}
function matchPreset(name){
  const p = BUILTIN_PRESETS.presets || [];
  for(const it of p){
    if(it.match && it.match !== "default" && name && name.toLowerCase().includes(it.match.toLowerCase())){
      if(it.skip) return { skip:true, label:it.label };
      return { params: it.params, label: it.label };
    }
  }
  return null;
}
function applyParams(p){
  for(const k of PARAM_KEYS){ if(p[k] !== undefined) state.params[k] = p[k]; }
  if(p.max_tokens) state.params.max_tokens = p.max_tokens;
  saveParams(); syncParamUI();
}
function saveParams(){ localStorage.setItem(LS_PARAMS, JSON.stringify(state.params)); }
/* 调参即存:滑块调整后防抖写入当前模型预设(切换模型即切换预设) */
let _paramSaveT = null;
function autoSaveModelParams(){
  clearTimeout(_paramSaveT);
  _paramSaveT = setTimeout(()=>{
    if(!state.model) return;
    const mc = state.modelCfg[state.model] || (state.modelCfg[state.model] = {});
    mc.params = { ...state.params };
    saveModelCfg();
    const h = el("presetHint"); if(h) h.textContent = "已自动保存到预设:"+state.model;
  }, 600);
}
function saveParamOpen(){ /* 已弃用 */ }
function onModelSwitch(name, force){
  if(!force && state.appliedModel === name) return;  // 同模型不重复套用,保住手调参数
  state.appliedModel = name;
  // -- 优先级:模型专属预设(自动记忆/手存) > 内置 model_presets.json > 当前值 --
  const mc = getModelCfg(name);
  let hint = [];
  // 1) 模板:仅当该模型有专属配置时套用(系统提示词已全局化,不随模型切换)
  if(mc.template && TEMPLATES[mc.template]){ state.template = mc.template; hint.push("模板"); }
  // 2) 参数:模型专属预设优先,未存过则内置预设兜底
  let params = null, plabel = "";
  if(mc.params){ params = mc.params; plabel = "模型预设"; }
  else { const m = matchPreset(name); if(m && !m.skip){ params = m.params; plabel = "内置预设"; } }
  if(params){ applyParams(params); hint.push("参数("+plabel+")"); }
  el("presetHint").textContent = hint.length ? ("已套用:" + hint.join("+")) : "未匹配,使用当前值";
  // 风格预设优先于模型配置:若选了具体风格(非自定义),重新套用其 params(风格词由 effectiveSysPrompt 读取)
  if(state.style && state.style !== "custom"){
    const sp = (state.styles||[]).find(p=>p.id===state.style);
    if(sp && sp.params) applyParams({ ...state.params, ...sp.params });
  }
}

/* ---------------- 思考块分离(DS R1 系 / 部分模型 inline <think>) ----------------
 * 思路:优先剥离成对的 <think>...</think>;对于流式"截到一半"未闭合的 <think>(模型还在吐推理、
 * 尚未输出 </think>),把"最后一个未闭合开标签之后的全部内容"也归入 think,避免正文区被 reasoning 污染。
 * 返回 { think, body }。body 已 trim;多余空行由调用方 normalizeBlankLines 处理。
 */
function splitThink(text){
  if(!text) return { think:"", body:"" };
  const re = /<think>([\s\S]*?)<\/think>/g;
  let m, think="", body="";
  let lastEnd = 0;
  while((m = re.exec(text)) !== null){
    body += text.slice(lastEnd, m.index);
    think += (think ? "\n" : "") + m[1];
    lastEnd = re.lastIndex;
  }
  let rest = text.slice(lastEnd);
  // 处理未闭合的 <think>:剩余部分若含开标签无闭合,其后全当思考
  const openIdx = rest.indexOf("<think>");
  if(openIdx >= 0){
    body += rest.slice(0, openIdx);
    think += (think ? "\n" : "") + rest.slice(openIdx + "<think>".length);
  } else {
    body += rest;
  }
  return { think: think.trim(), body: body.trim() };
}

/* ---------------- Ollama 流式 ---------------- */
async function* streamChat(model, messages, { think=false, params={}, onThink } = {}){
  // 在线模式：OpenAI 兼容 Chat Completions（思考块在 delta.reasoning_content）
  if(state.cfg.backend === "online") return yield* streamChatOnline(model, messages, { params, onThink });
  const opt = { num_predict: Number(params.max_tokens || state.cfg.maxTokens || CONFIG.defaultMaxTokens) };
  for(const k of PARAM_KEYS){ if(params[k] !== undefined && params[k] !== null && params[k] !== "") opt[k] = Number(params[k]); }

  // 不支持 thinking 的模型(首请求 400 后由 state.thinkBlacklist 记录)发 think:false
  const wantThink = think && !state.thinkBlacklist.has(model);

  async function oneShot(useThink){
    const res = await apiFetch(state.cfg.ollamaUrl + "/api/chat", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ model, messages, stream:true, think: useThink, options: opt })
    });
    return res;
  }

  let res = await oneShot(wantThink);
  // 400 且报不支持 thinking:标记该模型,自动用 think:false 重发一次(不报错给用户)
  if(res.status === 400){
    let txt = ""; try{ txt = await res.text(); }catch{}
    if(/does not support thinking/i.test(txt)){
      state.thinkBlacklist.add(model);
      saveThinkBlacklist();
      res = await oneShot(false);
    }
  }
  if(!res.ok) throw new Error("Ollama 返回 "+res.status+"(确认服务已启动且允许跨域)");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while(true){
    const { done, value } = await reader.read();
    if(done) break;
    buf += dec.decode(value, { stream:true });
    let i;
    while((i = buf.indexOf("\n")) >= 0){
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i+1);
      if(!line) continue;
      let c; try{ c = JSON.parse(line); }catch{ continue; }
      if(c.message){
        const cc = c.message;
        // 思考:优先结构化字段(Ollama 不同版本可能用 reasoning_content 或 thinking)
        const t = cc.reasoning_content || cc.thinking;
        if(onThink && t) onThink(t);
        if(cc.content) yield cc.content;
      }
      if(c.done) return;
    }
  }
  if(buf.trim()){
    try{ const c = JSON.parse(buf.trim()); const cc = c.message; if(cc?.content) yield cc.content; }catch{}
  }
}

/* ---------------- 真补全(续接)流式:/api/generate ---------------- */
function genOptions(params){
  const o = {};
  const map = { temperature:"temperature", top_p:"top_p", top_k:"top_k", repeat_penalty:"repeat_penalty", min_p:"min_p" };
  for(const k in map){ if(params[k] !== undefined && params[k] !== null && params[k] !== "") o[map[k]] = Number(params[k]); }
  o.num_predict = Number(params.max_tokens || state.cfg.maxTokens || CONFIG.defaultMaxTokens);
  return o;
}
async function* streamGenerate(model, prompt, { raw=true, params={} } = {}){
  // 在线模式：OpenAI 兼容 Text Completions（纯文本流,思考块以文本形式原样返回）
  if(state.cfg.backend === "online") return yield* streamGenerateOnline(model, prompt, { params });
  const body = { model, prompt, stream:true, raw, options: genOptions(params) };
  if(state.cfg && state.cfg.think === false) body.think = false;   // 本地补全通道也关思考(Qwen3/QwQ 等默认开)
  const res = await apiFetch(state.cfg.ollamaUrl + "/api/generate", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify(body)
  });
  if(!res.ok) throw new Error("Ollama generate 返回 " + res.status);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while(true){
    const { done, value } = await reader.read();
    if(done) break;
    buf += dec.decode(value, { stream:true });
    let i;
    while((i = buf.indexOf("\n")) >= 0){
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i+1);
      if(!line) continue;
      let c; try{ c = JSON.parse(line); }catch{ continue; }
      if(c.response) yield c.response;   // 思考块与正文都在 response 文本流里(可原样续接)
      if(c.done) return;
    }
  }
}
/* 在线模式 Chat Completions 流式：delta.content=正文 / delta.reasoning_content=思考 */
/* 在线通道关闭思考的适配参数：
 * DS R1 / V3.1 系(think:false) 与 Qwen 系(enable_thinking:false, DashScope/硅基流动等 OpenAI 兼容)
 * 是各自独立研发的机制,参数互不通用 —— 按模型名路由,避免发错参数被 400。
 * cfg.think 非 false 时返回 null(不干预)。 */
function onlineThinkOpt(){
  if(!(state.cfg && state.cfg.think === false)) return null;
  const m = String(state.model || "").toLowerCase();
  return m.includes("qwen") ? { enable_thinking:false } : { think:false };
}
/* 400 降级:去掉刚加的思考关闭参数重发一次(中转站不认该参数时兜底) */
async function retryWithoutThinkOpt(res, url, body){
  if(res.status !== 400) return res;
  const has = body.think !== undefined || body.enable_thinking !== undefined;
  if(!has) return res;
  let txt = ""; try{ txt = await res.text(); }catch{}
  if(!/think|parameter|invalid|unknown/i.test(txt)) return res;
  delete body.think; delete body.enable_thinking;
  return apiFetch(url, { method:"POST", headers: apiHeaders(), body: JSON.stringify(body) });
}
async function* streamChatOnline(model, messages, { params={}, onThink } = {}){
  const opt = {};
  if(params.max_tokens) opt.max_tokens = Number(params.max_tokens);
  for(const k of PARAM_KEYS){ if(params[k] !== undefined && params[k] !== null && params[k] !== "") opt[k] = Number(params[k]); }
  const body = { model, messages, stream:true, ...opt, ...(onlineThinkOpt()||{}) };   // 按模型适配 think/enable_thinking
  let res = await apiFetch(apiBase() + "/chat/completions", {
    method:"POST", headers: apiHeaders(),
    body: JSON.stringify(body)
  });
  res = await retryWithoutThinkOpt(res, apiBase() + "/chat/completions", body);
  if(!res.ok){ let t=""; try{ t = await res.text(); }catch{} throw new Error("在线 API 返回 " + res.status + " " + String(t).slice(0,120)); }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while(true){
    const { done, value } = await reader.read();
    if(done) break;
    buf += dec.decode(value, { stream:true });
    let i;
    while((i = buf.indexOf("\n")) >= 0){
      const line = buf.slice(0, i).trim(); buf = buf.slice(i+1);
      if(!line || !line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if(payload === "[DONE]") return;
      let c; try{ c = JSON.parse(payload); }catch{ continue; }
      const d = (c.choices && c.choices[0] && c.choices[0].delta) || {};
      const t = d.reasoning_content || d.thinking;
      if(onThink && t) onThink(t);
      if(d.content) yield d.content;
    }
  }
}
/* 在线模式 Text Completions 流式：choices[0].text 纯文本（补全模式用） */
async function* streamGenerateOnline(model, prompt, { params={} } = {}){
  const opt = {};
  if(params.max_tokens) opt.max_tokens = Number(params.max_tokens);
  for(const k of PARAM_KEYS){ if(params[k] !== undefined && params[k] !== null && params[k] !== "") opt[k] = Number(params[k]); }
  const body = { model, prompt, stream:true, ...opt, ...(onlineThinkOpt()||{}) };   // 在线补全通道同样按模型适配
  let res = await apiFetch(apiBase() + "/completions", {
    method:"POST", headers: apiHeaders(),
    body: JSON.stringify(body)
  });
  res = await retryWithoutThinkOpt(res, apiBase() + "/completions", body);
  if(!res.ok){ let t=""; try{ t = await res.text(); }catch{} throw new Error("在线 API 返回 " + res.status + " " + String(t).slice(0,120)); }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while(true){
    const { done, value } = await reader.read();
    if(done) break;
    buf += dec.decode(value, { stream:true });
    let i;
    while((i = buf.indexOf("\n")) >= 0){
      const line = buf.slice(0, i).trim(); buf = buf.slice(i+1);
      if(!line || !line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if(payload === "[DONE]") return;
      let c; try{ c = JSON.parse(payload); }catch{ continue; }
      const txt = (c.choices && c.choices[0] && c.choices[0].text) || "";
      if(txt) yield txt;
    }
  }
}
async function* genWithFallback(model, prompt, params){
  // raw:true 优先(纯补全);仅在"请求阶段就失败(一个字节都没产出)"时回退 raw:false 重发。
  // 流式中途断连(远程隧道抖动常见):保留已生成内容直接报错停止,绝不从头重跑——
  // 否则用户会看到"一次生成自动跑多轮、内容从头重复"。
  let produced = false;
  try{
    const g = streamGenerate(model, prompt, { raw:true, params });
    for await (const p of g){ produced = true; yield p; }
  }catch(e){
    if(produced) throw e;
    console.warn("generate raw 请求失败,回退默认模板:", e && e.message);
    const g = streamGenerate(model, prompt, { raw:false, params });
    for await (const p of g) yield p;
  }
}
/* 记录未完成的思考块:输出含 <think> 且未闭合 → 存为 pendingThink,下次续接时拼回断点继续推理 */
function updatePendingThink(acc){
  if(!acc){ state.pendingThink = null; return; }
  const opens = (acc.match(/<think>/g)||[]).length;
  const closes = (acc.match(/<\/think>/g)||[]).length;
  if(opens > closes){
    const i = acc.indexOf("<think>");
    state.pendingThink = i >= 0 ? acc.slice(i) : "<think>\n" + acc;
  } else {
    state.pendingThink = null;
  }
}

/* ---------------- Prompt 拼装 ----------------
 * 系统提示词来自 effectiveSysPrompt()(可编辑、按模型保存);
 * 上下文模板来自 effectiveTemplate()(chat / alpaca 等,决定 system+user 如何组织)。
 *
 * 两种模式:
 *  - chat(深度续写):user 段包装前文+指令,走 /api/chat。支持标签匹配、摘要、强设定。
 *  - complete(续笔·断点直续):把前文作为模型"上一条 assistant 消息",再用 user"继续"请求它接写。
 *    走 /api/chat 的 continue-last-message 范式(SillyTavern Continue 同思路):模型视前文为己出,
 *    自然衔接、无伪问答边界;且复用与深度续写相同的结构化思考字段(reasoning_content/thinking)。
 */
/* 系统区精确分层（位置 0-6 各自生效,三模式共用）:
 * [pos0 开头] [before条目+系统词+风格词] [pos1 设定区] [常驻设定] [pos2作者注前 + pos3作者注后] [in条目]
 */
function buildSystemParts(matched, always){
  const sysParts = [];
  const m0 = matched.filter(m => m.pos === 0);
  if(m0.length) sysParts.push("【设定·开头】\n" + m0.map(p=>`# ${p.title}\n${p.body}`).join("\n\n"));
  sysParts.push(...systemPromptParts());
  const m1 = matched.filter(m => m.pos === 1);
  if(m1.length) sysParts.push("【设定区】\n" + m1.map(p=>`# ${p.title}\n${p.body}`).join("\n\n"));
  if(always.length){
    sysParts.push("【常驻设定】\n" + always.map(p=>`# ${p.title}\n${p.body}`).join("\n\n"));
  }
  const m23 = matched.filter(m => m.pos === 2 || m.pos === 3);   // 作者注:2前3后
  if(m23.length) sysParts.push("【作者注】\n" + m23.map(p=>`# ${p.title}\n${p.body}`).join("\n\n"));
  // 自动关闭长思考:cfg.think=false 时向 system 注入输出约束段落(覆盖 chat/complete/completion 三模式;
  // 对 /api/generate 与在线后端等无 think 参数通道的场景,这是唯一/兜底手段)
  if(state.cfg && state.cfg.think === false){
    sysParts.push("【输出约束】直接输出小说正文。不要输出任何思考、推理或分析过程，不要使用<think>标签。");
  }
  return sysParts;
}
async function buildPrompt(project, instruction){
  // Phase 2b: 若已选世界+作品集，优先用 v2 激活引擎
  const v2 = v2EntriesIfActive(project.text || "");
  let entries, always, matched;
  if(v2){
    entries = v2.entries; always = v2.always;
    // 可选条目：由 v2EntriesIfActive 按「四态逻辑 + 三模式 + 扫描开关」算好（对齐 ST）
    matched = v2.matched || [];
  } else {
    entries = activeEntries();
    always  = entries.filter(p=>p.level==="always");
    // 旧设定池:条目无 position 时缺省「前文前」(参考设定,与原行为一致)
    matched = matchOptional(entries, project.text).map(m => ({
      title: m.title, body: m.body,
      pos: (m.position !== undefined && m.position !== null) ? Number(m.position) : 5
    }));
  }
  // —— 安全闸门 SafeGate：在线模式下 ⚠️标记条目等同关闭（优先于常驻/逻辑/向量模式），安全条目放行 ——
  //     （已标记词条已在 computeActiveEntries 源头排除；此处对未标记条目自动检查并持久化新标记）
  let blocked = [];
  if(SG_ACTIVE() && (always.length || matched.length)){
    const items = [];
    for(const it of always) items.push({ wbId: it.wbId, entryId: it.entryId, title: it.title || it.id || "(未命名)", body: it.body, wbName: it.wbName });
    for(const it of matched) items.push({ wbId: it.wbId, entryId: it.entryId, title: it.title || it.id || "(未命名)", body: it.body, wbName: it.wbName });
    const res = await sgFilterEntries(items);
    blocked = res.blocked;
    if(blocked.length){
      const keyOf = it => (it.wbId && it.entryId) ? (it.wbId + ":" + it.entryId) : ((it.title || "") + "\u0000" + (it.wbName || ""));
      always = always.filter(it => !res.flagSet.has(keyOf(it)));
      matched = matched.filter(it => !res.flagSet.has(keyOf(it)));
      saveSafeGate();
    }
  }
  // system 段:位置 0-6 精确分层(见 buildSystemParts)
  const sysParts = buildSystemParts(matched, always);

  if(state.mode === "complete"){
    // -- 续笔模式:continue-last-message --
    // 把前文当成模型刚写好的上一条 assistant 消息,再用一条极简 user"继续"去接。
    // 指令框内容非空时,作为软走向提示并入 user(不进 assistant 前文,避免污染断点)。
    const window = project.text.slice(-(Number(CONFIG.completeTailChars)||1500));
    // 续笔强调"直接续写叙事、不要解释/分析/重述",防止强推理模型把叙事塞进思考块或因指令太弱而跑题
    const cont = instruction && instruction.trim()
      ? ("请从上面最后一句的自然断点接着往下写,保持同一个人称与文风,直接输出新增的叙事正文,不要解释、不要分析、不要复述前文。走向提示:" + instruction.trim())
      : "请从上面最后一句的自然断点接着往下写,保持同一个人称与文风,直接输出新增的叙事正文,不要解释、不要分析、不要复述前文。";
    // 代笔(continue)模式:位置 4/5/6 的条目并入 system(前文是 assistant 锚点,注入会污染断点)
    const m456 = matched.filter(m => m.pos >= 4);
    if(m456.length){
      sysParts.push("【参考设定】\n" + m456.map(p=>`# ${p.title}\n${p.body}`).join("\n\n"));
    }
    const messages = [
      { role:"system", content: sysParts.join("\n\n---\n\n") },
      { role:"assistant", content: window },
      { role:"user", content: cont }
    ];
    return { messages, blocked };
  }

  if(state.mode === "completion"){
    // -- 真补全(续接)模式:纯文本 prompt;尾部=断点(未完成思考 或 最后一句原文);无"请继续" --
    // 结构: [系统+常驻+可选匹配设定] [前文(去掉末句)] [(写作方向指令)] [断点]
    // 思考续接:上次生成停在思考块内(<think>未闭合)时,pendingThink 拼回断点,模型继续推理,不重新写
    const parts = buildSystemParts(matched, always);
    const mInC = matched.filter(m => m.pos === 4).map(m=>({ content: "# " + m.title + "\n" + m.body, depth: m.depth }));
    const window = chatPromptItems(project.text.slice(-(Number(CONFIG.completeTailChars)||1500)), mInC);
    const lastLine = (window.split("\n").filter(Boolean).pop() || "").trimEnd();
    const body = window.slice(0, Math.max(0, window.lastIndexOf(lastLine)));
    const instr = instruction && instruction.trim() ? "（写作方向：" + instruction.trim() + "）" : "";
    const tail = state.pendingThink || lastLine;
    const mPreC = matched.filter(m => m.pos >= 5);
    const preBlock = mPreC.length ? "【参考设定】\n" + mPreC.map(p=>`# ${p.title}\n${p.body}`).join("\n\n") + "\n\n" : "";
    const prompt = parts.join("\n\n") + "\n\n" + preBlock + "【前文】\n" + body.trimEnd() + (instr ? "\n" + instr : "") + "\n" + tail;
    return { prompt, blocked };
  }

  // -- 深度续写(chat)模式 --
  // 位置 0-3 已在 system 区(设定区);此处:位置5-6进参考设定段、位置4进前文窗口内
  const usrParts = [];
  const mPre = matched.filter(m => m.pos >= 5);
  if(mPre.length){
    usrParts.push("【本次参考设定(按前文自动匹配)】\n" + mPre.map(p=>`# ${p.title}\n${p.body}`).join("\n\n"));
  }
  const mIn = matched.filter(m => m.pos === 4).map(m=>({ content: "# " + m.title + "\n" + m.body, depth: m.depth }));
  const window = chatPromptItems(project.text.slice(-tailChars()), mIn);
  usrParts.push("【前文(待续写)】\n" + window);
  usrParts.push(instruction && instruction.trim()
    ? instruction.trim()
    : "请自然续写上文,保持文风与视角一致,只输出新增正文。");

  const tplKey = effectiveTemplate();
  const tpl = TEMPLATES[tplKey] || TEMPLATES[DEFAULT_TEMPLATE];
  const built = tpl.build(sysParts, usrParts);
  // 统一返回 messages 数组(与续笔模式一致),doGenerate 只需读 built.messages
  const messages = [ { role:"system", content: built.system } ];
  if(built.user) messages.push({ role:"user", content: built.user });
  return { messages, blocked };
}

/* ---------------- 生成流程 ---------------- */
async function doGenerate(){
  if(state.generating) return;
  if(!V2.curChapter || !V2.curWork){ alert("请先选择作品集与章节"); return; }
  if(!state.model){ alert("未检测到模型,确认 ollama 已启动"); return; }
  // 安全闸门：safeAuto=关 → 检测+阻止（正文命中即拦截，防 Ctrl+Enter 绕过）；safeAuto=开 → 发送时自动映射（见下方）
  if(GATE_ACTIVE()){
    hideGateHint();
    if(state.cfg.safeAuto === false){
      const _body = el("editor") ? el("editor").value : "";
      const _r = await sgCheckPositions(_body);
      if(_r && _r.hits && _r.hits.length){
        showGateHint(_r.hits);
        v2Toast("⚠️ 正文含违规特征，已阻止发送。修改正文、切本地模型，或开启自动脱敏", "err");
        return;
      }
    }
  }
  // 每次续写强制扫描一次连接
  const conn = await probeConnection(true);
  if(!conn){ alert("无法连接 Ollama(" + state.cfg.ollamaUrl + ")，请确认已启动后重试。"); return; }

  const project = curProject();
  await refreshVectorMatches(project.text || "");   // 向量条目：正文语义匹配(embedding 不可用则静默不触发)
  if(state.mode === "chat") await ensureSummary(project);  // 摘要仅深度续写用到
  const built = await buildPrompt(project, el("instruction").value);
  const isCompletion = state.mode === "completion";
  const messages = built.messages;  // chat/complete 返回 messages 数组;completion 返回 prompt
  if(built.blocked && built.blocked.length){
    const _bn = built.blocked.map(b=>(b.title||"(未命名)") + (b.cats && b.cats.length ? "(" + sgCatText(b.cats) + ")" : "")).join("、");
    v2Toast("⚠️ 安全闸门 已屏蔽 " + built.blocked.length + " 条违规设定（未进入拼装）：" + _bn.slice(0, 90), "err");
  }

  // 安全闸门 · 自动脱敏（safeAuto 默认开）：发送前把上下文敏感词映射为安全词。
  // 正文/历史/设定原文不动；AI 返回原样追加（无还原）= 纯出站单向过滤，非越狱。
  if(GATE_ACTIVE() && state.cfg.safeAuto !== false){
    if(isCompletion){
      const _r = await sgCheckPositions(built.prompt);
      if(_r && _r.hits && _r.hits.length){
        built.prompt = sanitizeText(built.prompt, _r.hits);
        v2Toast("已自动脱敏 " + _r.hits.length + " 处，内容已安全", "ok");
      }
    } else {
      let _cnt = 0;
      for(const _m of built.messages){
        if(typeof _m.content === "string" && _m.content){
          const _r = await sgCheckPositions(_m.content);
          if(_r && _r.hits && _r.hits.length){ _m.content = sanitizeText(_m.content, _r.hits); _cnt += _r.hits.length; }
        }
      }
      if(_cnt) v2Toast("已自动脱敏 " + _cnt + " 处，内容已安全", "ok");
    }
  }
  // 快照(撤销)
  undoStack.push((V2.curChapter.body) || "");

  const _t0 = Date.now();   // 思考耗时统计
  state.generating = true;
  setGeneratingUI(true);
  el("thinkPanel").classList.add("open");
  el("thinkText").textContent = "";
  el("draftText").value = "";
  el("draftText").readOnly = true;          // 生成中锁定编辑
  el("draftStatus").textContent = "生成中...";
  setDraftActions(false);                    // 生成中禁用接受/放弃

  let acc = "";
  const onThink = t => { el("thinkText").textContent += t; };
  // 续笔模式:直接要正文,强制 think:false(推理模型会把叙事塞进 thinking 块导致正文空)
  const useThink = (state.mode === "complete") ? false : state.cfg.think;
  try{
    if(isCompletion){
      // 真补全:调 /api/generate 流式;raw 优先,失败自动回退默认模板(思考块仍在 response 文本里)
      for await (const piece of genWithFallback(state.model, built.prompt, state.params)){
        acc += piece;
        el("draftText").value = normalizeBlankLines(acc);  // 流式实时清理连续换行
        scrollEnd(el("draftText"));
      }
    } else {
      for await (const piece of streamChat(state.model, messages, {
        think: useThink, params: state.params, onThink })){
        acc += piece;
        el("draftText").value = normalizeBlankLines(acc);  // 流式实时清理连续换行
        scrollEnd(el("draftText"));
      }
    }
    const { think, body } = splitThink(acc);
    if(think) el("thinkText").textContent += think;
    // 真补全:仅当"没有正文"(思考用完预算被截断)才记录未完成思考为续接点;
    // 正常生成(已出正文)绝不记录,避免误触发下次自动续接(修复:正常生成自动多次的 bug)
    if(isCompletion && !body) updatePendingThink(acc);
    if(body){
      const clean = normalizeBlankLines(body);   // 压缩多余空行
      state.history.unshift({ text: clean, ts: Date.now(), model: state.model });  // 入历史
      if(state.history.length > 20) state.history.pop();
      renderHistory();
      el("draftText").value = clean;            // 停在预览区,等用户确认
      el("draftText").readOnly = false;          // 解锁编辑
      el("draftStatus").textContent = (think ? "思考 " + ((Date.now()-_t0)/1000).toFixed(1) + "s · " : "") + "待插入 · 已可编辑";
      setDraftActions(true);                      // 启用接受/放弃
    } else {
      el("draftText").value = "";
      el("thinkText").textContent += "\n[模型未返回正文。可重试、换模型,或在「续写」(深度) 模式下尝试。]";
      el("draftStatus").textContent = "";
    }
  }catch(e){
    el("thinkText").textContent += "\n⚠ " + e.message;
    undoStack.pop();
    el("draftStatus").textContent = "";
  }finally{
    state.generating = false;
    setGeneratingUI(false);
    undoStackPushTrim();
  }
}
function undoStackPushTrim(){ if(undoStack.length > 50) undoStack.shift(); }

function doUndo(){
  if(!V2.curChapter || undoStack.length===0) return;
  V2.curChapter.body = undoStack.pop();
  saveProjects();
  renderEditor();
}
/* 查看请求:把前端实际发给 API 的 system + user/prompt 展示出来 */
async function showRequest(){
  const project = curProject();
  if(!project){ alert("请先选择章节"); return; }
  const built = await buildPrompt(project, el("instruction").value);
  const msgs = built.messages || [];
  el("reqModel").value = state.model || "(未选模型)";
  el("reqOpts").value = "mode=" + state.mode
    + "  num_predict=" + (state.cfg.maxTokens||CONFIG.defaultMaxTokens)
    + "  think=" + state.cfg.think
    + "  template=" + effectiveTemplate()
    + "  ollama=" + state.cfg.ollamaUrl;
  // 把 messages 拆开显示:system + 最后一条 user(或续笔的 assistant+user)
  const sysMsg = msgs.find(m=>m.role==="system");
  el("reqSys").value = sysMsg ? sysMsg.content : "";
  if(state.mode === "completion"){
    if(el("reqUserLabel")) el("reqUserLabel").textContent = "Prompt(纯文本补全:设定+前文+断点原文,无'请继续')";
    el("reqUser").value = built.prompt || "";
  } else if(state.mode === "complete"){
    if(el("reqUserLabel")) el("reqUserLabel").textContent = "Messages(前文=assistant 上一条 + user=继续)";
    const a = msgs.find(m=>m.role==="assistant");
    const u = msgs.find(m=>m.role==="user");
    el("reqUser").value = (a ? "[assistant 前文]\n" + a.content + "\n\n" : "") + (u ? "[user]\n" + u.content : "");
  } else {
    if(el("reqUserLabel")) el("reqUserLabel").textContent = "User(用户提示 = 设定+前文窗口+指令)";
    const u = msgs.find(m=>m.role==="user");
    el("reqUser").value = u ? u.content : "";
  }
  el("reqSheet").classList.add("open");
}
function setDraftActions(on){
  el("acceptBtn").disabled = !on;
  el("discardBtn").disabled = !on;
}
function acceptDraft(){
  const ch = V2.curChapter;
  const body = el("draftText").value;
  if(!ch || !body.trim()) return;
  undoStack.push(ch.body || "");              // 撤销可回退本次插入
  ch.body += (ch.body && !ch.body.endsWith("\n") ? "\n" : "") + body;
  saveProjects();
  renderEditor();
  el("draftText").value = "";
  el("draftText").readOnly = true;
  el("draftStatus").textContent = "已插入正文";
  setDraftActions(false);
  undoStackPushTrim();
}
function collapsePreview(){
  // 窄屏「修改」插入正文后自动收起预览区(与 togglePreview 收起分支同逻辑)
  const p = el("thinkPanel"); if(!p || !p.classList.contains("open")) return;
  p.classList.remove("open");
  try{ localStorage.setItem("xietai.previewCollapsed.v1", "true"); }catch(e){}
  const b = el("togglePreview");
  if(b){ b.textContent = "⬆"; b.title = "恢复下方预览/思考区"; }
}
function discardDraft(){
  el("draftText").value = "";
  el("draftText").readOnly = true;
  el("draftStatus").textContent = "已放弃";
  setDraftActions(false);
}

/* 🧠 思考面板:只折叠"思考过程"那一块(#thinkBlock),不影响下方草稿预览 */
function toggleThink(){
  const hidden = el("thinkBlock").classList.toggle("collapsed");
  el("toggleThink").textContent = "🧠";
  el("toggleThink").title = hidden ? "展开思考过程" : "收起思考过程";
  localStorage.setItem("xietai.thinkCollapsed.v1", hidden);
}
/* ⬇ 预览区:折叠整个下方思考+草稿面板(与生成时 add open 一致) */
function togglePreview(){
  const hidden = el("thinkPanel").classList.toggle("open");  // open 控制显隐
  // 上面 toggle 返回 true 表示现在有 open(显示),false 表示已收起
  const collapsed = !hidden;
  el("togglePreview").textContent = collapsed ? "⬆" : "⬇";
  el("togglePreview").title = collapsed ? "恢复下方预览/思考区" : "收起下方预览/思考区";
  localStorage.setItem("xietai.previewCollapsed.v1", collapsed);
}
function restorePreviewState(){
  // 思考块单独记忆
  if(localStorage.getItem("xietai.thinkCollapsed.v1") === "true"){
    el("thinkBlock").classList.add("collapsed");
    el("toggleThink").textContent = "🧠";
    el("toggleThink").title = "展开思考过程";
  }
  // 整面板:默认收起还是展开?用户若上次收起了,则不 add open
  if(localStorage.getItem("xietai.previewCollapsed.v1") === "true"){
    el("thinkPanel").classList.remove("open");
    el("togglePreview").textContent = "⬆";
  } else {
    el("thinkPanel").classList.add("open");
    el("togglePreview").textContent = "⬇";
  }
}

/* 历史版本:左侧栏翻阅 + 复用 */
function renderHistory(){
  const box = el("historyList");
  if(!box) return;
  const q = (el("histSearch") && el("histSearch").value || "").trim().toLowerCase();
  let list = state.history || [];
  if(q) list = list.filter(h => (h.text||"").toLowerCase().includes(q));
  if(!list.length){ box.innerHTML = '<div class="hint">'+ (state.history.length? "无匹配历史" : "暂无历史") +'</div>'; return; }
  box.innerHTML = "";
  list.slice().reverse().forEach((h, i) => {
    // history 末尾最新；倒序后 i=0 是最近一条。原编号需还原
    const realIdx = state.history.indexOf(h);
    const div = document.createElement("div");
    div.className = "hist-item";
    const d = new Date(h.ts);
    const time = (""+d.getMonth()).padStart(2,"0")+"-"+(""+d.getDate()).padStart(2,"0")
      + " "+(""+d.getHours()).padStart(2,"0")+":"+(""+d.getMinutes()).padStart(2,"0");
    div.innerHTML = '<div class="hist-meta">#'+(state.history.length-realIdx)+' · '+time+' · '+(h.model||"")+'</div>'
      + '<div class="hist-snippet">'+(h.text||"").slice(0,40).replace(/\n/g," ")+'</div>';
    div.onclick = () => useHistory(realIdx);
    box.appendChild(div);
  });
}
function useHistory(idx){
  const h = state.history[idx];
  if(!h) return;
  el("draftText").value = h.text;
  el("draftText").readOnly = false;
  el("draftStatus").textContent = "来自历史 #"+(state.history.length-idx)+" · 已可编辑";
  setDraftActions(true);
  el("thinkPanel").classList.add("open");
  el("togglePreview").textContent = "⬇";
}

/* ---------------- 渲染 ---------------- */
function el(id){ return document.getElementById(id); }
function scrollEnd(node){ node.scrollTop = node.scrollHeight; }

function renderEditor(){
  const ch = V2.curChapter;
  const ta = el("editor");
  const txt = ch ? (ch.body||"") : "";
  if(ta && ta.value !== txt){ ta.value = txt; }
  el("charCount").textContent = txt.length + " 字";
  const nm = el("curName"); if(nm && ch) nm.value = ch.title || "";
  if(ta) ta.scrollTop = ta.scrollHeight;
  renderSanitizeBtn();
}
function setGeneratingUI(on){
  el("genBtn").disabled = on;
  el("genBtn").textContent = on ? "生成中..." : (state.mode==="complete" ? "代笔" : state.mode==="completion" ? "补全" : "续写");
  el("undoBtn").disabled = on;
}

// 切换续写模式:chat(深度续写) / complete(续笔·断点直续)
// 切换续写模式:chat(深度续写) / complete(续笔·断点直续) / completion(续接·真补全)
function setMode(mode, persist){
  if(!["chat","complete","completion"].includes(mode)) mode = "chat";
  state.mode = mode;
  if(persist) localStorage.setItem(LS_MODE, mode);
  const sel = el("modeSel");
  if(sel) sel.value = mode;
  const genBtn = el("genBtn");
  if(genBtn){
    if(!state.generating) genBtn.textContent = (mode==="complete" ? "代笔" : mode==="completion" ? "补全" : "续写");
    genBtn.classList.toggle("gen-chat", mode==="chat");
    genBtn.classList.toggle("gen-complete", mode==="complete");
    genBtn.classList.toggle("gen-completion", mode==="completion");
  }
  const instr = el("instruction");
  if(instr){
    instr.placeholder = (mode==="complete")
      ? "走向提示(可选):例如「用一段对话推进,克制写景」,仅作软约束,不进正文"
      : (mode==="completion")
        ? "写作方向(可选):插在断点前,仅作参考约束,不进正文"
        : "续写指令(可选):例如「让男主在此处出场,节奏放缓」";
  }
}
function renderProjectTabs(){
  const box = el("projectTabs");
  if(!box) return;
  box.innerHTML = "";
  // 从磁盘作品集读取（/api/works），点击即切换该作品并联动其宇宙
  (V2.works||[]).forEach(w=>{
    const b = document.createElement("button");
    b.className = "tab" + (w.id===V2.curWorkId ? " active":"");
    b.textContent = w.name || "未命名";
    b.title = "切换到作品集（自动联动其宇宙）";
    b.onclick = async ()=>{ await onSelectWork(w.id); renderWorldBrowser(); renderProjectTabs(); };
    box.appendChild(b);
  });
  const add = document.createElement("button");
  add.className="tab add"; add.textContent="+";
  add.title = "新建作品集";
  add.onclick = async ()=>{
    if(!sel().universe){
      if(!V2.universes.length){ await v2NewWorld(); }
      if(!sel().universe){ alert("先选择/新建一个宇宙"); return; }
    }
    await v2NewProject();
    renderProjectTabs();
  };
  box.appendChild(add);
}
function renderPool(){
  const box = el("poolList");
  box.innerHTML = "";
  const packs = state.packs.packs;
  const cur = editPack();
  if(!cur || !packs.length){
    box.innerHTML = '<div class="pool-empty">还没有设定包。点上方「+新建设定包」,或从 SillyTavern 世界书导入。</div>';
    return;
  }
  // 包内条目
  cur.entries.forEach((p, idx)=>{
    const card = document.createElement("div");
    card.className = "pool-card" + (p.level==="disabled" ? " off":"");
    const dis = p.level==="disabled";
    card.innerHTML = `
      <div class="pc-head">
        <input type="checkbox" class="pc-on" ${dis?"":"checked"} title="单独开启/禁用此条目"/>
        <input class="pc-title" value="${esc(p.title)}" placeholder="设定标题"/>
        <select class="pc-level">
          ${["always","optional","disabled"].map(l=>`<option value="${l}" ${l===p.level?"selected":""}>${ {always:"常驻",optional:"可选",disabled:"禁用"}[l] }</option>`).join("")}
        </select>
        <button class="pc-del" title="删除">✕</button>
      </div>
      <textarea class="pc-body" placeholder="设定正文...">${esc(p.body)}</textarea>
      <div class="pc-tags-row">
        <span class="pc-tags-label">标签</span>
        <input class="pc-tags" value="${esc((p.tags||[]).join(" "))}" placeholder="#人物 #世界观"/>
      </div>`;
    card.querySelector(".pc-on").onchange = e=>{ p.level = e.target.checked ? (p._prev||"optional") : "disabled"; if(e.target.checked) delete p._prev; else p._prev=p.level; savePacks(); renderPool(); };
    card.querySelector(".pc-title").oninput = e=>{ p.title=e.target.value; savePacks(); };
    card.querySelector(".pc-level").onchange = e=>{ p.level=e.target.value; if(p.level!=="disabled") p._prev=p.level; savePacks(); renderPool(); };
    card.querySelector(".pc-body").oninput = e=>{ p.body=e.target.value; savePacks(); };
    card.querySelector(".pc-tags").oninput = e=>{ p.tags=e.target.value.split(/[\s,,]+/).filter(Boolean); savePacks(); };
    card.querySelector(".pc-del").onclick = ()=>{ cur.entries.splice(idx,1); savePacks(); renderPool(); };
    box.appendChild(card);
  });
}
function esc(s){ return String(s||"").replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

function renderAll(){
  renderProjectTabs();
  renderEditor();
}

/* 带超时的 fetch:默认 8 秒,避免连接黑洞时永久卡在"加载中" */
async function fetchWithTimeout(url, opts={}, ms=8000){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), ms);
  try{ return await apiFetch(url, { ...opts, signal: ctrl.signal }); }
  finally{ clearTimeout(t); }
}
function describeErr(e, url){
  if(e && e.name === "AbortError") return "连接超时(8s 无响应,确认 11434 已开 / 地址正确)";
  const msg = (e && e.message) || String(e);
  if(/Failed to fetch|NetworkError|CORS/i.test(msg)) return "无法连接(CORS 或地址错误:"+url+")";
  return msg;
}

/* ---------------- 连接 / 模型 ---------------- */
/* 轻量连接探测:只更新连接状态,不碰参数、不重刷模型列表 */
/* 轻量连接探测：静默模式（默认）——成功不提示，仅超时/断开显示红字；每次续写强制扫描一次 */
async function probeConnection(quiet=true){
  try{
    const probeUrl = (state.cfg.backend === "online") ? apiBase() + "/models" : state.cfg.ollamaUrl + "/api/tags";
    const probeOpt = (state.cfg.backend === "online")
      ? { headers:{ "Authorization":"Bearer " + (state.cfg.onlineKey||"") }, cache:"no-store" }
      : { cache:"no-store" };
    const r = await fetchWithTimeout(probeUrl, probeOpt, 3000);
    if(!r.ok) throw new Error("status "+r.status);
    const j = await r.json();
    const n = (j.models||[]).length || (j.data||[]).length;
    if(!quiet){ el("connHint").textContent = "已连接 · " + n + " 个模型"; }
    else if(el("connHint").classList.contains("err")){ el("connHint").textContent = ""; el("connHint").classList.remove("err"); }
    return true;
  }catch(e){
    el("connHint").textContent = "⚠ 未连接: " + describeErr(e, state.cfg.ollamaUrl);
    el("connHint").classList.add("err");
    return false;
  }
}
/* 完整刷新:拉模型列表 + 恢复上次选择 + 套用预设（成功静默，失败红字提示） */
async function loadModels(){
  if(state.cfg.backend === "online"){
    try{
      const r = await fetchWithTimeout(apiBase() + "/models", { headers:{ "Authorization":"Bearer " + (state.cfg.onlineKey||"") }, cache:"no-store" }, 8000);
      if(!r.ok) throw new Error("status "+r.status);
      const j = await r.json();
      const models = (j.data||[]).map(m=>m.id).filter(Boolean);
      state.models = models;
      let sel = state.model;
      const last = localStorage.getItem(LS_MODEL);
      if(last && models.includes(last)) sel = last;
      else if(!(sel && models.includes(sel))) sel = (models[0] || "");
      state.model = sel;
      el("modelSel").innerHTML = models.map(m=>`<option ${m===state.model?"selected":""}>${m}</option>`).join("") || "<option>无模型</option>";
      if(el("connHint").classList.contains("err")){ el("connHint").textContent = ""; el("connHint").classList.remove("err"); }
      if(state.model) onModelSwitch(state.model, true);
      return;
    }catch(e){
      el("modelSel").innerHTML = "<option>加载失败</option>";
      el("connHint").textContent = "⚠ 在线 API 不可用:" + describeErr(e, apiBase());
      el("connHint").classList.add("err");
      // 列表不可用也恢复上次模型选择并套用绑定配置（生成失败会另行提示，配置不再"看起来丢失"）
      const last = localStorage.getItem(LS_MODEL);
      if(last && !state.model){ state.model = last; onModelSwitch(last, true); }
      return;
    }
  }
  try{
    const r = await fetchWithTimeout(state.cfg.ollamaUrl + "/api/tags");
    const j = await r.json();
    const models = (j.models||[]).map(m=>m.name);
    state.models = models;
    let sel = state.model;
    const last = localStorage.getItem(LS_MODEL);
    if(last && models.includes(last)) sel = last;
    else if(!(sel && models.includes(sel))) sel = (models[0] || "");
    state.model = sel;
    el("modelSel").innerHTML = models.map(m=>`<option ${m===state.model?"selected":""}>${m}</option>`).join("")
      || "<option>无模型</option>";
    if(el("connHint").classList.contains("err")){ el("connHint").textContent = ""; el("connHint").classList.remove("err"); }
    if(state.model) onModelSwitch(state.model, true);  // 强制套用(首次/手动重检)
  }catch(e){
    el("modelSel").innerHTML = "<option>加载失败</option>";
    el("connHint").textContent = "⚠ 未连接:" + describeErr(e, state.cfg.ollamaUrl);
    el("connHint").classList.add("err");
    // 列表不可用也恢复上次模型选择并套用绑定配置
    const last = localStorage.getItem(LS_MODEL);
    if(last && !state.model){ state.model = last; onModelSwitch(last, true); }
  }
}
function syncParamUI(){
  const map = [
    ["temperature","pTemperature","oTemperature"],
    ["top_p","pTopP","oTopP"],
    ["top_k","pTopK","oTopK"],
    ["repeat_penalty","pRepeat","oRepeat"],
    ["min_p","pMinP","oMinP"],
    ["max_tokens","pMaxTok","oMaxTok"],
  ];
  for(const [k, pid, oid] of map){
    if(el(pid)) el(pid).value = state.params[k];
    if(el(oid)) el(oid).textContent = state.params[k];
  }
}

/* ---------------- 事件绑定 ---------------- */
function bind(){
  el("genBtn").onclick = doGenerate;
  el("regenBtn").onclick = doGenerate;
  el("mobRedo").onclick = ()=>{ discardDraft(); doGenerate(); };                          // 重做=放弃并重新生成
  el("mobEdit").onclick = ()=>{ acceptDraft(); collapsePreview(); setTimeout(()=>{ const _e=el("editor"); if(_e) _e.focus(); }, 60); };  // 修改=插入并呼出输入法
  el("mobCont").onclick = ()=>{ acceptDraft(); doGenerate(); };                          // 继续=插入并继续生成
  el("acceptBtn").onclick = acceptDraft;
  el("discardBtn").onclick = discardDraft;
  el("undoBtn").onclick = doUndo;
  el("viewReqBtn").onclick = showRequest;
  el("closeReq").onclick = ()=> el("reqSheet").classList.remove("open");
  el("reqSheet").onclick = e=>{ if(e.target===el("reqSheet")) el("reqSheet").classList.remove("open"); };
  el("modelSel").onchange = e=>{ state.model = e.target.value; localStorage.setItem(LS_MODEL, state.model); onModelSwitch(state.model); };
  el("styleSel").onchange = onStyleChange;
  el("curName").onchange = e=>{ if(V2.curChapter){ V2.curChapter.title = e.target.value; saveProjects(); renderV2ChapterBar(); renderProjectTabs(); } };
  el("editor").oninput = e=>{ if(V2.curChapter){ V2.curChapter.body = e.target.value; saveProjects(); el("charCount").textContent = e.target.value.length+" 字"; } };
  const safeBtn = el("safeBtn");
  if(safeBtn) safeBtn.onclick = toggleSafeAuto;
  // 模式切换(续写 / 续笔)
  setMode(state.mode, false);
  el("modeSel").onchange = e=> setMode(e.target.value, true);
  el("toggleThink").onclick = ()=>{ if(matchMedia("(max-width:900px)").matches) togglePreview(); else toggleThink(); };
  el("togglePreview").onclick = togglePreview;
  el("togglePool").onclick = ()=>{ const _sb = el("sidebar"); _sb.classList.toggle("open"); wsMask(_sb.classList.contains("open")); };
el("wsClose").onclick = ()=>{ el("sidebar").classList.remove("open"); wsMask(false); };
  el("poolTab").onclick = ()=>{ if(el("togglePool") && el("togglePool").onclick) el("togglePool").onclick(); };
el("wsMask").onclick = ()=>{ el("sidebar").classList.remove("open"); wsMask(false); };
function wsMask(show){ const _m = el("wsMask"); if(_m){ _m.style.display = (show && matchMedia("(max-width:900px)").matches) ? "block" : "none"; } }
  el("toggleHistory").onclick = ()=> el("historyPanel").classList.toggle("open");
  el("clearThink").onclick = ()=>{ el("thinkText").textContent=""; el("draftText").textContent=""; };
  // 历史搜索 / 清空
  if(el("histSearch")) el("histSearch").oninput = ()=> renderHistory();
  if(el("histClear")) el("histClear").onclick = ()=>{ if(confirm("清空全部历史版本？当前正文不会被删除。")){ state.history = []; saveProjects(); renderHistory(); } };
  // v2 世界面板搜索 / 排序
  if(el("v2EntrySearch")) el("v2EntrySearch").oninput = ()=> renderV2WorldPanel();
  if(el("v2EntrySort")) el("v2EntrySort").onchange = ()=> renderV2WorldPanel();

  // 参数面板(弹窗)绑定
  const pmap = {
    pTemperature:["temperature",2], pTopP:["top_p",2], pTopK:["top_k",0],
    pRepeat:["repeat_penalty",2], pMinP:["min_p",2], pMaxTok:["max_tokens",0]
  };
  const omap = { pTemperature:"oTemperature", pTopP:"oTopP", pTopK:"oTopK", pRepeat:"oRepeat", pMinP:"oMinP", pMaxTok:"oMaxTok" };
  for(const pid in pmap){
    const [key, dec] = pmap[pid];
    el(pid).oninput = () => {
      state.params[key] = Number(el(pid).value);
      el(omap[pid]).textContent = state.params[key].toFixed(dec);
      saveParams();
      autoSaveModelParams();   // 调参即存:防抖写入当前模型预设
    };
  }
  // 模板下拉:列出 TEMPLATES
  el("tplSel").innerHTML = Object.keys(TEMPLATES).map(k=>`<option value="${k}">${TEMPLATES[k].label}</option>`).join("");
  el("tplSel").onchange = ()=>{ state.template = el("tplSel").value; el("tplHint").textContent = "已切换模板(未保存)"; };
  // 系统词编辑:实时更新 state.sysPrompt(生成时用 effectiveSysPrompt 取最新)
  el("sysPrompt").oninput = ()=>{ state.sysPrompt = el("sysPrompt").value; };

  el("openParams").onclick = ()=>{
    // 拉起弹窗时,把当前生效值灌入控件
    syncParamUI();
    el("paramSheet").classList.add("open");
  };
  el("closeParams").onclick = ()=> el("paramSheet").classList.remove("open");
  el("paramSheet").onclick = e=>{ if(e.target===el("paramSheet")) el("paramSheet").classList.remove("open"); };
  el("presetDefault").onclick = ()=>{
    applyParams({ ...(BUILTIN_PRESETS.defaultPreset?.params||DEFAULT_PARAMS), max_tokens:state.params.max_tokens });
    if(state.modelCfg[state.model]) delete state.modelCfg[state.model].params;  // 清专属预设回默认
    saveModelCfg();
    el("presetHint").textContent = "已恢复默认(并清除该模型专属预设)";
  };
  el("presetSave").onclick = ()=>{
    if(!state.model){ alert("先选一个模型"); return; }
    const mc = state.modelCfg[state.model] || (state.modelCfg[state.model] = {});
    mc.params = { ...state.params };
    saveModelCfg();
    el("presetHint").textContent = "已存为预设:"+state.model;
  };
  el("saveModelCfg").onclick = ()=>{
    if(!state.model){ alert("先选一个模型"); return; }
    const mc = state.modelCfg[state.model] || (state.modelCfg[state.model] = {});
    mc.template = el("tplSel").value;
    mc.params = { ...state.params };
    saveModelCfg();
    el("presetHint").textContent = "已保存本模型配置:"+state.model;
  };
  // 系统设置弹层:打开/关闭/保存(全局持久)
  if(el("openSys")) el("openSys").onclick = ()=>{
    el("sysPrompt").value = effectiveSysPrompt();
    el("sysSheet").classList.add("open");
  };
  if(el("closeSys")) el("closeSys").onclick = ()=> el("sysSheet").classList.remove("open");
  if(el("sysSheet")) el("sysSheet").onclick = e=>{ if(e.target===el("sysSheet")) el("sysSheet").classList.remove("open"); };
  if(el("saveSys")) el("saveSys").onclick = ()=>{
    state.sysPrompt = el("sysPrompt").value;
    saveSysSettings();
    v2Toast("系统提示词已保存(全局生效)", "ok");
    el("sysSheet").classList.remove("open");
  };
  el("presetManual").onclick = ()=> el("manualSheet").classList.add("open");
  el("closeManual").onclick = ()=> el("manualSheet").classList.remove("open");
  el("manualSheet").onclick = e=>{ if(e.target===el("manualSheet")) el("manualSheet").classList.remove("open"); };

  // 配置抽屉
  if(el("cfgBackend")) el("cfgBackend").onchange = syncCfgBackendUI;
  if(el("cfgPlatform")) el("cfgPlatform").onchange = e=> setOnlinePlatform(e.target.value);
  el("openCfg").onclick = ()=>{
    el("cfgBackend").value = state.cfg.backend || "local";
    el("cfgUrl").value = state.cfg.ollamaUrl;
    el("cfgOnlineBase").value = state.cfg.onlineBase || "";
    el("cfgOnlineKey").value = state.cfg.onlineKey || "";
    el("cfgTail").value = state.cfg.tailChars || CONFIG.defaultTailChars;
    el("cfgMax").value = state.cfg.maxTokens || CONFIG.defaultMaxTokens;
    el("cfgThink").checked = !!state.cfg.think;
    el("cfgAutoSum").checked = state.cfg.autoSummary!==false;
    el("cfgScan").checked = state.cfg.scanEnabled !== false;
    if(el("cfgFontScale")) el("cfgFontScale").value = String(state.cfg.fontScale || 1);
    const base = state.cfg.onlineBase || "";
    if(el("cfgPlatform")) el("cfgPlatform").value = base.includes("deepseek") ? "deepseek" : base.includes("siliconflow") ? "siliconflow" : "custom";
    syncCfgBackendUI();
    el("cfgSheet").classList.add("open");
  };
  el("saveCfg").onclick = ()=>{
    state.cfg.backend = el("cfgBackend").value || "local";
    state.cfg.ollamaUrl = el("cfgUrl").value.trim() || CONFIG.ollamaUrl;
    state.cfg.onlineBase = el("cfgOnlineBase").value.trim() || "https://api.siliconflow.cn/v1";
    state.cfg.onlineKey = el("cfgOnlineKey").value.trim() || "";
    state.cfg.tailChars = Number(el("cfgTail").value) || CONFIG.defaultTailChars;
    state.cfg.maxTokens = Number(el("cfgMax").value) || CONFIG.defaultMaxTokens;
    state.cfg.think = el("cfgThink").checked;
    state.cfg.autoSummary = el("cfgAutoSum").checked;
    state.cfg.scanEnabled = el("cfgScan").checked;
    state.cfg.fontScale = Number(el("cfgFontScale").value) || 1;
    applyFontScale(state.cfg.fontScale);
    saveCfg(); loadModels();
    if(REMOTE){   // 远程设备:密钥/地址存电脑端,手机浏览器不再持有
      fetch("/api/servercfg", { method:"PUT", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ onlineBase: state.cfg.onlineBase, onlineKey: state.cfg.onlineKey || "", ollamaUrl: state.cfg.ollamaUrl }) });
    }
    hideGateHint();   // 切换后端模式：隐藏上次生成的残留提示
    renderSanitizeBtn();   // 切模式刷新「一键安全/恢复原文」按钮状态
    el("cfgSheet").classList.remove("open");
  };
  el("resetCfg").onclick = ()=>{
    localStorage.removeItem(LS_CONFIG);
    localStorage.removeItem(LS_MODEL);
    state.cfg = { ...CONFIG };
    state.model = ""; state.appliedModel = null;
    el("cfgUrl").value = state.cfg.ollamaUrl;
    loadModels();
    el("connHint").textContent = "已重置为默认地址 " + state.cfg.ollamaUrl;
  };
  el("cfgSheet").onclick = e=>{ if(e.target===el("cfgSheet")) el("cfgSheet").classList.remove("open"); };
  bindSyncBtn();
  bindPackUI();
  bindV2();

  // 快捷键:Ctrl+Enter 续写
  el("editor").addEventListener("keydown", e=>{
    if(e.ctrlKey && e.key==="Enter"){ e.preventDefault(); doGenerate(); }
  });
  // 点连接状态文字 = 手动重检(拉列表+套预设)
  el("connHint").style.cursor = "pointer";
  el("connHint").title = "点击重新检测连接";
  el("connHint").onclick = ()=> loadModels();
  // 提示词工具页：新建 / 恢复内置
  const stAdd = el("styleAdd"); if(stAdd) stAdd.onclick = addStyle;
  const stReset = el("styleReset"); if(stReset) stReset.onclick = resetStyles;
  const piAdd = el("piAdd"); if(piAdd) piAdd.onclick = addPromptItem;
  /* 开发者设置(已隐藏,发布版): 原 SafeGate 开关绑定已移除,在线过滤默认开启 */
  //   // 开发者设置：在线过滤（SafeGate）开关
  //   const devSG = el("devSafeGate");
  //   if(devSG){
  //     devSG.checked = state.cfg.safeGate !== false;
  //     devSG.onchange = ()=>{
  //       state.cfg.safeGate = devSG.checked;
  //       saveCfg();
  //       hideGateHint();   // 开关切换：隐藏残留提示
  //       renderSanitizeBtn();
  //       v2Toast(devSG.checked ? "在线过滤已开启：在线模式下⚠️条目等同关闭" : "在线过滤已关闭：⚠️条目恢复原设置", devSG.checked ? "ok" : "err");
  //     };
  //   }
  // 词库管理：转化入口
  const ruleBuild = el("ruleBuild");
  if(ruleBuild) ruleBuild.onclick = buildUserRule;
}

/* ---------------- 启动 ---------------- */
/* 世界管理页窄屏 tab 切换(WorldBook 编辑 / 宇宙管理) */
/* ============ 移动端(窄屏)专属:布局搬运/浮层/tab/页名 ============ */
function bindWmTabs(){
  const tw = el("wmTabWb"), tu = el("wmTabUni");
  const wp = document.querySelector(".wm-wb-pane"), up = document.querySelector(".wm-universe-pane");
  if(!tw || !tu || !wp || !up) return;
  const show = wbFirst =>{
    tw.classList.toggle("on", wbFirst);
    tu.classList.toggle("on", !wbFirst);
    wp.style.display = wbFirst ? "" : "none";
    up.style.display = wbFirst ? "none" : "";
  };
  tw.onclick = ()=> show(true);
  tu.onclick = ()=> show(false);
}

/* 平行宇宙浮层(🌏,移动端):与🌐同款交互——气泡跳转编辑/✕移除/空白展开候选绑定 */
async function renderUniInfoPop(){
  const box = el("v2UniPop"); if(!box) return;
  await Promise.all([ loadUniverses(), loadWorldBooks() ]);
  const sel0 = V2.selection || {};
  const u = (V2.universes||[]).find(x=>x.id===sel0.universe);
  if(!u){
    box.innerHTML = '<div class="v2-pop-title">平行宇宙</div><div class="v2-pop-hint">当前未选择宇宙（在工作台左侧世界浏览器选择）</div>';
    return;
  }
  const bound = (u.worldBookIds||[]).map(id=>V2.wbCache[id]).filter(Boolean);
  box.innerHTML = `<div class="v2-pop-title">平行宇宙 · ${esc(u.name||"未命名")}</div>
    <div class="v2-pop-hint">点击气泡 → 跳转编辑；点 ✕ 移除；点空白处展开候选</div>
    <div class="v2-pop-pops">${bound.length
      ? bound.map(wb=>`<span class="v2-pop-bubble" data-wbid="${esc(wb.id)}">📖 ${esc(wb.name||wb.id)} <span class="x" data-wbid="${esc(wb.id)}">✕</span></span>`).join("")
      : `<span class="v2-pop-empty">该宇宙还没有世界书</span>`}</div>
    <div class="v2-pop-cands"></div>`;
  box.querySelectorAll(".v2-pop-bubble").forEach(b=>{
    b.onclick = (e)=>{ if(e.target.closest(".x")) return; gotoWbEditor(b.dataset.wbid); };
  });
  box.querySelectorAll(".x").forEach(x=>{
    x.onclick = async (e)=>{
      e.stopPropagation();
      const id = x.dataset.wbid;
      u.worldBookIds = (u.worldBookIds||[]).filter(i=>i!==id);
      await saveUniverse(u);
      await loadUniverses();
      await renderUniInfoPop();
    };
  });
  await renderUniCands(box, u);
}
/* 🌏 候选：未绑定到当前宇宙的书 → 点击绑定(与🌐候选同款) */
async function renderUniCands(box, u){
  const candsBox = box.querySelector(".v2-pop-cands"); if(!candsBox) return;
  const bound = u.worldBookIds||[];
  const cands = (V2.worldBooks||[]).filter(w=>!bound.includes(w.id));
  if(!cands.length){
    candsBox.innerHTML = `<div class="v2-pop-cands-title">（世界书库已全部绑定或为空，可先去世界管理页导入）</div>`;
  } else {
    candsBox.innerHTML = `<div class="v2-pop-cands-title">点击绑定到本宇宙：</div>`
      + cands.map(w=>`<div class="v2-pop-cand" data-wbid="${esc(w.id)}">📖 ${esc(w.name)}<span class="cnt">${w.entryCount||0} 条</span></div>`).join("");
    candsBox.querySelectorAll(".v2-pop-cand").forEach(c=>{
      c.onclick = async ()=>{
        const id = c.dataset.wbid;
        const b2 = u.worldBookIds||[];
        if(!b2.includes(id)){
          u.worldBookIds = b2.concat(id);
          await saveUniverse(u);
          await loadUniverses();
        }
        await renderUniInfoPop();
      };
    });
  }
}

/* 跳转世界管理页并选中指定 WorldBook(第5项核心,移动端入口:🌏 宇宙书气泡) */
async function gotoWbEditor(wbid){
  const up = el("v2UniPop"); if(up) up.classList.remove("open");
  const gpop = el("v2GlobalPop"); if(gpop) gpop.classList.remove("open");
  if(!V2.wbCache[wbid]){ try{ await loadWorldBook(wbid); }catch(e){} }
  V2._curWbId = wbid;   // 渲染前设好,renderWorldBookEditor 直接选中
  const btn = document.querySelector('.page-nav-btn[data-page="universe"]');
  if(btn) btn.click();
  if(window.matchMedia("(max-width:900px)").matches){
    const tw = el("wmTabWb"); if(tw) tw.click();   // 窄屏:确保停在 WorldBook 编辑 tab
  }
  v2Toast("已打开 WorldBook 编辑", "ok");
}

/* 移动端浮层:页面菜单(汉堡) + 模型选择 */
/* 移动端:点击正文区收回打开的抽屉(左世界浏览器/右设定池) — 下意识操作 */
function bindDismissDrawers(){
  document.addEventListener("pointerdown", (e)=>{
    if(!matchMedia("(max-width:900px)").matches) return;
    const ed = el("editor");
    if(!ed || !ed.contains(e.target)) return;
    const lp = el("v2WorldPanel"), rp = el("sidebar");
    let closed = false;
    if(lp && lp.classList.contains("open")){ lp.classList.remove("open"); closed = true; }
    if(rp && rp.classList.contains("open")){ rp.classList.remove("open"); closed = true; }
    if(closed) e.preventDefault();   // 本次点击只收抽屉,不唤起输入法
  }, true);
}
function bindMobPopups(){
  const navBtn = el("mobNavBtn"), navPop = el("mobNavPop"), mBtn = el("mobModelBtn"), mPop = el("mobModelPop");
  if(navBtn && navPop){
    navBtn.onclick = e=>{ e.stopPropagation(); if(mPop) mPop.style.display = "none"; navPop.style.display = navPop.style.display === "block" ? "none" : "block"; };
    navPop.querySelectorAll("button").forEach(b=> b.onclick = ()=>{
      const n = document.querySelector('.page-nav-btn[data-page="'+b.dataset.page+'"]');
      if(n) n.click();
      navPop.style.display = "none";
    });
  }
  if(mBtn && mPop){
    mBtn.onclick = e=>{ e.stopPropagation(); if(navPop) navPop.style.display = "none"; const sel = el("modelSel"); if(!sel) return;
      mPop.innerHTML = Array.from(sel.options).map(o=>`<button class="${o.value===state.model?"on":""}" data-m="${esc(o.value)}">${esc(o.text)}</button>`).join("");
      mPop.style.display = mPop.style.display === "block" ? "none" : "block";
    };
    mPop.onclick = e=>{ const b = e.target.closest("button[data-m]"); if(!b) return; const sel = el("modelSel");
      if(sel){ sel.value = b.dataset.m; if(sel.onchange) sel.onchange(); }
      mPop.style.display = "none";
    };
  }
  const stBtn = el("mobStyleBtn"), stPop = el("mobStylePop");
  if(stBtn && stPop){
    const fillStylePop = ()=>{
      const ssel = el("mobStyleSel"); if(!ssel) return;
      ssel.innerHTML = "";
      (state.styles||[]).forEach(p=>{
        const o = document.createElement("option");
        o.value = p.id; o.textContent = p.name;
        if(p.id === state.style) o.selected = true;
        ssel.appendChild(o);
      });
      const sp = el("mobSysPrompt"); if(sp) sp.value = effectiveSysPrompt();
    };
    stBtn.onclick = e=>{ e.stopPropagation();
      if(navPop) navPop.style.display = "none";
      if(mPop) mPop.style.display = "none";
      if(stPop.style.display === "block"){ stPop.style.display = "none"; return; }
      fillStylePop();
      stPop.style.display = "block";
    };
    const ssel = el("mobStyleSel");
    if(ssel) ssel.onchange = ()=>{ applyStyle(ssel.value, true); v2Toast("文风已切换:"+(state.styles.find(x=>x.id===ssel.value)||{}).name||ssel.value, "ok"); };
    const ssave = el("mobStyleSave");
    if(ssave) ssave.onclick = ()=>{
      const sp = el("mobSysPrompt"); if(sp){ state.sysPrompt = sp.value; saveSysSettings(); }
      stPop.style.display = "none";
      v2Toast("系统提示词已保存(全局生效)", "ok");
    };
  }
  const uniBtn = el("mobUniBtn"), uniPop = el("v2UniPop");
  if(uniBtn && uniPop){
    uniBtn.onclick = async e=>{ e.stopPropagation();
      if(navPop) navPop.style.display = "none";
      if(mPop) mPop.style.display = "none";
      const gpop = el("v2GlobalPop"); if(gpop) gpop.classList.remove("open");
      if(uniPop.classList.contains("open")){ uniPop.classList.remove("open"); return; }
      uniPop.classList.add("open"); uniPop.innerHTML = '<div class="v2-pop-title">平行宇宙</div><div class="v2-pop-hint">加载中…</div>';
      await renderUniInfoPop();
    };
  }
  document.addEventListener("click", e=>{
    if(e.target.closest(".mob-pop") || e.target.closest("#v2UniPop") || e.target.closest("#mobNavBtn") || e.target.closest("#mobModelBtn") || e.target.closest("#mobUniBtn") || e.target.closest("#mobStyleBtn")) return;
    if(navPop) navPop.style.display = "none";
    if(mPop) mPop.style.display = "none";
    if(stPop) stPop.style.display = "none";
    if(uniPop) uniPop.classList.remove("open");
  });
}
function updateMobPageTitle(){
  const t = el("mobPageTitle"); if(!t) return;
  const a = document.querySelector(".page-nav-btn.active");
  const map = { workbench:"工作台", universe:"世界管理", prompt:"提示词工具" };
  t.textContent = a ? (map[a.dataset.page] || a.textContent) : "工作台";
}
/* 移动端布局搬运:模式选择→标题行;全局按钮→顶栏(双向,跨断点复原) */
function mobLayout(){
  const mob = matchMedia("(max-width:900px)").matches;
  // 竖屏默认收起世界浏览器(仅首次窄屏,用户手动展开后不再干预)
  const wbPanel = el("v2WorldPanel");
  if(mob && wbPanel && wbPanel.dataset.guideInit === undefined){
    wbPanel.dataset.guideInit = "1";
    wbPanel.classList.remove("open");
  }
  const seg = el("modeSeg"), gb = el("v2GlobalBtn"), cur = el("curName");
  if(!seg || !gb || !cur) return;
  const head = cur.parentNode, mcb = el("mobChapterBar");
  const topR = document.querySelector(".top-right"), v2bar = document.querySelector(".v2-bar"), cmp = document.querySelector(".composer");
  const tk = el("toggleThink");
  if(tk) tk.textContent = mob ? "🔳" : "🧠";  // 移动端🔲折叠预览 / 桌面🧠思考折叠
  const gpop = el("v2GlobalPop");
  if(mob){
    if(seg.parentNode !== head) head.insertBefore(seg, mcb);                  // 模式→标题行(章节前)
    if(topR && gb.parentNode !== topR) topR.insertBefore(gb, el("openCfg"));  // 全局蓝色→顶栏
    if(gpop && gpop.parentNode !== document.body) document.body.appendChild(gpop); // 弹层→body(脱离隐藏的 v2-bar,配合 fixed 定位)
  } else {
    const ins = el("instruction");
    if(cmp && seg.parentNode !== cmp) cmp.insertBefore(seg, ins);             // 复原:composer 开头
    if(v2bar && gb.parentNode !== v2bar) v2bar.insertBefore(gb, el("openSys")); // 复原:v2-bar
    if(gpop && v2bar && gpop.parentNode !== v2bar) v2bar.appendChild(gpop);    // 复原:v2-bar 末尾(原位)
  }
}
async function init(){
  applyFontScale(state.cfg.fontScale || 1);
  mobLayout();
  bindMobPopups();
  bindDismissDrawers();
  bindWmTabs();
  updateMobPageTitle();
  window.addEventListener("resize", ()=>{ mobLayout(); });
  // 远程访问(手机/平板):拉取服务端配置(在线 Base/Ollama 地址;密钥存电脑,不回传) — 远程设备零配置
  if(REMOTE){
    try{
      const _r = await fetch("/api/servercfg");
      const sc = await _r.json();
      if(sc.onlineBase) state.cfg.onlineBase = sc.onlineBase;
      if(sc.ollamaUrl) state.cfg.ollamaUrl = sc.ollamaUrl;
    }catch(e){}
  }
  await loadBuiltinPresets();
  populateStyleSel();
  applyStyle(state.style, false);
  syncParamUI();
  bind();
  renderAll();
  renderHistory();
  restorePreviewState();
  state.initDone = true;
  // 刷新时自动整理索引：清理悬空引用（宇宙/作品/全局激活表），静默，失败无害
  fetchWithTimeout(location.origin + "/api/cleanup", { cache:"no-store" }, 8000).catch(()=>{});
  // ★ 启动性能:正文数据(本地 serve)与模型列表(远程 Ollama)互不依赖 → 并行加载。
  //   之前 loadModels 先 await,远程隧道一卡(8s 超时)正文就跟着等,刷新后要 ~10s 才出字。
  //   现在 initV2(正文)优先,loadModels 在后台异步刷新,模型下拉就绪即填充。
  const pModels = loadModels().catch(()=>{});
  await loadSafeGate().catch(()=>{});
  renderRuleManager();
  await initV2();
  await pModels;
  // 连接状态轮询:成功 5s / 失败 30s(断网时减少控制台刷屏)
  let probeGap = 5000;
  const probeLoop = async ()=>{
    const ok = await probeConnection(true);
    probeGap = ok ? 5000 : 30000;
    state.probeTimer = setTimeout(probeLoop, probeGap);
  };
  probeLoop();
}
// v2 状态命名空间（新语义：宇宙 Universe / 作品 Work / 章节 Chapter / 世界书 WorldBook）
const V2 = {
  universes: [],           // 宇宙列表 [{id,name,worldBookIds}]
  curUniverseId: null,     // 当前选中宇宙
  curUniverse: null,       // 完整宇宙 {id,name,worldBookIds}
  works: [],               // 作品列表 [{id,name,universeId,chapterIds}]
  curWorkId: null,         // 当前选中作品
  curWork: null,           // 完整作品 {id,name,universeId,chapterIds}
  workChapters: [],        // 当前作品的章节轻量列表 [{id,title}]
  chaptersCache: {},       // 作品章节缓存 workId -> [{id,title}]（左侧树展开任意作品集用）
  curChapterId: null,      // 当前章节
  curChapter: null,        // 完整章节 {id,title,tags,body,disabledEntryIds}
  worldBooks: [],          // 世界书库轻量列表 [{id,name,entryCount}]
  wbCache: {},             // 完整世界书缓存 id -> wb（ST 规范原样）
  globalActiveWB: [],      // 全局激活世界书 id 列表（来自 _global.json）
  globalSheetOpen: false,
  worldManagerOpen: false,
  loading: false,
  selection: { universe:null, work:null, chapter:null }, // 三级下钻选中态
  openUniverses: {},       // 展开的宇宙（id -> true）
  openWorks: {},           // 展开的作品（id -> true）
};

// v2 全局激活世界书（最高优先级，独立于宇宙/作品）——与 _global.json 同步
let V2_GLOBAL_ACTIVE = new Set();

function v2Server(){ return location.origin; }
/* 在线 API Base（OpenAI 兼容），去尾部斜杠 */
function apiBase(){ return String(state.cfg.onlineBase || "https://api.siliconflow.cn/v1").replace(/\/+$/, ""); }
/* 后端模式切换：只显示对应模式的输入栏 */
function syncCfgBackendUI(){
  const b = el("cfgBackend") ? el("cfgBackend").value : (state.cfg.backend || "local");
  document.querySelectorAll(".cfg-local").forEach(x=>{ x.style.display = (b === "local" ? "" : "none"); });
  document.querySelectorAll(".cfg-online").forEach(x=>{ x.style.display = (b === "online" ? "" : "none"); });
}
/* 在线平台预设：选平台自动填 Base URL（custom=手填） */
function setOnlinePlatform(v){
  const base = el("cfgOnlineBase");
  if(!base) return;
  if(v === "siliconflow") base.value = "https://api.siliconflow.cn/v1";
  else if(v === "deepseek") base.value = "https://api.deepseek.com/v1";
}
function apiHeaders(){ return { "Content-Type":"application/json", "Authorization":"Bearer " + (state.cfg.onlineKey || "") }; }
async function apiV2(method, path, body, silent= true, headers={}){
  const url = v2Server() + path;
  const opts = { method, headers:{ ...headers } };
  if(body !== undefined){
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const r = await fetchWithTimeout(url, opts, 10000);
  if(!r.ok){
    if(!silent) alert("API " + method + " " + path + " 失败: " + r.status);
    throw new Error("API " + r.status);
  }
  if(r.status === 204) return null;
  return await r.json().catch(()=>null);
}

function enc(s){ return encodeURIComponent(String(s)); }

/* ================ 安全闸门 SafeGate（出站条目过滤） ================
 * 机制: 顶部选择在线模式时,⚠️标记条目的注入等同「关闭」——优先于词条自身的
 *       常驻/逻辑/向量模式,在激活判定源头排除;不修改词条原设置(enabled/disable
 *       字段不动),切回本地模式自动恢复用户原设置。
 * 开关: 「提示词工具-开发者设置-在线过滤」可整体关闭(技术中性是声明,不是强制要求)。
 * 标记: 持久化于 safeGate.json,不随刷新恢复;扫描/生成时自动产生,UI 红框⚠️纯展示。
 * 规则: 纯本地哈希集匹配(rules/*.hash.json, serve.py /api/moderate),无模型、无明文词库。
 */
let SG = { flags: {}, catLabels: {}, rules: [], ruleDisabled: [] };
function SG_ACTIVE(){ return state.cfg.backend === "online" && state.cfg.safeGate !== false; }
async function loadSafeGate(){
  try{
    const g = await apiV2("GET", "/api/safegate");
    SG.flags = (g && g.flags) || {};
    SG.catLabels = (g && g.catLabels) || {};
    SG.rules = (g && g.rules) || [];
    SG.ruleDisabled = (g && g.ruleDisabled) || [];
  }catch(e){ SG.flags = {}; }
}
async function saveSafeGate(){
  try{ await apiV2("PUT", "/api/safegate", { flags: SG.flags, ruleDisabled: SG.ruleDisabled || [] }); }catch(e){}
}
function sgFlagOf(wbId, eid){ return (SG.flags || {})[wbId + ":" + eid] || null; }
function sgSetFlag(wbId, eid, cats){ SG.flags[wbId + ":" + eid] = { cats: cats || [], t: Date.now() }; }
function sgClearFlag(wbId, eid){ delete SG.flags[wbId + ":" + eid]; }
function sgCatText(cats){ return (cats||[]).map(c=>SG.catLabels[c]||c).join("/") || "违规"; }
async function sgCheckOne(text){
  try{
    const r = await apiV2("POST", "/api/moderate", { text: String(text||"").slice(0, 3000) });
    return (r && r.violation) ? r : { violation:false, cats:[] };
  }catch(e){ return { violation:false, cats:[] }; }   // 审查服务不可用 → 放行(不阻断写作)
}
/* 批量检查条目; items:[{wbId?,entryId?,title,body,wbName?}]
 * 返回 { blocked:[{title,wbName,cats,key}], flagSet:Set<key> } */
async function sgFilterEntries(items){
  const blocked = [], flagSet = new Set(), seen = new Set();
  const keyOf = it => (it.wbId && it.entryId) ? (it.wbId + ":" + it.entryId) : ((it.title||"") + "\u0000" + (it.wbName||""));
  await Promise.all(items.map(async it => {
    const key = keyOf(it);
    if(seen.has(key)) return; seen.add(key);
    const r = await sgCheckOne((it.title||"") + "\n" + (it.body||""));
    if(r.violation && r.cats && r.cats.length){
      if(it.wbId && it.entryId) sgSetFlag(it.wbId, it.entryId, r.cats);
      flagSet.add(key);
      blocked.push({ title: it.title || "(未命名)", wbName: it.wbName || "", cats: r.cats, key });
    }
  }));
  return { blocked, flagSet };
}

// ---- 宇宙 API ----
async function loadUniverses(){ V2.universes = (await apiV2("GET", "/api/universes")).universes || []; return V2.universes; }
async function loadUniverse(id){
  V2.curUniverse = await apiV2("GET", "/api/universes/" + enc(id));
  V2.curUniverseId = id;
  // 并行拉该宇宙绑定的世界书详情入缓存（供右侧面板/注入使用）
  if(V2.curUniverse && Array.isArray(V2.curUniverse.worldBookIds)){
    await Promise.all(V2.curUniverse.worldBookIds.map(wb=>loadWorldBook(wb).catch(()=>null)));
  }
  return V2.curUniverse;
}
async function saveUniverse(u){ const r = await apiV2("PUT", "/api/universes/" + enc(u.id), u); V2.curUniverse = r; V2.curUniverseId = r.id; return r; }
async function deleteUniverse(id){ await apiV2("DELETE", "/api/universes/" + enc(id)); }

// ---- 作品 API ----
async function loadWorks(){ V2.works = (await apiV2("GET", "/api/works")).works || []; return V2.works; }
async function loadWork(id){
  V2.curWork = await apiV2("GET", "/api/works/" + enc(id));
  V2.curWorkId = id;
  V2.workChapters = [];
  if(V2.curWork && Array.isArray(V2.curWork.chapterIds)){
    const r = await apiV2("GET", "/api/works/" + enc(id) + "/chapters");
    V2.workChapters = (r && r.chapters) || [];
  }
  // 缓存章节列表（左侧树展开任意作品集都显示自己的章节，不串目录）
  V2.chaptersCache[id] = V2.workChapters;
  return V2.curWork;
}
async function saveWork(w){ const r = await apiV2("PUT", "/api/works/" + enc(w.id), w); V2.curWork = r; V2.curWorkId = r.id; return r; }
async function deleteWork(id){ await apiV2("DELETE", "/api/works/" + enc(id)); }

// ---- 章节 API ----
async function loadChapter(wid, cid){
  const ch = await apiV2("GET", "/api/works/" + enc(wid) + "/chapters/" + enc(cid));
  if(ch){ V2.curChapter = ch; V2.curChapterId = cid; }
  return ch;
}
async function saveChapter(wid, cid, ch){ const r = await apiV2("PUT", "/api/works/" + enc(wid) + "/chapters/" + enc(cid), ch); return r; }
async function deleteChapter(wid, cid){ await apiV2("DELETE", "/api/works/" + enc(wid) + "/chapters/" + enc(cid)); }

// ---- 世界书 API ----
async function loadWorldBooks(){ V2.worldBooks = (await apiV2("GET", "/api/worldbooks")).worldBooks || []; return V2.worldBooks; }
async function loadWorldBook(id){ V2.wbCache[id] = await apiV2("GET", "/api/worldbooks/" + enc(id)); return V2.wbCache[id]; }
async function saveWorldBook(wb){ await apiV2("PUT", "/api/worldbooks/" + enc(wb.id), wb); V2.wbCache[wb.id] = wb; return wb; }
async function deleteWorldBook(id){ await apiV2("DELETE", "/api/worldbooks/" + enc(id)); delete V2.wbCache[id]; }
async function importWorldBook(stJson){ const r = await apiV2("POST", "/api/worldbooks/import", stJson); return r; }

// ---- 全局激活 ----
async function loadGlobal(){ const g = await apiV2("GET", "/api/global"); V2.globalActiveWB = (g && g.globalActiveWB) || []; V2_GLOBAL_ACTIVE = new Set(V2.globalActiveWB); return V2.globalActiveWB; }
async function saveGlobal(){ await apiV2("PUT", "/api/global", { globalActiveWB: V2.globalActiveWB || [] }); }

// ---- 激活解析（全局 ∪ 宇宙，服务端并集） ----
async function apiResolve(universeId){
  return await apiV2("GET", "/api/resolve", undefined, true, { "X-Universe": universeId || "" });
}

/* ---------------- 激活状态计算（新模型） ----------------
 * 激活集 = 全局激活(globalActiveWB) ∪ 当前宇宙 worldBookIds，并集去重；
 * 章节 disabledEntryIds 做条目级局部屏蔽（存于章节文件，不污染世界书本体）。
 */
function computeActiveEntries(){
  const result = [];
  const seen = new Set();
  const uni = V2.curUniverse;
  if(!uni) return result;
  const activeIds = [];
  for(const id of (V2.globalActiveWB || [])) if(id && !activeIds.includes(id)) activeIds.push(id);
  for(const id of (uni.worldBookIds || [])) if(id && !activeIds.includes(id)) activeIds.push(id);
  for(const id of activeIds){
    const wb = V2.wbCache && V2.wbCache[id];
    if(!wb || !wb.entries) continue;
    const entries = (typeof wb.entries === "object" && !Array.isArray(wb.entries)) ? Object.entries(wb.entries) : wb.entries.map((e,i)=>[String(e.uid ?? e.id ?? i), e]);
    for(const [k, e] of entries){
      const eid = String(e.uid ?? e.id ?? k);
      const key = id + ":" + eid;
      if(seen.has(key)) continue;
      if(e.enabled === false || e.disable === true || e.level === "disabled") continue;
      seen.add(key);
      result.push({ wbId: id, wbName: wb.name || id, entryId: eid, entry: e });
    }
  }
  // 章节局部屏蔽
  const ch = V2.curChapter;
  if(ch && Array.isArray(ch.disabledEntryIds) && ch.disabledEntryIds.length){
    const dis = new Set(ch.disabledEntryIds);
    for(let i = result.length - 1; i >= 0; i--){
      const e = result[i].entry;
      const eid = String(e.uid ?? e.id ?? result[i].entryId);
      if(dis.has(eid) || dis.has(String(result[i].entryId))) result.splice(i, 1);
    }
  }
  // SafeGate：在线模式下 ⚠️标记词条等同关闭（优先于常驻/逻辑/向量模式；不修改词条原设置，切回本地自动恢复）
  if(SG_ACTIVE()){
    for(let i = result.length - 1; i >= 0; i--){
      const e = result[i].entry;
      const eid = String(e.uid ?? e.id ?? result[i].entryId);
      if(sgFlagOf(result[i].wbId, eid)) result.splice(i, 1);
    }
  }
  return result;
}

/* ---------------- WorldBook 触发机制（完全对齐 SillyTavern 原版语义） ----------------
 * 存储字段与 ST 一致: constant / vectorized / selective / selectiveLogic(0=AND_ANY,1=NOT_ALL,2=NOT_ANY,3=AND_ALL) / scan
 * 激活顺序(ST world-info.js 4130-4265):
 *   1) constant=true → 直接激活(不扫描、不看词、不受扫描开关限制)
 *   2) 主词(keys)为空 → 跳过(副触发词不能独立触发)
 *   3) 主词命中(任一 keys,按 caseSensitive/matchWholeWords) → 无副词:直接激活
 *   4) 有副词:按 selectiveLogic 判定 —— AND_ANY(任一)/AND_ALL(全部)/NOT_ALL(非全部=反触发)/NOT_ANY(无任何=反触发)
 * 扫描开关: 全局 cfg.scanEnabled(关=仅常驻注入) + 条目级 e.scan(false=不参与扫描不触发) + 章节 disabledEntryIds 局部屏蔽
 */
let _vecCache = {};  // "wbId:eid" -> bool（向量匹配结果缓存）
/* 插入位置：自有映射（中文 UI；存储沿用 ST 的 position 0-6，导出兼容）
 * 0 开头       → prompt 最前(系统词之前)          [ST before]
 * 1 设定区     → 系统区末尾(常驻设定之后)          [ST after]
 * 2 作者注前   → 设定区·作者注之前                 [ST ANTop]
 * 3 作者注后   → 设定区·作者注之后                 [ST ANBottom]
 * 4 前文内     → 前文窗口内(深度由 depth 控制)      [ST atDepth]
 * 5 前文前     → 前文窗口之前(参考设定区)           [ST EMTop]
 * 6 前文前·末  → 前文窗口之前(参考设定区末尾)       [ST EMBottom]
 */
const WI_POS_NAMES = { 0:"开头", 1:"设定区", 2:"作者注前", 3:"作者注后", 4:"前文内", 5:"前文前", 6:"前文前·末尾" };
function wiPosName(stPos){
  const v = Number(stPos);
  return WI_POS_NAMES[v] || (isNaN(v) ? "默认" : "未知(" + v + ")");
}
function entryMode(e){
  e = e || {};
  if(e.constant === true || e.level === "always") return "constant";
  if(e.vectorized === true) return "vector";
  return "logic";
}
function escapeRe(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function keyHit(key, text, e){
  const kw = String(key||""); if(!kw) return false;
  let t = String(text||""), k = kw;
  if(e.caseSensitive !== true){ t = t.toLowerCase(); k = k.toLowerCase(); }
  if(e.matchWholeWords === true) return new RegExp("(^|[^\\p{L}\\p{N}])" + escapeRe(k) + "($|[^\\p{L}\\p{N}])", "u").test(t);
  return t.includes(k);
}
function entryMatches(e, text, hitKey){
  e = e || {};
  if(e.enabled === false || e.disable === true || e.level === "disabled") return false;
  const mode = entryMode(e);
  if(mode === "constant") return true;                       // ST: constant 直接激活
  if(state.cfg.scanEnabled === false) return false;          // 全局扫描关：仅常驻注入
  if(e.scan === false) return false;                         // 条目级扫描关
  if(mode === "vector") return _vecCache[hitKey||""] === true; // 向量：refreshVectorMatches 异步算好缓存
  // -- 逻辑(selective)模式:完全复刻 ST 激活顺序 --
  const keys = (e.keys||[]).filter(Boolean);
  if(!keys.length) return false;                             // ST: 主词为空跳过(副词不能独立触发)
  const kHit = keys.some(k=>keyHit(k, text, e));
  if(!kHit) return false;                                    // ST: 主词不中跳过
  const secs = (e.keysecondary||[]).filter(Boolean);
  if(!secs.length) return true;                              // ST: 主中+无副词=直接激活
  const logic = (e.selectiveLogic !== undefined && e.selectiveLogic !== null) ? Number(e.selectiveLogic) : 0;  // 缺省 AND_ANY
  const sHits = secs.map(k=>keyHit(k, text, e));
  const anyS = sHits.some(Boolean);
  const allS = sHits.every(Boolean);
  switch(logic){
    case 3: return allS;   // AND_ALL: 全部副词命中
    case 2: return !anyS;  // NOT_ANY: 无任何副词命中(有副词命中=排除)
    case 1: return !allS;  // NOT_ALL: 非全部副词命中(全部命中=排除)
    default: return anyS;  // AND_ANY: 任一副词命中
  }
}
/* 向量模式：正文与条目内容 embedding 余弦相似度 >= 阈值(默认0.6) */
async function embedText(t){
  try{
    if(state.cfg.backend === "online"){
      const r = await fetchWithTimeout(apiBase() + "/embeddings", {
        method:"POST", headers: apiHeaders(),
        body: JSON.stringify({ model: state.model, input: String(t||"").slice(0,2000) })
      }, 8000);
      if(!r.ok) return null;
      const j = await r.json();
      const embs = (j.data && j.data[0] && j.data[0].embedding);
      return Array.isArray(embs) ? embs : null;
    }
    const r = await fetchWithTimeout(state.cfg.ollamaUrl + "/api/embed", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ model: state.cfg.embedModel || "mxbai-embed-large", input: String(t||"").slice(0,2000) })
    }, 8000);
    if(!r.ok) return null;
    const j = await r.json();
    const embs = (j.embeddings||[])[0];
    return Array.isArray(embs) ? embs : null;
  }catch(e){ return null; }
}
function cosine(a, b){
  if(!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot=0, na=0, nb=0;
  for(let i=0;i<a.length;i++){ dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return (na && nb) ? dot/(Math.sqrt(na)*Math.sqrt(nb)) : 0;
}
/* 生成前调用：扫描正文，为 vector 条目算匹配结果（条目 embedding 缓存，正文每次重算） */
async function refreshVectorMatches(text){
  if(state.cfg.scanEnabled === false){ _vecCache = {}; return; }
  if(!V2.curUniverseId || !V2.curUniverse) return;
  const all = computeActiveEntries();
  const vecs = all.filter(x => entryMode(x.entry)==="vector" && x.entry.scan !== false);
  if(!vecs.length){ _vecCache = {}; return; }
  const tEmb = await embedText(text||"");
  if(!tEmb) return;   // embedding 不可用：向量条目不触发(静默降级)
  for(const x of vecs){
    const key = x.wbId + ":" + x.entryId;
    if(!x.entry._emb) x.entry._emb = await embedText((x.entry.content || x.entry.comment || "").slice(0,1500));
    _vecCache[key] = x.entry._emb ? cosine(tEmb, x.entry._emb) >= (Number(state.cfg.vectorThreshold) || 0.6) : false;
  }
}
function v2EntriesIfActive(text){
  if(!V2.curUniverseId || !V2.curUniverse) return null;
  const all = computeActiveEntries();
  const always = all.filter(x => entryMode(x.entry) === "constant")
                    .map(x => ({ title: entryTitle(x.entry), body: entryBody(x.entry), wbName: x.wbName, wbId: x.wbId, entryId: x.entryId }));
  const optional = all.filter(x => entryMode(x.entry) !== "constant");
  const matched = optional.filter(x => entryMatches(x.entry, text||"", x.wbId + ":" + x.entryId))
                    .map(x => ({ title: entryTitle(x.entry), body: entryBody(x.entry), wbName: x.wbName,
                      wbId: x.wbId, entryId: x.entryId,
                      pos: (x.entry.position !== undefined && x.entry.position !== null) ? Number(x.entry.position) : 5,
                      depth: Number(x.entry.depth) || 0 }));
  return { entries: all, always, optional, matched };
}

// 三级下钻交互状态
function sel(){ return V2.selection; }

/* ---------------- 左侧：世界浏览器（宇宙 → 作品 → 章节） ---------------- */
function renderWorldBrowser(){
  const box = el("v2WorldBrowser");
  if(!box) return;
  const q = (el("v2WorldSearch") && el("v2WorldSearch").value || "").trim().toLowerCase();
  const matchU = u => !q || (u.name||"").toLowerCase().includes(q);
  const matchW = w => !q || (w.name||"").toLowerCase().includes(q);
  const matchC = c => !q || (c.title||"").toLowerCase().includes(q);

  let html = "";
  for(const u of V2.universes){
    if(!matchU(u)) continue;
    const uOpen = V2.openUniverses[u.id] || (V2.universes.length === 1 && !q);
    const selU = sel().universe === u.id;
    html += nodeHtml("world", u.id, "🌐", (u.name||"未命名") + (q ? "" : " 宇宙"), (u.worldBookIds||[]).length + "书", uOpen, selU);
    if(uOpen){
      const ws = (V2.works || []).filter(w => (w.universeId||"") === u.id);
      let child = "";
      if(ws.length === 0) child = `<div class="v2-node chapter" style="opacity:.6">（无作品集）</div>`;
      for(const w of ws){
        if(!matchW(w)) continue;
        const wOpen = V2.openWorks[w.id] || (ws.length === 1 && !q);
        const selW = sel().work === w.id;
        child += nodeHtml("project", w.id, "📚", w.name, (w.chapterIds||[]).length + "章", wOpen, selW);
        if(wOpen){
          const chs = (V2.chaptersCache || {})[w.id] || [];
          let c2 = "";
          if(chs.length === 0) c2 = `<div class="v2-node chapter" style="opacity:.6">（无章节）</div>`;
          for(const c of chs){
            if(!matchC(c)) continue;
            c2 += nodeHtml("chapter", c.id, "📄", c.title || "未命名", "", false, sel().chapter === c.id);
          }
          child += `<div class="v2-children">${c2}</div>`;
        }
      }
      html += `<div class="v2-children">${child}</div>`;
    }
  }
  if(!html) html = `<div class="v2-empty">无匹配宇宙<br/><button class="mini-btn" id="v2EmptyNewUniverse">＋ 新建宇宙</button></div>`;
  box.innerHTML = `<div class="v2-tree">${html}</div>`;
  const nb = box.querySelector("#v2EmptyNewUniverse");
  if(nb) nb.onclick = v2NewWorld;

  box.querySelectorAll(".v2-node").forEach(n=>{
    n.onclick = (ev)=>{
      ev.stopPropagation();
      const type = n.dataset.type, id = n.dataset.id;
      if(type === "world"){
        const open = !V2.openUniverses[id];
        V2.openUniverses[id] = open;
        if(open){ onSelectUniverse(id); }
        renderWorldBrowser();
      } else if(type === "project"){
        const open = !V2.openWorks[id];
        V2.openWorks[id] = open;
        if(open){ onSelectWork(id); }
        renderWorldBrowser();
      } else if(type === "chapter"){
        onSelectChapter(id);
        renderWorldBrowser();
      }
    };
  });
}
function nodeHtml(type, id, icon, name, count, open, selected){
  return `<div class="v2-node ${type} ${open?"":"collapsed"} ${selected?"selected":""}" data-type="${type}" data-id="${esc(id)}">
    <span class="tw">${open?"▾":"▸"}</span>
    <span class="vn-name">${icon} ${esc(name)}</span>
    ${count?`<span class="vn-count">${esc(String(count))}</span>`:""}
  </div>`;
}
/* 页面左栏：WorldBook 编辑（工具栏 + 条目列表 + 放大编辑） */
/* ============ 世界管理页:WorldBook 编辑(左栏) ============ */
function renderWorldBookEditor(body){
  if(!body) return;
  const allWbs = (V2.worldBooks && V2.worldBooks.length)
    ? V2.worldBooks
    : (Object.keys(V2.wbCache).map(id=>({ id, name: (V2.wbCache[id]&&V2.wbCache[id].name)||id })));
  if(!V2._curWbId || !allWbs.some(w=>w.id===V2._curWbId)){
    V2._curWbId = allWbs.length ? allWbs[0].id : null;
  }
  const curWb = (V2._curWbId && V2.wbCache[V2._curWbId]) || null;
  let html = "";
  // —— 世界书操作常驻按钮排（WorldBook▼ 全库） ——
  html += `<div class="v2-wb-toolbar">
    <select id="v2WbSel" title="选择任意世界书（全库），下方列出其条目">${allWbs.map(w=>`<option value="${esc(w.id)}" ${w.id===V2._curWbId?"selected":""}>${esc(w.name||w.id)}</option>`).join("")||"<option value=''>（无）</option>"}</select>
    <button class="mini-btn v2-wb-rename" ${curWb?"":"disabled"} title="重命名当前世界书">改名</button>
    <button class="mini-btn v2-wb-newentry" ${curWb?"":"disabled"} title="在当前世界书新建条目">新建条目</button>
    <button class="mini-btn v2-wb-del" ${curWb?"":"disabled"} title="删除当前世界书(从所有宇宙引用与全局激活中移除,不可恢复)">删除</button>
    <span class="tb-sep">|</span>
    <button class="mini-btn v2-wb-sort" ${curWb?"":"disabled"} title="按当前显示顺序固化条目顺序">使用当前排序</button>
    <button class="mini-btn v2-wb-export" ${curWb?"":"disabled"} title="导出当前世界书为 SillyTavern JSON">导出</button>
    <button class="mini-btn v2-wb-import" title="导入 SillyTavern 世界书 JSON 并绑定">导入</button>
    <button class="mini-btn v2-wb-scan" ${curWb?"":"disabled"} title="扫描当前世界书条目(本地哈希规则,无模型):命中违规特征的条目红框⚠️标记">扫描</button>
    <button class="mini-btn v2-wb-new" title="新建一个空的世界书">新建</button>
  </div>`;




  // —— 条目列表（当前选中 WorldBook，任何世界书） ——
  if(curWb){
    const entries = entriesToArray(curWb.entries);
    html += `<div class="v2-curwb-entries">${entries.map(([k,e])=>entryCardHtml(curWb.id, k, e)).join("") || `<div class="v2-empty">该世界书无条目</div>`}</div>`;
  } else {
    html += `<div class="v2-empty">（世界书库为空，点「📥 导入」或「新建」）</div>`;
  }



  body.innerHTML = html;
  const wbSel = body.querySelector("#v2WbSel");
  if(wbSel) wbSel.onchange = e=> selectToolbarWb(e.target.value || null);
  body.querySelectorAll(".v2-wb-rename").forEach(b=>{ b.onclick = ()=> wbRename(); });
  body.querySelectorAll(".v2-wb-newentry").forEach(b=>{ b.onclick = ()=> wbNewEntry(); });
  body.querySelectorAll(".v2-wb-sort").forEach(b=>{ b.onclick = ()=> wbSortCurrent(); });
  body.querySelectorAll(".v2-wb-export").forEach(b=>{ b.onclick = ()=> wbExportCurrent(); });
  body.querySelectorAll(".v2-wb-import").forEach(b=>{ b.onclick = ()=>{
    if(!V2.curUniverse){ v2Toast("先在工作台选择一个宇宙（导入会自动绑定到该宇宙）", "err"); return; }
    importWbToUniverse(V2.curUniverse);
  }; });
  body.querySelectorAll(".v2-wb-scan").forEach(b=>{ b.onclick = ()=> wbScanCurrent(); });
  body.querySelectorAll(".v2-wb-new").forEach(b=>{ b.onclick = ()=> wbNewWorldBook(); });
  body.querySelectorAll(".v2-wb-del").forEach(b=>{ b.onclick = ()=> wbDeleteCurrent(); });
  body.querySelectorAll(".wi-row").forEach(row=> bindEntryRow(row));
}
/* 放大编辑：全屏大编辑框编辑条目内容 */
function wbZoomEdit(wbId, eid){
  const wb = V2.wbCache[wbId]; if(!wb){ v2Toast("世界书未加载", "err"); return; }
  const arr = entriesToArray(wb.entries);
  const idx = arr.findIndex(([k,e])=> String(e.uid ?? e.id ?? k) === eid);
  if(idx < 0){ v2Toast("条目不存在", "err"); return; }
  const e = arr[idx][1];
  el("wbZoomTitle").value = entryTitle(e);
  el("wbZoomKeys").value = (e.keys||[]).join(", ");
  el("wbZoomBody").value = entryBody(e);
  el("wbZoomSheet").classList.add("open");
  const doSave = async ()=>{
    e.comment = el("wbZoomTitle").value; e.title = el("wbZoomTitle").value;
    e.keys = el("wbZoomKeys").value.split(/[,，]/).map(x=>x.trim()).filter(Boolean);
    e.content = el("wbZoomBody").value; e.body = el("wbZoomBody").value;
    if(sgFlagOf(wbId, eid)) sgClearFlag(wbId, eid);
    wb.entries = entriesToDict(arr);
    await saveWorldBook(wb);
    renderWorldSettings();
    v2Toast("已保存", "ok");
    el("wbZoomSheet").classList.remove("open");
  };
  el("wbZoomSave").onclick = doSave;
  el("wbZoomClose").onclick = ()=> el("wbZoomSheet").classList.remove("open");
  el("wbZoomClose2").onclick = ()=> el("wbZoomSheet").classList.remove("open");
}
function renderWorldSettings(){
  // 页面左栏同步（世界管理页存在时）：WorldBook 编辑不依赖宇宙选中，放在早退之前
  if(el("wmWbBody")) renderWorldBookEditor(el("wmWbBody"));
  const head = el("wsHead");
  const body = el("v2WorldSettingsBody");
  if(!body) return;
  const uid = sel().universe;
  if(!uid || !V2.curUniverse || V2.curUniverse.id !== uid){
    if(head) head.textContent = "宇宙 | 世界传说";
    body.innerHTML = `<div class="v2-empty">← 在左侧选择宇宙<br/>即在此处显示它的世界传说</div>`;
    return;
  }
  const uni = V2.curUniverse;
  if(head) head.textContent = (uni.name||"未命名宇宙") + " · 宇宙信息";
  const wbIds = uni.worldBookIds || [];
  const boundWbs = wbIds.map(id=>V2.wbCache[id]).filter(Boolean);
  const uniOpen = (V2._uniOpen !== false);
  let html = "";
  const allWbs = (V2.worldBooks && V2.worldBooks.length)
    ? V2.worldBooks
    : (Object.keys(V2.wbCache).map(id=>({ id, name: (V2.wbCache[id]&&V2.wbCache[id].name)||id })));
  if(!V2._curWbId || !allWbs.some(w=>w.id===V2._curWbId)){
    V2._curWbId = allWbs.length ? allWbs[0].id : null;
  }
  const curWb = (V2._curWbId && V2.wbCache[V2._curWbId]) || null;
  html += `<div class="v2-sec-title v2-uni-toggle" id="v2UniToggle">${uniOpen?"▾":"▸"} 宇宙信息</div>`;
  html += `<div class="v2-uni-body" style="${uniOpen?"":"display:none"}">
    <div class="v2-bind-grid">
      <div class="v2-bind-head">
        <span class="bh-title">绑定设定书</span>
        <button class="mini-btn v2-bind-add" title="从世界书库选择绑定到本宇宙">＋ 绑定</button>
        <button class="mini-btn v2-bind-import" title="导入 SillyTavern 世界书并绑定">📥 导入</button>
      </div>
      <div class="v2-bind-bubbles">
        ${boundWbs.map(wb=>`<span class="v2-pop-bubble" data-wbid="${esc(wb.id)}">📕 ${esc(wb.name||wb.id)} <span class="x" data-wbid="${esc(wb.id)}">✕</span></span>`).join("") || `<div class="v2-pop-empty">尚未绑定世界书</div>`}
      </div>
      <div class="v2-bind-cands" style="display:none">
        <div class="v2-pop-cands-title">点击绑定（世界书库 − 已绑定）：</div>
        <div class="v2-bind-cand-list">加载中…</div>
      </div>
    </div>
  </div>`;



  // —— 世界书操作常驻按钮排（WorldBook▼ 全库） ——
  html += `<div class="v2-wb-toolbar">
    <select id="v2WbSel" title="选择任意世界书（全库），下方列出其条目">${allWbs.map(w=>`<option value="${esc(w.id)}" ${w.id===V2._curWbId?"selected":""}>${esc(w.name||w.id)}</option>`).join("")||"<option value=''>（无）</option>"}</select>
    <button class="mini-btn v2-wb-rename" ${curWb?"":"disabled"} title="重命名当前世界书">改名</button>
    <button class="mini-btn v2-wb-newentry" ${curWb?"":"disabled"} title="在当前世界书新建条目">新建条目</button>
    <span class="tb-sep">|</span>
    <button class="mini-btn v2-wb-sort" ${curWb?"":"disabled"} title="按当前显示顺序固化条目顺序">使用当前排序</button>
    <button class="mini-btn v2-wb-export" ${curWb?"":"disabled"} title="导出当前世界书为 SillyTavern JSON">导出</button>
    <button class="mini-btn v2-wb-import" title="导入 SillyTavern 世界书 JSON 并绑定">导入</button>
    <button class="mini-btn v2-wb-scan" ${curWb?"":"disabled"} title="扫描当前世界书条目(本地哈希规则,无模型):命中违规特征的条目红框⚠️标记">扫描</button>
    <button class="mini-btn v2-wb-new" title="新建一个空的世界书">新建</button>
  </div>`;



  // —— 条目列表（当前选中 WorldBook，任何世界书） ——
  if(curWb){
    const entries = entriesToArray(curWb.entries);
    html += `<div class="v2-curwb-entries">${entries.map(([k,e])=>entryCardHtml(curWb.id, k, e)).join("") || `<div class="v2-empty">该世界书无条目</div>`}</div>`;
  } else {
    html += `<div class="v2-empty">（世界书库为空，点「📥 导入」或「新建」）</div>`;
  }


  body.innerHTML = html;
  // 宇宙信息折叠
  const ut = body.querySelector("#v2UniToggle");
  if(ut) ut.onclick = ()=>{
    V2._uniOpen = !(V2._uniOpen !== false);
    const ub = body.querySelector(".v2-uni-body");
    if(ub) ub.style.display = V2._uniOpen ? "" : "none";
    ut.textContent = (V2._uniOpen ? "?" : "?") + " 宇宙信息";
  };
  // 绑定方格气泡点击 → WorldBook▼ 自动选中
  body.querySelectorAll(".v2-bind-bubbles .v2-pop-bubble").forEach(b=>{
    b.onclick = (e)=>{ if(e.target.closest(".x")) return; selectToolbarWb(b.dataset.wbid); };
  });
  // 解绑
  body.querySelectorAll(".v2-bind-bubbles .x").forEach(x=>{
    x.onclick = async ()=>{
      if(!confirm("从该宇宙解除此世界书？")) return;
      uni.worldBookIds = (uni.worldBookIds||[]).filter(i=>i!==x.dataset.wbid);
      await saveUniverse(uni);
      renderWorldSettings();
    };
  });
  // ＋绑定：展开/收起内联候选区
  body.querySelectorAll(".v2-bind-add").forEach(b=>{
    b.onclick = async ()=>{
      const cands = body.querySelector(".v2-bind-cands");
      if(!cands) return;
      const show = cands.style.display === "none";
      cands.style.display = show ? "" : "none";
      if(show) await renderBindCands(uni, body);
    };
  });
  // 工具栏：WorldBook▼ 切换
  const wbSel = body.querySelector("#v2WbSel");
  if(wbSel) wbSel.onchange = e=> selectToolbarWb(e.target.value || null);
  body.querySelectorAll(".v2-wb-rename").forEach(b=>{ b.onclick = ()=> wbRename(); });
  body.querySelectorAll(".v2-wb-newentry").forEach(b=>{ b.onclick = ()=> wbNewEntry(); });
  body.querySelectorAll(".v2-wb-sort").forEach(b=>{ b.onclick = ()=> wbSortCurrent(); });
  body.querySelectorAll(".v2-wb-export").forEach(b=>{ b.onclick = ()=> wbExportCurrent(); });
  body.querySelectorAll(".v2-bind-import, .v2-wb-import").forEach(b=>{ b.onclick = ()=> importWbToUniverse(uni); });
  body.querySelectorAll(".v2-wb-scan").forEach(b=>{ b.onclick = ()=> wbScanCurrent(); });
  body.querySelectorAll(".v2-wb-new").forEach(b=>{ b.onclick = ()=> wbNewWorldBook(); });
  // 条目：ST 式行内编辑 + 放大编辑
  body.querySelectorAll(".wi-row").forEach(row=> bindEntryRow(row));
}
/* WorldBook▼ 选中任意世界书（全库）；无缓存详情时先拉取再渲染 */
async function selectToolbarWb(id){
  V2._curWbId = id;
  if(id && !V2.wbCache[id]){
    try{ await loadWorldBook(id); }catch(e){ console.warn("加载世界书失败", id, e); }
  }
  renderWorldSettings();
}
/* ST 世界书条目字段兼容：标题=comment(或 title/name/key)，正文=content(或 body) */
function entryTitle(e){
  e = e || {};
  return e.comment || e.title || e.name || e.key || "未命名";
}
function entryBody(e){
  e = e || {};
  return e.content || e.body || "";
}

function entryCardHtml(wbId, key, e){
  const eid = String(e.uid ?? e.id ?? key);
  const disabled = (e.enabled===false || e.disable===true || e.level==="disabled");
  const chDis = V2.curChapter && Array.isArray(V2.curChapter.disabledEntryIds) ? V2.curChapter.disabledEntryIds : [];
  const off = disabled || chDis.includes(eid);
  const mode = entryMode(e);
  const logic = Number(e.selectiveLogic) || 0;
  const keys = (e.keys||[]).join(", ");
  const keys2 = (e.keysecondary||[]).join(", ");
  const scanOn = e.scan !== false;
  const pos = Number(e.position) || 0;
  const title = entryTitle(e);
  const body = entryBody(e);
  const hasCh = !!V2.curChapter;
  const flag = sgFlagOf(wbId, eid);
  // ST 呈现习惯:条目本身即编辑行(直接改,失焦/防抖保存);高级字段在 ⚙ 展开区
  return `<div class="wi-row ${off?"wi-off":""}${flag?" wi-sg":""}" data-wbid="${esc(wbId)}" data-eid="${esc(eid)}">
    ${flag?`<div class="wi-sg-badge" title="安全闸门:命中[${esc(sgCatText(flag.cats))}]。在线模式下等同关闭(优先于常驻/逻辑/向量模式,不修改原设置);本地模式按原设置注入。编辑内容或点✕清除标记后可恢复。">⚠️ ${esc(sgCatText(flag.cats))}<i class="wi-sg-clear" title="清除标记(恢复注入)">✕</i></div>`:""}
    <div class="wi-main">
      <label class="wi-en" title="启用/停用(条目级)"><input type="checkbox" class="wi-enable" ${!off?"checked":""}>${off?"<i>停</i>":""}</label>
      <input class="wi-title" value="${esc(title)}" placeholder="标题" title="标题(comment)" spellcheck="false">
      <input class="wi-keys" value="${esc(keys)}" placeholder="主触发词" title="主触发词,逗号分隔" spellcheck="false">
      <input class="wi-keys2" value="${esc(keys2)}" placeholder="副触发词" title="副触发词,逗号分隔" spellcheck="false">
      <select class="wi-logic" title="主+副触发词组合逻辑(四态)">
        <option value="0" ${logic===0?"selected":""}>任一命中</option>
        <option value="1" ${logic===1?"selected":""}>非全部(反触发)</option>
        <option value="2" ${logic===2?"selected":""}>无命中(反触发)</option>
        <option value="3" ${logic===3?"selected":""}>全部命中</option>
      </select>
      <textarea class="wi-body" rows="1" placeholder="注入AI的条目信息…" title="注入内容(可直接编辑,自动保存)">${esc(body)}</textarea>
      <select class="wi-pos" title="插入位置">
        ${Object.entries(WI_POS_NAMES).map(([v,n])=>`<option value="${v}" ${pos===Number(v)?"selected":""}>${n}</option>`).join("")}
      </select>
      ${hasCh?`<button class="wi-ch" title="在本章节屏蔽此条目(章节级,不影响其他章节)">📵</button>`:""}
      <button class="wi-more" title="高级:副触发词/模式/逻辑/深度/扫描">⚙</button>
      <button class="wi-zoom" title="放大编辑（大编辑框）">⛲</button>
      <button class="wi-del" title="删除条目">✕</button>
    </div>
        <div class="wi-detail">
      <label>副触发词 <input class="wi-keys2-d" value="${esc(keys2)}" placeholder="逗号分隔" spellcheck="false"></label>
      <label>触发逻辑
        <select class="wi-logic-d">
          <option value="0" ${logic===0?"selected":""}>任一命中</option>
          <option value="1" ${logic===1?"selected":""}>非全部(反触发)</option>
          <option value="2" ${logic===2?"selected":""}>无命中(反触发)</option>
          <option value="3" ${logic===3?"selected":""}>全部命中</option>
        </select>
      </label>
      <label>模式
        <select class="wi-mode">
          <option value="logic" ${mode==="logic"?"selected":""}>逻辑(扫描)</option>
          <option value="constant" ${mode==="constant"?"selected":""}>常驻(始终注入)</option>
          <option value="vector" ${mode==="vector"?"selected":""}>向量(语义)</option>
        </select>
      </label>
      <label>深度 <input class="wi-depth" type="number" min="0" max="10" value="${e.depth ?? 0}" title="仅「前文内」生效:0=紧贴断点前"></label>
      <label class="chk"><input type="checkbox" class="wi-scan" ${scanOn?"checked":""}> 参与扫描</label>
    </div>
  </div>`;
}
/* 行内编辑绑定:输入即改,防抖保存(500ms);启用切换/高级区/删除 */
function bindEntryRow(row){
  const wbid = row.dataset.wbid, eid = row.dataset.eid;
  const wb = V2.wbCache[wbid]; if(!wb) return;
  const arr = entriesToArray(wb.entries);
  const idx = arr.findIndex(([k,e])=> String(e.uid ?? e.id ?? k) === eid);
  if(idx < 0) return;
  const e = arr[idx][1];
  let timer = null, sgDirty = false;
  const clearFlag = ()=>{ if(sgFlagOf(wbid, eid)){ sgClearFlag(wbid, eid); sgDirty = true; } };
  const commit = ()=>{ clearTimeout(timer); timer = setTimeout(async ()=>{ wb.entries = entriesToDict(arr); await saveWorldBook(wb); if(sgDirty){ await saveSafeGate(); sgDirty = false; } }, 500); };
  const zoom = row.querySelector(".wi-zoom");
  if(zoom) zoom.onclick = ()=>{ wbZoomEdit(wbid, eid); };
  const en = row.querySelector(".wi-enable");
  if(en) en.onchange = ()=>{
    if(en.checked){
      delete e.level; delete e.disable; e.enabled = true;
      // 若该条目被章节级屏蔽(📵)，勾选=用户明确要启用 → 一并解除
      if(V2.curChapter && Array.isArray(V2.curChapter.disabledEntryIds)){
        const di = V2.curChapter.disabledEntryIds.indexOf(eid);
        if(di >= 0){
          V2.curChapter.disabledEntryIds.splice(di,1);
          if(V2.curWork) saveChapter(V2.curWork.id, V2.curChapter.id, V2.curChapter);
        }
      }
    }
    else { e.level = "disabled"; e.enabled = false; }
    commit(); renderWorldSettings();
  };
  const title = row.querySelector(".wi-title");
  if(title) title.oninput = ()=>{ e.comment = title.value; e.title = title.value; clearFlag(); commit(); };
  const keys = row.querySelector(".wi-keys");
  if(keys) keys.oninput = ()=>{ e.keys = keys.value.split(/[,，]/).map(s=>s.trim()).filter(Boolean); commit(); };
  const body = row.querySelector(".wi-body");
  if(body) body.oninput = ()=>{ e.content = body.value; e.body = body.value; clearFlag(); commit(); };
  const pos = row.querySelector(".wi-pos");
  if(pos) pos.onchange = ()=>{ e.position = Number(pos.value); commit(); };
  const more = row.querySelector(".wi-more");
  const det = row.querySelector(".wi-detail");
  if(more && det) more.onclick = ()=>{
    det.classList.toggle("open");
    // 展开时同步高级区字段(横屏下行内 keys2/logic 隐藏, 以高级区为准)
    const k2d = det.querySelector(".wi-keys2-d");
    if(k2d) k2d.value = (e.keysecondary||[]).join(", ");
    const ld = det.querySelector(".wi-logic-d");
    if(ld) ld.value = String(Number(e.selectiveLogic) || 0);
  };
  const keys2 = row.querySelector(".wi-keys2");
  if(keys2) keys2.oninput = ()=>{ e.keysecondary = keys2.value.split(/[,，]/).map(s=>s.trim()).filter(Boolean); commit(); };
  const keys2d = row.querySelector(".wi-keys2-d");
  if(keys2d) keys2d.oninput = ()=>{ e.keysecondary = keys2d.value.split(/[,，]/).map(s=>s.trim()).filter(Boolean); commit(); };
  const logicd = row.querySelector(".wi-logic-d");
  if(logicd) logicd.onchange = ()=>{ e.selectiveLogic = Number(logicd.value); commit(); };
  const modeSel = row.querySelector(".wi-mode");
  if(modeSel) modeSel.onchange = ()=>{
    const m = modeSel.value;
    if(m === "constant"){ e.constant = true; e.selective = false; delete e.vectorized; }
    else if(m === "vector"){ e.vectorized = true; e.constant = false; e.selective = true; }
    else { e.constant = false; e.selective = true; delete e.vectorized; }
    commit();
  };
  const logicSel = row.querySelector(".wi-logic");
  if(logicSel) logicSel.onchange = ()=>{ e.selectiveLogic = Number(logicSel.value); commit(); };
  const depth = row.querySelector(".wi-depth");
  if(depth) depth.oninput = ()=>{ e.depth = Number(depth.value) || 0; commit(); };
  const scan = row.querySelector(".wi-scan");
  if(scan) scan.onchange = ()=>{ e.scan = scan.checked; commit(); };
  const ch = row.querySelector(".wi-ch");
  if(ch) ch.onclick = ()=>{
    if(!V2.curChapter){ v2Toast("先选择章节", "err"); return; }
    const dis = V2.curChapter.disabledEntryIds = (V2.curChapter.disabledEntryIds || []);
    const i = dis.indexOf(eid);
    if(i < 0) dis.push(eid); else dis.splice(i,1);
    if(V2.curWork) saveChapter(V2.curWork.id, V2.curChapter.id, V2.curChapter).then(()=> renderWorldSettings());
  };
  const del = row.querySelector(".wi-del");
  if(del) del.onclick = ()=> entryEditDelete(wbid, eid);
  const sgClear = row.querySelector(".wi-sg-clear");
  if(sgClear) sgClear.onclick = ()=>{ clearFlag(); saveSafeGate().then(()=> renderWorldSettings()); };
}
function entriesToArray(entries){
  if(Array.isArray(entries)) return entries.map((e,i)=>[String(e.uid ?? e.id ?? i), e]);
  return Object.entries(entries || {});
}
function entriesToDict(arr){
  const d = {};
  for(const [k,e] of arr){ d[k] = e; }
  return d;
}

function curToolbarWb(){
  const uid = sel().universe;
  if(!uid) return null;
  const uni = V2.curUniverse;
  if(!uni || uni.id !== uid) return null;
  const wb = V2._curWbId && V2.wbCache[V2._curWbId];
  return wb || null;
}

/* 新建世界书（空库，创建后自动选中；绑定由「＋绑定」方格完成） */
async function wbNewWorldBook(){
  const n = prompt("世界书名称:", "新世界书"); if(!n) return;
  const id = "wb_" + Date.now();
  const wb = { id, name: n, entries: {} };
  await saveWorldBook(wb);
  await loadWorldBooks();
  V2._curWbId = id;
  renderWorldSettings();
  v2Toast("已新建世界书：" + n, "ok");
}

/* 改名当前世界书（写回 WorldBook 存储） */
/* ============ WorldBook 工具栏操作(wb* 系列) ============ */
async function wbRename(){
  const wb = curToolbarWb(); if(!wb) return;
  const n = prompt("世界书名称:", wb.name || wb.id); if(!n) return;
  wb.name = n;
  await saveWorldBook(wb);
  renderWorldSettings();
  v2Toast("已改名：" + n, "ok");
}

/* 删除当前世界书:删文件 + 全局激活移除 + 所有宇宙引用移除 */
async function wbDeleteCurrent(){
  const wb = curToolbarWb(); if(!wb) return;
  if(!confirm(`确定删除世界书「${wb.name||wb.id}」？\n将从所有宇宙引用与全局激活中移除，文件删除不可恢复。`)) return;
  await deleteWorldBook(wb.id);
  V2.worldBooks = (V2.worldBooks||[]).filter(w=>w.id!==wb.id);
  V2.globalActiveWB = (V2.globalActiveWB||[]).filter(i=>i!==wb.id);
  await saveGlobal();
  for(const u of (V2.universes||[])){
    if((u.worldBookIds||[]).includes(wb.id)){
      u.worldBookIds = u.worldBookIds.filter(i=>i!==wb.id);
      await apiV2("PUT", "/api/universes/" + enc(u.id), u);  // 直接 PUT,不走 saveUniverse 避免污染 curUniverse
    }
  }
  if(V2._curWbId === wb.id){
    const rest = V2.worldBooks||[];
    V2._curWbId = rest.length ? rest[0].id : null;
  }
  renderWorldSettings();
  renderWorldBrowser();
  v2Toast("已删除：" + (wb.name||wb.id), "ok");
}

/* 新建条目（ST 规范字段） */
async function wbNewEntry(){
  const wb = curToolbarWb(); if(!wb) return;
  const arr = entriesToArray(wb.entries);
  let maxUid = 0;
  for(const [,e] of arr){ const u = Number(e.uid ?? e.id ?? 0); if(u > maxUid) maxUid = u; }
  const uid = maxUid + 1;
  const key = String(uid);
  arr.push([key, { uid, key, title: "新条目", comment: "", content: "", constant: false, selective: false, keys: [], keysecondary: [], body: "", position: 4, depth: 4, enabled: true, order: arr.length, displayIndex: arr.length }]);
  wb.entries = entriesToDict(arr);
  await saveWorldBook(wb);
  const uid2 = sel().universe;
  if(!V2._openWb) V2._openWb = {};
  if(!V2._openWb[uid2]) V2._openWb[uid2] = {};
  V2._openWb[uid2][wb.id] = true;
  renderWorldSettings();
  v2Toast("已新建条目，展开编辑", "ok");
}

/* 使用当前排序：按显示顺序固化 displayIndex/order */
async function wbSortCurrent(){
  const wb = curToolbarWb(); if(!wb) return;
  const arr = entriesToArray(wb.entries);
  arr.forEach(([,e], i)=>{ e.displayIndex = i; e.order = i; });
  wb.entries = entriesToDict(arr);
  await saveWorldBook(wb);
  renderWorldSettings();
  v2Toast("已按当前显示顺序固化", "ok");
}

/* 词库管理：渲染三层哈希库列表 + 启用/停用开关 */
const RULE_LAYER_NAMES = { official:"官方", community:"社区", user:"用户", root:"根" };
function renderRuleManager(){
  const box = el("ruleList"); if(!box) return;
  const rows = (SG.rules||[]).map(r=>{
    const layer = RULE_LAYER_NAMES[r.layer] || r.layer;
    const off = !r.enabled;
    return `<div class="rule-row${off?" rule-off":""}" data-path="${esc(r.path)}">
      <span class="rule-layer rule-layer-${esc(r.layer)}">${esc(layer)}</span>
      <span class="rule-cat">${esc(r.cat)}</span>
      <span class="rule-label">${esc(r.label)}</span>
      <span class="rule-words">${r.words} 词</span>
      <label class="rule-switch"><input type="checkbox" class="rule-toggle" ${r.enabled?"checked":""}> ${off?"关":"开"}</label>
    </div>`;
  }).join("") || `<div class="v2-empty">（暂无词库，可在下方转化生成）</div>`;
  box.innerHTML = rows;
  box.querySelectorAll(".rule-toggle").forEach(t=>{
    t.onchange = async ()=>{
      const path = t.closest(".rule-row").dataset.path;
      let dis = (SG.ruleDisabled || []).slice();
      if(t.checked) dis = dis.filter(p=>p!==path);
      else if(!dis.includes(path)) dis.push(path);
      SG.ruleDisabled = dis;
      await saveSafeGate();          // 服务端落盘 + 重载规则（立即生效）
      await loadSafeGate();
      renderRuleManager();
      v2Toast(t.checked ? "已启用词库：" + path : "已停用词库：" + path, t.checked ? "ok" : "err");
    };
  });
}
/* 转化入口：明文词表 → 哈希集（POST /api/safegate/build，明文不落盘，写入 rules/user/） */
async function buildUserRule(){
  const cat = el("ruleCat").value.trim();
  const label = el("ruleLabel").value.trim();
  const words = el("ruleWords").value;
  if(!cat){ v2Toast("请填写类别标识 cat（字母/数字/_）", "err"); return; }
  if(!words.trim()){ v2Toast("请粘贴词表（每行一个词）", "err"); return; }
  const btn = el("ruleBuild"); if(btn) btn.disabled = true;
  try{
    const r = await apiV2("POST", "/api/safegate/build", { cat, label, words });
    if(r && r.error){ v2Toast("转化失败：" + r.error, "err"); }
    else{
      await loadSafeGate(); renderRuleManager();
      v2Toast("✅ 已转化 " + (r?r.added:0) + " 个新词（库内共 " + (r?r.words:0) + " 词），已写入并启用：" + cat, "ok");
      el("ruleWords").value = "";
    }
  }catch(e){ v2Toast("转化失败：" + (e && e.message), "err"); }
  if(btn) btn.disabled = false;
}

/* ================ 正文安全闸门（生成时检测） ================
 * 仅「在线模式 + 过滤开启」时生效：点击续写/重做时检查正文，命中违规特征 → 阻止发送 + 提示条。
 * 不做实时检测/标红/透明覆盖层（overlay 方案已弃用：复杂度高、易错位、维护成本大）。
 * 命中区间为原文坐标，哈希词明文不暴露；审查服务不可用时 fail-open。
 */
const GATE_ACTIVE = () => state.cfg.backend === "online" && state.cfg.safeGate !== false;
async function sgCheckPositions(text){
  try{
    const r = await apiV2("POST", "/api/moderate", { text: String(text||"").slice(0, 20000), positions: true });
    return r || { violation:false, hits:[] };
  }catch(e){ return { violation:false, hits:[] }; }   // 审查服务不可用 → 放行（fail-open）
}
function showGateHint(hits){
  const hint = el("gateHint");
  if(!hint) return;
  const cats = [...new Set(hits.map(h=>h.label||h.cat||"违规"))].join("/");
  hint.textContent = "⚠️ 正文含 " + hits.length + " 处[" + cats + "]特征，已阻止发送。修改正文后重试；或切换本地模型续写";
  hint.style.display = "";
}
function hideGateHint(){
  const hint = el("gateHint");
  if(hint) hint.style.display = "none";
}

/* ================ 文本自动脱敏（safeAuto 开关） ================
 * 开（默认）：在线模式发送时，把上下文里的敏感词映射为安全词后发出 —— 发送的是真正脱敏的文本（无规避），
 *            正文/历史原文不动，AI 返回原样追加（无还原）= 纯出站单向过滤，非越狱定义。
 * 关：回到"检测+阻止"模式（正文命中即拦截并提示）。
 * 本地模式不映射不检测。开关持久化于 state.cfg.safeAuto（LS_CONFIG）。
 */
const SG_SANITIZE_MAP = { gamble:"娱乐", fraud:"推销", drug:"药物", weapon:"器械", terror:"事件", porn:"低俗内容", selfharm:"行为", minor:"违禁内容", reactionary:"言论" };
/* 词级覆盖：常见敏感词 → 语义合理的替代（优先于类别默认词）。
 * 替代词全部经 /api/moderate 实测零命中（未命中任何词库），可安全发送。 */
const SG_SANITIZE_OVERRIDE = {
  // minor 未成年相关
  "幼女":"未成年少女", "萝莉":"未成年少女", "恋童":"特殊癖好", "炼铜":"特殊癖好",
  "儿童色情":"违法内容", "未成年人色情":"违法内容", "儿童性侵":"违法行为", "少女援交":"灰色交易",
  // porn 性交易/色情内容
  "卖淫":"交易", "嫖娼":"交易", "招嫖":"搭讪", "裸聊":"视频聊天", "援交":"灰色交易",
  "包养":"不当关系", "性交易":"交易", "黄色网站":"不良网站", "色情网站":"不良网站",
  "成人影片":"影片", "三级片":"影片", "黄片":"影片", "毛片":"影片", "情色小说":"小说", "色情图片":"图片",
  "色情视频":"视频", "淫秽视频":"视频", "艳照":"照片", "色情直播":"直播",
  // porn 常见单/双字
  "色情":"低俗内容", "淫秽":"低俗内容", "淫荡":"低俗内容", "露骨":"直白", "情色":"暧昧"
};
/* 脱敏替换核心：hits 区间从后往前替换（词级覆盖优先，类别默认兜底） */
function sanitizeText(text, hits){
  let out = text;
  for(const h of [...hits].sort((a,b)=> b.s - a.s)){
    const s = Math.max(0, h.s), e = Math.min(text.length, h.e);
    if(s >= e) continue;
    const word = text.slice(s, e);
    const rep = SG_SANITIZE_OVERRIDE[word] || SG_SANITIZE_MAP[h.cat] || "***";
    out = out.slice(0, s) + rep + out.slice(e);
  }
  return out;
}
/* 脱敏开关（safeAuto，默认开）：
 * 开 = 在线模式发送时自动映射敏感词为安全词（正文不动，返回不还原）；
 * 关 = 回到"检测+阻止"模式（正文命中即拦截）。
 * 本地模式不映射不检测（技术中性声明）。
 */
function renderSanitizeBtn(){
  const btn = el("safeBtn");
  if(!btn) return;
  const on = state.cfg.safeAuto !== false;
  btn.textContent = "🛡";
  btn.disabled = false;
  if(on){
    btn.classList.add("on");
    btn.title = "自动脱敏已开启：在线模式发送时敏感词自动替换为安全表述（正文不动）。点击关闭 → 检测+阻止";
  } else {
    btn.classList.remove("on");
    btn.title = "自动脱敏已关闭：正文含敏感词时阻止发送。点击开启";
  }
}
function toggleSafeAuto(){
  state.cfg.safeAuto = (state.cfg.safeAuto === false) ? true : false;
  saveCfg();
  renderSanitizeBtn();
  v2Toast(state.cfg.safeAuto !== false ? "自动脱敏已开启（仅在线模式生效，正文不会被改动）" : "自动脱敏已关闭：改为检测+阻止模式", state.cfg.safeAuto !== false ? "ok" : "err");
}

/* 扫描当前世界书全部条目：命中违规特征 → 持久化标记（红框⚠️，纯本地哈希规则，无模型） */
async function wbScanCurrent(){
  const wb = curToolbarWb(); if(!wb) return;
  const arr = entriesToArray(wb.entries);
  if(!arr.length){ v2Toast("该世界书无条目", "ok"); return; }
  v2Toast("正在扫描 " + arr.length + " 条…", "ok");
  const items = arr.map(([k,e])=>({ wbId: wb.id, entryId: String(e.uid ?? e.id ?? k), title: entryTitle(e) || "(未命名)", body: entryBody(e), wbName: wb.name || wb.id }));
  const res = await sgFilterEntries(items);
  await saveSafeGate();
  renderWorldSettings();
  if(res.blocked.length){
    v2Toast("⚠️ 扫描完成：命中 " + res.blocked.length + " 条 — " + res.blocked.map(b=>b.title).join("、").slice(0, 80), "err");
  } else {
    v2Toast("扫描完成：未发现违规特征", "ok");
  }
}

/* 导出当前世界书为 SillyTavern JSON */
function wbExportCurrent(){
  const wb = curToolbarWb(); if(!wb) return;
  const blob = new Blob([JSON.stringify(wb, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (wb.name || wb.id) + ".json";
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href), 2000);
  v2Toast("已导出：" + (wb.name||wb.id), "ok");
}

/* 保存编辑表单 */
async function entryEditDelete(wbid, eid){
  if(!confirm("删除该条目？")) return;
  const wb = V2.wbCache[wbid]; if(!wb) return;
  const arr = entriesToArray(wb.entries).filter(([k,e])=> String(e.uid ?? e.id ?? k) !== eid);
  wb.entries = entriesToDict(arr);
  await saveWorldBook(wb);
  renderWorldSettings();
  v2Toast("条目已删除", "ok");
}
function importWbToUniverse(uni){
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = ".json,application/json";
  inp.onchange = async ()=>{
    const fl = inp.files && inp.files[0]; if(!fl) return;
    const rd = new FileReader();
    rd.onload = async ()=>{
      try{
        const j = JSON.parse(rd.result);
        const wb = await importWorldBook(j);
        uni.worldBookIds = (uni.worldBookIds||[]).concat(wb.id);
        await saveUniverse(uni);
        await loadUniverse(uni.id);
        await loadWorldBooks();
        V2._curWbId = wb.id;
        renderWorldSettings(); renderWorldBrowser();
        v2Toast("已导入并绑定：" + (wb.name||wb.id), "ok");
      }catch(err){ alert("导入失败:" + err.message); }
    };
    rd.readAsText(fl);
  };
  inp.click();
}
/* 内联候选：绑定设定书（世界书库 − 已绑定，点击即绑定，不用浏览器输序号） */
async function renderBindCands(uni, body){
  const list = body.querySelector(".v2-bind-cand-list");
  if(!list) return;
  await loadWorldBooks();
  const bound = uni.worldBookIds || [];
  const cands = V2.worldBooks.filter(w=>!bound.includes(w.id));
  if(!cands.length){
    list.innerHTML = `<div class="v2-pop-empty">世界书库已全部绑定或为空（可先 📥 导入）</div>`;
    return;
  }
  list.innerHTML = cands.map(w=>`<span class="v2-pop-bubble v2-bind-cand" data-wbid="${esc(w.id)}">＋ 📕 ${esc(w.name)}</span>`).join("");
  list.querySelectorAll(".v2-bind-cand").forEach(c=>{
    c.onclick = async ()=>{
      const id = c.dataset.wbid;
      if(!(uni.worldBookIds||[]).includes(id)) uni.worldBookIds = (uni.worldBookIds||[]).concat(id);
      await saveUniverse(uni);
      renderWorldSettings();
      const wb = V2.wbCache[id];
      v2Toast("已绑定：" + ((wb && wb.name) || id), "ok");
    };
  });
}

/* 条目卡片（新布局，S6 补完整编辑）：标题/主触发词/触发逻辑(预留)/副触发词/注入信息/插入位置(预留)/插入深度 */
/* 记录导航状态(页面/宇宙/作品/章节),刷新后恢复 */
function saveLastNav(){
  const act = document.querySelector(".page-nav-btn.active");
  const nav = { page: act ? act.dataset.page : "workbench" };
  if(V2.selection && V2.selection.universe) nav.universe = V2.selection.universe;
  if(V2.selection && V2.selection.work) nav.work = V2.selection.work;
  if(V2.selection && V2.selection.chapter) nav.chapter = V2.selection.chapter;
  localStorage.setItem(LS_LASTNAV, JSON.stringify(nav));
}
async function onSelectUniverse(id){
  V2.selection.universe = id;
  await loadUniverse(id);
  renderWorldSettings();
  renderV2UniverseBar();
  saveLastNav();
}
async function onSelectWork(id){
  V2.selection.work = id;
  await loadWork(id);
  // 与作品集联动：自动切换其所属宇宙的宇宙信息
  if(V2.curWork && V2.curWork.universeId && V2.selection.universe !== V2.curWork.universeId){
    V2.selection.universe = V2.curWork.universeId;
    await loadUniverse(V2.curWork.universeId);
    renderWorldBrowser();
    renderV2UniverseBar();
  }
  renderWorldSettings();
  renderV2WorkBar();
  renderV2ChapterBar();
  renderWorldBrowser();  // 切换作品集后立即刷新左侧树，避免显示上一作品集的目录
  saveLastNav();
}
async function onSelectChapter(id){
  V2.selection.chapter = id;
  if(!V2.curWork) return;
  const ch = await loadChapter(V2.curWork.id, id).catch(()=>null);
  if(ch){
    const ta = el("editor");
    if(ta && ta.value !== (ch.body||"")){ ta.value = ch.body || ""; }
    el("charCount").textContent = ((ch.body)||"").length + " 字";
    const nm = el("curName"); if(nm) nm.value = ch.title || "";
  }
  renderWorldSettings();
  renderV2ChapterBar();
  saveLastNav();
}
function renderV2UniverseBar(){
  const box = el("v2WorldBar"); if(!box) return;
  box.innerHTML = (V2.universes||[]).map(u=>`<option value="${esc(u.id)}" ${u.id===sel().universe?"selected":""}>${esc(u.name||"未命名")}</option>`).join("") || "<option value=''>无宇宙</option>";
}
function renderV2WorkBar(){
  const box = el("v2ProjectBar"); if(!box) return;
  const ws = (V2.works||[]).filter(w=>(w.universeId||"")===sel().universe);
  box.innerHTML = ws.map(w=>`<option value="${esc(w.id)}" ${w.id===sel().work?"selected":""}>${esc(w.name||"未命名")}</option>`).join("") || "<option value=''>无作品集</option>";
}
/* 新用户引导:无选中章节时正文区纯色遮挡 + 三步引导卡(宇宙→作品→章节) */
function updateGuide(){
  const ov = el("guideOverlay"); if(!ov) return;
  const hasChap = !!(sel().work && sel().chapter && V2.curChapter);
  if(hasChap){ ov.style.display = "none"; return; }
  ov.style.display = "flex";
  const unis = V2.universes || [], works = V2.works || [], chs = V2.workChapters || [];
  const setDone = (id, done) => { const s = el(id); if(s) s.classList.toggle("done", done); };
  setDone("guideStepUni", unis.length > 0);
  setDone("guideStepWork", works.length > 0);
  setDone("guideStepChap", chs.length > 0);
  const b1 = el("guideNewUni"), b2 = el("guideNewWork"), b3 = el("guideNewChap");
  if(b1){ b1.disabled = false; b1.onclick = ()=> v2NewWorld().then(()=>updateGuide()); }
  if(b2){ b2.disabled = !unis.length; b2.onclick = ()=> v2NewProject().then(()=>updateGuide()); }
  if(b3){ b3.disabled = !works.length; b3.onclick = ()=> v2NewChapter().then(()=>updateGuide()); }
}
function renderV2ChapterBar(){
  const box = el("v2ChapterBar"); if(!box) return;
  const chs = (sel().work && V2.workChapters) ? V2.workChapters : [];
  const opts = chs.map(c=>`<option value="${esc(c.id)}" ${c.id===sel().chapter?"selected":""}>${esc(c.title||"未命名章节")}</option>`).join("") || "<option value=''>无章节</option>";
  box.innerHTML = opts;
  const mob = el("mobChapterBar");
  if(mob) mob.innerHTML = opts;   // 移动端标题行章节下拉同步
  const ren = el("v2RenameChapter");
  if(ren) ren.disabled = !(sel().work && sel().chapter);
  updateGuide();   // 新用户引导:章节状态变化时刷新遮挡/引导卡
}
async function onV2UniverseChange(id){ if(id){ V2.openUniverses[id]=true; await onSelectUniverse(id); renderWorldBrowser(); } }
async function onV2WorkChange(id){ if(id){ V2.openWorks[id]=true; await onSelectWork(id); renderWorldBrowser(); } }
async function onV2ChapterChange(id){ if(id){ await onSelectChapter(id); renderWorldBrowser(); } }
// 章节条目 killSwitch（写入章节 disabledEntryIds，存于章节文件）
async function toggleV2Entry(wbid, eid){
  if(!V2.curChapter){ v2Toast("先选择章节", "err"); return; }
  const dis = V2.curChapter.disabledEntryIds = (V2.curChapter.disabledEntryIds || []);
  const key = String(eid);
  const i = dis.indexOf(key);
  if(i < 0) dis.push(key); else dis.splice(i, 1);
  if(V2.curWork) await saveChapter(V2.curWork.id, V2.curChapter.id, V2.curChapter);
  renderWorldSettings();
}
function v2Toast(text, cls){
  const s = el("syncStatus");
  if(s){ setSyncStatus(text, cls || "ok"); setTimeout(()=>{ if(s.textContent===text) setSyncStatus(""); }, 2600); }
}
async function v2NewWorld(){
  const name = prompt("新宇宙名称（如：缘梦宇宙）:", "新宇宙"); if(!name) return;
  const u = await saveUniverse({ id: "u_" + Date.now(), name, worldBookIds: [] });
  await loadUniverses(); V2.openUniverses[u.id]=true;
  await onSelectUniverse(u.id); renderWorldBrowser(); renderV2UniverseBar();
  v2Toast("已新建宇宙：" + u.name, "ok");
}
async function v2NewProject(){
  if(!sel().universe){ alert("先在左侧选择一个宇宙"); return; }
  const name = prompt("新作品集名称:", "新作品集"); if(!name) return;
  const w = await saveWork({ id: "w_" + Date.now(), name, universeId: sel().universe, chapterIds: [] });
  await loadWorks(); V2.openWorks[w.id]=true;
  await onSelectWork(w.id); renderWorldBrowser(); renderV2WorkBar();
  v2Toast("已新建作品集：" + w.name, "ok");
}
/* 新建章节默认标题：按现有章节的序号格式推断下一个（第N章 / 纯数字 / Chapter N），
 * 识别不出回退「第 1 章」。只预填 prompt，用户仍可编辑。 */
function nextChapterTitle(pid){
  let chs = [];
  if(pid && V2.curWork === pid) chs = V2.workChapters || [];
  else if(!pid) chs = V2.workChapters || [];
  let maxN = 0, kind = null;
  for(const ch of chs){
    const t = String((ch && ch.title) || "").trim();
    let m = t.match(/^第\s*(\d+)\s*章/);
    if(m){ const n = +m[1]; if(n > maxN){ maxN = n; kind = "cn"; } continue; }
    m = t.match(/^(\d+)$/);
    if(m){ const n = +m[1]; if(n > maxN){ maxN = n; kind = "n"; } continue; }
    m = t.match(/^[Cc]hapter\s*(\d+)/);
    if(m){ const n = +m[1]; if(n > maxN){ maxN = n; kind = "ch"; } continue; }
  }
  if(kind === "cn") return "第 " + (maxN + 1) + " 章";
  if(kind === "n") return String(maxN + 1);
  if(kind === "ch") return "Chapter " + (maxN + 1);
  return "第 1 章";
}
async function v2NewChapter(){
  if(!sel().work){ alert("先在左侧选择一个作品集"); return; }
  const title = nextChapterTitle(sel().work);   // 免弹窗：自动续号命名，想改名用 ✎ 按钮
  const cid = "ch_" + Date.now();
  const ch = { id: cid, title, tags: [], body: "", disabledEntryIds: [] };
  await saveChapter(sel().work, cid, ch);
  await loadWork(sel().work);
  await onSelectChapter(cid); renderWorldBrowser(); renderV2ChapterBar();
  v2Toast("已新建章节：" + title, "ok");
}
/* ============ 全局激活(🌐) ============ */
function toggleV2Global(){
  const pop = el("v2GlobalPop"); if(!pop) return;
  V2.globalSheetOpen = !V2.globalSheetOpen;
  pop.classList.toggle("open", V2.globalSheetOpen);
  if(V2.globalSheetOpen){ renderV2GlobalSheet(); }
  const c = el("v2GlobalCands"); if(c){ c.classList.remove("open"); }
}
function renderV2GlobalSheet(){
  const popsBox = el("v2GlobalPops");
  const candsBox = el("v2GlobalCands");
  if(!popsBox || !candsBox) return;
  const act = (V2.globalActiveWB || []);
  if(!act.length){
    popsBox.innerHTML = `<div class="v2-pop-empty">尚未全局激活任何世界书</div>`;
  } else {
    popsBox.innerHTML = act.map(id=>{
      const wb = V2.wbCache[id] || { id, name: id };
      return `<span class="v2-pop-bubble" data-wbid="${esc(id)}">📕 ${esc(wb.name||id)} <span class="x" data-wbid="${esc(id)}">✕</span></span>`;
    }).join("");
    popsBox.querySelectorAll(".v2-pop-bubble").forEach(b=>{
      b.onclick = (e)=>{ if(e.target.closest(".x")) return; linkGlobalToUniverse(b.dataset.wbid); };
    });
    popsBox.querySelectorAll(".x").forEach(x=>{
      x.onclick = async ()=>{
        V2.globalActiveWB = (V2.globalActiveWB||[]).filter(i=>i!==x.dataset.wbid);
        await saveGlobal();
        renderV2GlobalSheet();
      };
    });
  }
  renderGlobalCands();
}

/* 候选列表（点击灰框空白处展开）：世界书库 - 已激活 */async function renderGlobalCands(){
  const box = el("v2GlobalCands"); if(!box) return;
  await loadWorldBooks();
  const act = V2.globalActiveWB || [];
  const cands = V2.worldBooks.filter(w=>!act.includes(w.id));
  if(!cands.length){
    box.innerHTML = `<div class="v2-pop-cands-title">（世界书库已全部激活或为空，可先在宇宙信息中导入）</div>`;
  } else {
    box.innerHTML = `<div class="v2-pop-cands-title">点击启用（加入全局激活）：</div>`
      + cands.map(w=>`<div class="v2-pop-cand" data-wbid="${esc(w.id)}">📕 ${esc(w.name)}<span class="cnt">${w.entryCount||0} 条</span></div>`).join("");
    box.querySelectorAll(".v2-pop-cand").forEach(c=>{
      c.onclick = async ()=>{
        const id = c.dataset.wbid;
        if(!(V2.globalActiveWB||[]).includes(id)){
          V2.globalActiveWB = (V2.globalActiveWB||[]).concat(id);
          await saveGlobal();
        }
        renderV2GlobalSheet();
      };
    });
  }
}

/* 点击全局气泡 → 联动宇宙信息：切换到该世界书所属宇宙、展开其行并滚动定位 */
/* 全局灰框点击气泡 → 与绑定方格一致的联动：WorldBook▼ 自动选中该书并列出条目
 * （编辑直接改 WorldBook 文件，不影响宇宙引用；若面板无宇宙上下文则自动切入该书所属宇宙） */
async function linkGlobalToUniverse(wbid){
  V2._curWbId = wbid;
  if(!V2.wbCache[wbid]){ try{ await loadWorldBook(wbid); }catch(e){} }
  if(window.matchMedia("(max-width:900px)").matches){
    // 窄屏：转跳到世界管理 → WorldBook 编辑
    gotoWbEditor(wbid);
  } else {
    // 宽屏：展开右侧 WorldBook 快捷编辑（不切换当前宇宙选中；未选宇宙时才定位到气泡所属宇宙）
    if(!sel().universe){
      await loadUniverses();
      const uni = V2.universes.find(u=>(u.worldBookIds||[]).includes(wbid));
      if(uni){ V2.openUniverses[uni.id] = true; await onSelectUniverse(uni.id); }
    }
    renderWorldSettings();
    const side = el("sidebar"); if(side) side.classList.add("open");
    const pop = el("v2GlobalPop"); if(pop) pop.classList.remove("open");
    V2.globalSheetOpen = false;
  }
}
/* focus: "wb"=WorldBook 编辑栏（左） / "uni"=宇宙管理栏（右）
 * 左上角「世界管理」按钮与右侧「平行世界管理」按钮分工：同一弹层，不同焦点 */
async function openWorldManager(){ await loadUniverses(); await loadWorks(); await loadWorldBooks(); renderWorldManager(); renderWorldSettings(); el("worldManagerSheet").classList.add("open"); }
/* ============ 世界管理页:宇宙管理(右栏) ============ */
async function renderWorldManager(body){
  const box = body || el("wmBody"); if(!box) return;
  if(!V2.universes.length){ box.innerHTML = '<div class="v2-empty">还没有宇宙。点上方「＋ 新建宇宙」。</div>'; return; }
  let html = "";
  for(const u of V2.universes){
    const ws = (V2.works||[]).filter(w=>(w.universeId||"")===u.id);
    const wbs = (u.worldBookIds||[]).map(id=>V2.wbCache[id]).filter(Boolean);
    html += `<div class="wm-world" data-wid="${esc(u.id)}">
      <div class="wm-world-head" data-wid="${esc(u.id)}">
        <span class="wm-name">${esc(u.name||"未命名")}</span>
        <span class="wm-meta">${ws.length} 作品集 · ${(u.worldBookIds||[]).length} 世界书${wbs.length?("（"+wbs.map(b=>b.name||b.id).join("、")+"）"):""}</span>
        <button class="mini-btn wm-rename-world" data-wid="${esc(u.id)}">重命名</button>
        <button class="mini-btn wm-del wm-del-world" data-wid="${esc(u.id)}">删除</button>
      </div>`;
    if(!ws.length){
      html += `<div class="wm-proj"><span class="wm-pname"><small>暂无作品集</small></span><button class="mini-btn wm-new-proj" data-wid="${esc(u.id)}">＋ 新建作品集</button></div>`;
    }
    for(const w of ws){
      const chs = (V2.curWorkId === w.id) ? (V2.workChapters||[]) : [];
      html += `<div class="wm-proj" data-pid="${esc(w.id)}">
        <span class="wm-pname">📘 ${esc(w.name||"未命名")} <small>${(w.chapterIds||[]).length} 章</small></span>
        <button class="mini-btn wm-new-chap" data-pid="${esc(w.id)}">＋ 章</button>
        <button class="mini-btn wm-rename-proj" data-pid="${esc(w.id)}">改名</button>
        <button class="mini-btn wm-del wm-del-proj" data-pid="${esc(w.id)}">删除</button>
      </div>`;
      if(V2.curWorkId === w.id){
        for(const c of chs){
          html += `<div class="wm-chap" data-pid="${esc(w.id)}" data-cid="${esc(c.id)}">
            <span class="wm-cname">§ ${esc(c.title||"未命名")}</span>
            <button class="mini-btn wm-rename-chap" data-pid="${esc(w.id)}" data-cid="${esc(c.id)}">改名</button>
            <button class="mini-btn wm-del wm-del-chap" data-pid="${esc(w.id)}" data-cid="${esc(c.id)}">删除</button>
          </div>`;
        }
      } else {
        html += `<div class="wm-chap" style="opacity:.6"><span class="wm-cname"><small>点击左侧树进入查看章节</small></span></div>`;
      }
    }
    html += `</div>`;
  }
  box.innerHTML = html;
  box.querySelectorAll(".wm-world-head").forEach(h=> h.onclick = e=>{ if(e.target.closest("button")) return; openWorldFromManager(h.dataset.wid); });
  box.querySelectorAll(".wm-del-world").forEach(b=> b.onclick = ()=> delUniverse(b.dataset.wid));
  box.querySelectorAll(".wm-rename-world").forEach(b=> b.onclick = ()=> renameUniverse(b.dataset.wid));
  box.querySelectorAll(".wm-new-proj").forEach(b=> b.onclick = ()=> wmNewProject(b.dataset.wid));
  box.querySelectorAll(".wm-del-proj").forEach(b=> b.onclick = ()=> delWork(b.dataset.pid));
  box.querySelectorAll(".wm-rename-proj").forEach(b=> b.onclick = ()=> renameWork(b.dataset.pid));
  box.querySelectorAll(".wm-new-chap").forEach(b=> b.onclick = ()=> wmNewChapter(b.dataset.pid));
  box.querySelectorAll(".wm-del-chap").forEach(b=> b.onclick = ()=> delChapter(b.dataset.pid, b.dataset.cid));
  box.querySelectorAll(".wm-rename-chap").forEach(b=> b.onclick = ()=> renameChapter(b.dataset.pid, b.dataset.cid));
  // 无参调用（弹层）时，若页面右栏存在则同步刷新，避免“退出重进才更新”
  if(!body && el("wmBodyPage") && el("wmBodyPage") !== box) renderWorldManager(el("wmBodyPage"));
}
async function openWorldFromManager(wid){ await onSelectUniverse(wid); renderWorldBrowser(); renderV2UniverseBar(); el("worldManagerSheet").classList.remove("open"); }
async function wmNewProject(wid){ const name = prompt("新作品集名称:", "新作品集"); if(!name) return; const w = await saveWork({ id:"w_"+Date.now(), name, universeId:wid, chapterIds:[] }); await loadWorks(); V2.openWorks[w.id]=true; await onSelectWork(w.id); renderWorldManager(); }
async function wmNewChapter(pid){
  if(V2.curWork !== pid) await loadWork(pid);   // 确保 V2.workChapters 是目标作品的，推断序号准确
  const title = nextChapterTitle(pid);          // 免弹窗：自动续号命名
  const cid = "ch_"+Date.now(); const ch = { id:cid, title, tags:[], body:"", disabledEntryIds:[] };
  await saveChapter(pid, cid, ch); await loadWork(pid); renderWorldManager();
}
async function renameUniverse(wid){ const u = V2.universes.find(x=>x.id===wid); if(!u) return; const n = prompt("宇宙名称:", u.name); if(!n) return; u.name=n; await saveUniverse(u); await loadUniverses(); renderWorldManager(); renderV2UniverseBar(); }
async function renameWork(pid){ const w = V2.works.find(x=>x.id===pid); if(!w) return; const n = prompt("作品集名称:", w.name); if(!n) return; w.name=n; await saveWork(w); await loadWorks(); renderWorldManager(); renderV2WorkBar(); }
async function renameChapter(pid, cid){ const cur = (V2.workChapters||[]).find(x=>x.id===cid); const name = prompt("章节标题:", (cur&&cur.title)||""); if(!name) return; const ch = await apiV2("GET", "/api/works/"+enc(pid)+"/chapters/"+enc(cid)); if(!ch) return; ch.title = name; await saveChapter(pid, cid, ch); await loadWork(pid); renderWorldManager(); renderV2ChapterBar(); }
async function delUniverse(wid){ if(!confirm("删除宇宙？其下作品集不会被删除，但会失去宇宙绑定。")) return; await deleteUniverse(wid); await loadUniverses(); renderWorldManager(); renderWorldBrowser(); renderV2UniverseBar(); }
async function delWork(pid){ if(!confirm("删除作品集及其全部章节？")) return; await deleteWork(pid); await loadWorks(); renderWorldManager(); renderWorldBrowser(); renderV2WorkBar(); }
async function delChapter(pid, cid){ if(!confirm("删除该章节？")) return; await deleteChapter(pid, cid); await loadWork(pid); renderWorldManager(); renderWorldBrowser(); renderV2ChapterBar(); }
async function migrateLegacyToV2(force){
  // v1 迁移已废弃：数据层已重构为 Universes / works / WorldBook，浏览器旧 localStorage 不再合并。
}
async function initV2(){
  const last = loadJSON(LS_LASTNAV, null) || {};  // 开头读一次：恢复选择与页面恢复共用，避免被 onSelect* 的 saveLastNav 覆盖污染
  try{
    // 并行拉取:宇宙/作品/世界书/全局激活互不依赖
    await Promise.all([ loadUniverses(), loadWorks(), loadWorldBooks(), loadGlobal() ]);
    if(V2.universes.length){
      const first = V2.universes[0].id;
      // 刷新恢复：优先打开上次宇宙/作品/章节（不存在则回退第一个）
      const uniId = (last.universe && V2.universes.some(u=>u.id===last.universe)) ? last.universe : first;
      V2.openUniverses[uniId] = true;
      await onSelectUniverse(uniId);
      const uniWorks = (V2.works||[]).filter(w=>(w.universeId||"")===uniId);
      const wantWork = (last.work && uniWorks.some(w=>w.id===last.work)) ? last.work : (uniWorks[0] && uniWorks[0].id);
      if(wantWork){
        V2.openWorks[wantWork] = true;
        await onSelectWork(wantWork);
        const chs = V2.workChapters || [];
        const wantCh = (last.chapter && chs.some(c=>c.id===last.chapter)) ? last.chapter : (chs[0] && chs[0].id);
        if(wantCh) await onSelectChapter(wantCh);
      }
    }
    renderWorldBrowser();
    renderV2UniverseBar();
    renderV2WorkBar();
    renderV2ChapterBar();
    renderProjectTabs();
  }catch(e){ console.warn("v2 init 部分失败(可忽略):", e); }
  // 刷新恢复：切回上次所在页面（世界管理/提示词工具）——用内存 last，不重读 localStorage（避免读到被覆盖的 workbench）
  if(last.page && last.page !== "workbench"){
    const btn = document.querySelector('.page-nav-btn[data-page="'+last.page+'"]');
    if(btn) btn.click();
  }
  document.documentElement.classList.remove("restore-universe", "restore-prompt");  // 首帧类使命完成,移除后手动切页淡入恢复
}

/* ---------------- 提示词工具 · 风格预设编辑 ---------------- */
function renderStyleList(){
  const box = el("styleList"); if(!box) return;
  const styles = state.styles || [];
  if(!styles.length){ box.innerHTML = '<div class="v2-empty">还没有风格预设，点「＋ 新建风格」创建。</div>'; return; }
  box.innerHTML = styles.map(s=>`
    <div class="style-item" data-sid="${esc(s.id)}">
      <div class="style-item-head">
        <span class="style-name">${esc(s.name||s.id)}</span>
        <span class="style-desc">${esc(s.desc||"")}</span>
        <span class="style-badge">${s.id===state.style?"✓ 使用中":""}</span>
        <div class="style-ops">
          <button class="mini-btn style-pick" data-sid="${esc(s.id)}">使用</button>
          <button class="mini-btn style-edit-toggle" data-sid="${esc(s.id)}">编辑</button>
          <button class="mini-btn style-del" data-sid="${esc(s.id)}">删除</button>
        </div>
      </div>
      <div class="style-edit" data-sid="${esc(s.id)}" style="display:none">
        <label>名称 <input class="se-name" value="${esc(s.name||"")}"></label>
        <label>描述 <input class="se-desc" value="${esc(s.desc||"")}"></label>
        <label>系统提示词 <textarea class="se-sys" rows="4">${esc(s.sysPrompt||"")}</textarea></label>
        <div class="se-params">
          ${PARAM_KEYS.concat(["max_tokens"]).map(k=>{
            const v = (s.params && s.params[k]!==undefined) ? s.params[k] : ((DEFAULT_PARAMS[k]!==undefined?DEFAULT_PARAMS[k]:CONFIG.defaultMaxTokens));
            return `<label>${k} <input type="number" step="0.01" class="se-p" data-k="${k}" value="${v}"></label>`;
          }).join("")}
        </div>
        <div class="style-edit-ops">
          <button class="mini-btn style-save" data-sid="${esc(s.id)}">保存</button>
        </div>
      </div>
    </div>`).join("");
  box.querySelectorAll(".style-pick").forEach(b=> b.onclick = ()=>{ applyStyle(b.dataset.sid, true); populateStyleSel(); renderStyleList(); });
  box.querySelectorAll(".style-edit-toggle").forEach(b=> b.onclick = ()=>{
    const ed = box.querySelector(`.style-edit[data-sid="${b.dataset.sid}"]`);
    if(ed) ed.style.display = ed.style.display === "none" ? "block" : "none";
  });
  box.querySelectorAll(".style-save").forEach(b=> b.onclick = ()=>{
    const sid = b.dataset.sid;
    const item = box.querySelector(`.style-item[data-sid="${sid}"]`);
    const preset = (state.styles||[]).find(x=>x.id===sid); if(!preset) return;
    preset.name = ((item.querySelector(".se-name")||{}).value || "").trim() || preset.name;
    preset.desc = (item.querySelector(".se-desc")||{}).value || "";
    preset.sysPrompt = (item.querySelector(".se-sys")||{}).value || "";
    item.querySelectorAll(".se-p").forEach(inp=>{ preset.params = preset.params||{}; preset.params[inp.dataset.k] = Number(inp.value); });
    saveStyles();
    populateStyleSel();
    if(sid===state.style) applyStyle(sid, false);
    renderStyleList();
    v2Toast("风格预设已保存", "ok");
  });
  box.querySelectorAll(".style-del").forEach(b=> b.onclick = ()=>{
    const sid = b.dataset.sid;
    if(!confirm("删除风格预设「"+sid+"」?")) return;
    state.styles = (state.styles||[]).filter(x=>x.id!==sid);
    if(state.style===sid) applyStyle("custom", true);
    saveStyles(); populateStyleSel(); renderStyleList();
  });
}
function addStyle(){
  const name = prompt("新风格预设名称:", "新风格");
  if(!name) return;
  const id = "st_"+Date.now();
  (state.styles = state.styles||[]).push({ id, name, desc:"", sysPrompt:"你是一位小说续写助手。只输出续写的正文，不要解释、不要重复前文、不要包裹代码块。\n文风：", params:{...DEFAULT_PARAMS, max_tokens:Number(CONFIG.defaultMaxTokens)} });
  saveStyles(); populateStyleSel(); renderStyleList();
}
function resetStyles(){
  if(!confirm("恢复内置风格预设？你编辑过的自定义风格将被覆盖。")) return;
  state.styles = JSON.parse(JSON.stringify(STYLE_PRESETS));  // 深拷贝,避免后续编辑污染内置常量
  saveStyles(); populateStyleSel(); renderStyleList();
}
/* ---------------- 提示词条目(底层:对齐 ST extension_prompt 插入体系) ---------------- */
function savePromptItems(){ try{ localStorage.setItem(LS_PROMPTITEMS, JSON.stringify(state.promptItems||[])); }catch{} }
function renderPromptItems(){
  const box = el("piList"); if(!box) return;
  const items = state.promptItems || [];
  if(!items.length){ box.innerHTML = '<div class="v2-empty">还没有提示词条目。点「＋ 新建条目」添加（如：世界观总纲·before / 行动准则·in / 场景氛围·in_chat）。</div>'; return; }
  box.innerHTML = items.map(it=>`
    <div class="style-item" data-piid="${esc(it.id)}">
      <div class="style-item-head">
        <span class="style-name">${esc(it.name||it.id)}</span>
        <span class="style-desc">位置:${it.position} · 角色:${it.role} ${it.position==="in_chat"?("· 深度:"+(it.depth||0)):""} ${it.enabled===false?"· 已停用":""}</span>
        <label class="pi-enable"><input type="checkbox" class="pi-on" ${it.enabled===false?"":"checked"}>启用</label>
        <div class="style-ops">
          <button class="mini-btn pi-edit-toggle" data-piid="${esc(it.id)}">编辑</button>
          <button class="mini-btn style-del pi-del" data-piid="${esc(it.id)}">删除</button>
        </div>
      </div>
      <div class="style-edit" data-piid="${esc(it.id)}" style="display:none">
        <label>名称 <input class="pi-name" value="${esc(it.name||"")}"></label>
        <label>内容 <textarea class="pi-content" rows="3">${esc(it.content||"")}</textarea></label>
        <div class="se-params">
          <label>位置
            <select class="pi-pos">
              <option value="before" ${it.position==="before"?"selected":""}>开头（系统区最前）</option>
              <option value="in" ${it.position==="in"?"selected":""}>设定区（系统区末尾）</option>
              <option value="in_chat" ${it.position==="in_chat"?"selected":""}>前文内（按深度）</option>
            </select>
          </label>
          <label>角色
            <select class="pi-role">
              <option value="system" ${it.role==="system"?"selected":""}>系统</option>
              <option value="user" ${it.role==="user"?"selected":""}>用户</option>
              <option value="assistant" ${it.role==="assistant"?"selected":""}>助手</option>
            </select>
          </label>
          <label>深度(仅 in_chat) <input type="number" min="0" class="pi-depth" value="${Number(it.depth)||0}"></label>
        </div>
        <div class="style-edit-ops">
          <button class="mini-btn pi-save" data-piid="${esc(it.id)}">保存</button>
        </div>
      </div>
    </div>`).join("");
  box.querySelectorAll(".pi-on").forEach(c=> c.onchange = ()=>{
    const it = (state.promptItems||[]).find(x=>x.id===c.closest(".style-item").dataset.piid);
    if(it){ it.enabled = c.checked; savePromptItems(); }
  });
  box.querySelectorAll(".pi-edit-toggle").forEach(b=> b.onclick = ()=>{
    const ed = box.querySelector(`.style-edit[data-piid="${b.dataset.piid}"]`);
    if(ed) ed.style.display = ed.style.display === "none" ? "block" : "none";
  });
  box.querySelectorAll(".pi-save").forEach(b=> b.onclick = ()=>{
    const id = b.dataset.piid;
    const item = box.querySelector(`.style-item[data-piid="${id}"]`);
    const it = (state.promptItems||[]).find(x=>x.id===id); if(!it) return;
    it.name = ((item.querySelector(".pi-name")||{}).value || "").trim() || it.name;
    it.content = (item.querySelector(".pi-content")||{}).value || "";
    it.position = (item.querySelector(".pi-pos")||{}).value || "in";
    it.role = (item.querySelector(".pi-role")||{}).value || "system";
    it.depth = Number((item.querySelector(".pi-depth")||{}).value) || 0;
    savePromptItems(); renderPromptItems();
    v2Toast("提示词条目已保存", "ok");
  });
  box.querySelectorAll(".pi-del").forEach(b=> b.onclick = ()=>{
    const id = b.dataset.piid;
    if(!confirm("删除提示词条目「"+id+"」?")) return;
    state.promptItems = (state.promptItems||[]).filter(x=>x.id!==id);
    savePromptItems(); renderPromptItems();
  });
}
function addPromptItem(){
  const name = prompt("新提示词条目名称:", "新条目");
  if(!name) return;
  (state.promptItems = state.promptItems||[]).push({ id:"pi_"+Date.now(), name, content:"", role:"system", position:"in", depth:0, enabled:true });
  savePromptItems(); renderPromptItems();
}

/* ---------------- 页面导航（工作台 / 宇宙管理 / 提示词工具） ---------------- */
let _savedPreview = null;  // 离开工作台时保存的思考/预览状态
function bindPageNav(){
  const btns = document.querySelectorAll(".page-nav-btn");
  if(!btns.length) return;
  btns.forEach(b=>{
    b.onclick = ()=>{
      const page = b.dataset.page;
      btns.forEach(x=>x.classList.toggle("active", x===b));
      updateMobPageTitle();
      saveLastNav();
      // 世界管理/提示词工具页：自动折叠思考+预览；返回工作台恢复原状
      if(page === "workbench"){
        if(_savedPreview){
          if(_savedPreview.think) el("thinkPanel").classList.add("open");
          if(_savedPreview.thinkBlock) el("thinkBlock").classList.remove("collapsed");
          _savedPreview = null;
        }
      } else {
        _savedPreview = {
          think: el("thinkPanel") ? el("thinkPanel").classList.contains("open") : false,
          thinkBlock: el("thinkBlock") ? !el("thinkBlock").classList.contains("collapsed") : false
        };
        if(el("thinkPanel")) el("thinkPanel").classList.remove("open");
        if(el("thinkBlock")) el("thinkBlock").classList.add("collapsed");
      }
      const main = document.querySelector(".main");
      const v2bar = document.querySelector(".v2-bar");
      const composer = document.querySelector(".composer");
      const ph = el("pagePlaceholder");
      const pp = el("promptPage");
      if(page === "workbench"){
        if(main) main.style.display = "";
        if(v2bar) v2bar.style.display = "";
        if(composer) composer.style.display = "";
        if(ph) ph.style.display = "none";
        if(pp) pp.style.display = "none";
      } else if(page === "prompt"){
        if(main) main.style.display = "none";
        if(v2bar) v2bar.style.display = "none";
        if(composer) composer.style.display = "none";
        if(ph) ph.style.display = "none";
        if(pp) pp.style.display = "flex";
        renderStyleList();
        renderPromptItems();
        renderRuleManager();   // 词库管理：进入页面时刷新（外部可能已变化）
      } else {
        if(main) main.style.display = "none";
        if(v2bar) v2bar.style.display = "none";
        if(composer) composer.style.display = "none";
                if(ph) ph.style.display = "flex";
        if(pp) pp.style.display = "none";
        // 世界管理页：左 WorldBook 编辑 + 右 宇宙管理（initV2 已预载,直接渲染零等待;数据为空才兜底加载）
        if((V2.worldBooks||[]).length) renderWorldBookEditor(el("wmWbBody"));
        else loadWorldBooks().then(()=>{ renderWorldBookEditor(el("wmWbBody")); });
        if((V2.universes||[]).length) renderWorldManager(el("wmBodyPage"));
        else loadUniverses().then(async ()=>{
          await loadWorks();
          await renderWorldManager(el("wmBodyPage"));
        });
      }
    };
  });
}

/* ---------------- 事件绑定（v2 体系） ---------------- */
function bindV2(){
  if(el("v2WorldSearch")) el("v2WorldSearch").oninput = renderWorldBrowser;
  const wb = el("v2WorldBar"); if(wb) wb.onchange = e=> onV2UniverseChange(e.target.value);
  const pb = el("v2ProjectBar"); if(pb) pb.onchange = e=> onV2WorkChange(e.target.value);
  const cb = el("v2ChapterBar"); if(cb) cb.onchange = e=> onV2ChapterChange(e.target.value);
  const mcb = el("mobChapterBar"); if(mcb) mcb.onchange = e=> onV2ChapterChange(e.target.value);
  // 移动端:缩短长控件文案(指令占位符)
  if(matchMedia("(max-width:900px)").matches){
    const _ins = el("instruction");
    if(_ins) _ins.placeholder = "续写指令（可选）";
  }
  if(el("v2NewWorld")) el("v2NewWorld").onclick = v2NewWorld;
if(el("v2NewWorldSB")) el("v2NewWorldSB").onclick = v2NewWorld;  // 世界浏览器侧边栏头部(与v2-bar重复id,已改唯一)
  if(el("v2NewProjectSB")) el("v2NewProjectSB").onclick = v2NewProject;  // 窄屏补位:新建书籍(作品集)
  if(el("v2NewChapterSB")) el("v2NewChapterSB").onclick = v2NewChapter;  // 窄屏补位:新建章节
  if(el("wmNewWorldPage")) el("wmNewWorldPage").onclick = v2NewWorld;
  if(el("v2NewProject")) el("v2NewProject").onclick = v2NewProject;
  if(el("v2NewChapter")) el("v2NewChapter").onclick = v2NewChapter;
  if(el("v2RenameChapter")) el("v2RenameChapter").onclick = ()=>{
    const pid = sel().work, cid = sel().chapter;
    if(pid && cid) renameChapter(pid, cid);
  };
  if(el("v2GlobalBtn")) el("v2GlobalBtn").onclick = toggleV2Global;
  if(el("v2PanelToggle")) el("v2PanelToggle").onclick = ()=> el("v2WorldPanel").classList.toggle("open");
  if(el("v2PanelToggle2")) el("v2PanelToggle2").onclick = ()=> el("v2WorldPanel").classList.toggle("open");
  if(el("v2ManageWorldBar")) el("v2ManageWorldBar").onclick = ()=>{
    const nav = document.querySelector('.page-nav-btn[data-page="universe"]');
    if(nav) nav.click(); else openWorldManager();
  };
  if(el("v2ManageWorld")) el("v2ManageWorld").onclick = openWorldManager;
  if(el("wmNewWorld")) el("wmNewWorld").onclick = ()=> v2NewWorld().then(renderWorldManager);
  if(el("wmMergeLegacy")) el("wmMergeLegacy").onclick = ()=> migrateLegacyToV2(true);
  if(el("wmClose")) el("wmClose").onclick = ()=> el("worldManagerSheet").classList.remove("open");
  // 页面导航（工作台 / 宇宙管理 / 提示词工具）
  bindPageNav();
  // 全局|世界传说 灰框：点空白展开候选；点外部关闭
  const gpop = el("v2GlobalPop");
  if(gpop){
    gpop.onclick = e=>{
      if(e.target.closest(".v2-pop-bubble") || e.target.closest(".v2-pop-cand")) return;
      const c = el("v2GlobalCands"); if(c) c.classList.toggle("open");
    };
  }
  // 🌏 平行宇宙弹层：点空白展开候选绑定(与🌐同款)
  const upop = el("v2UniPop");
  if(upop){
    upop.onclick = e=>{
      if(e.target.closest(".v2-pop-bubble") || e.target.closest(".v2-pop-cand")) return;
      const c = upop.querySelector(".v2-pop-cands"); if(c) c.classList.toggle("open");
    };
  }
  document.addEventListener("click", e=>{
    const pop = el("v2GlobalPop");
    if(pop && pop.classList.contains("open")){
      const btn = el("v2GlobalBtn");
      if(!pop.contains(e.target) && !(btn && btn.contains(e.target))){
        pop.classList.remove("open");
        V2.globalSheetOpen = false;
      }
    }
  });
}

window.__v2 = { V2, computeActiveEntries, v2EntriesIfActive, loadUniverses, loadUniverse, loadWorks, loadWork, loadWorldBooks, loadWorldBook, renderWorldBrowser, renderWorldSettings, onSelectUniverse, onSelectWork, onSelectChapter, renderWorldManager, openWorldManager, migrateLegacyToV2 };

document.addEventListener("DOMContentLoaded", init);
