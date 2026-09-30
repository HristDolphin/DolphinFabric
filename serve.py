#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
续写工作台 · 后端（重构版 Phase 1 数据层）
数据布局（根目录）：
  WorldBook/<wb_id>.json      世界书（SillyTavern 规范，entries 字典原样直存）
  Universes/<u_id>Universes.json   宇宙：{id,name,worldBookIds:[wb_id...]}
  works/<w_id>/<w_id>works.json    作品目录：{id,name,universeId,chapterIds:[]}
  works/<w_id>/chapters/<c_id>.json 章节：{id,title,tags,body,disabledEntryIds:[]}
  _index.json                主索引（无状态）：universes / works / worldBooks
  _global.json               全局索引（含状态）：{globalActiveWB:[wb_id...]}
每次 导入/新建/删除 后自动重建索引。
"""
import os, sys, json, re, time, shutil, hashlib, unicodedata, socket, threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, unquote

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WB_DIR   = os.path.join(BASE_DIR, "WorldBook")
U_DIR    = os.path.join(BASE_DIR, "Universes")
W_DIR    = os.path.join(BASE_DIR, "works")
INDEX_F  = os.path.join(BASE_DIR, "_index.json")
GLOBAL_F = os.path.join(BASE_DIR, "_global.json")
SCFG_F = os.path.join(BASE_DIR, "servercfg.json")  # 服务端配置:在线 Base/Ollama(不再存密钥,不入 git)
PREF_F = os.path.join(BASE_DIR, "prefs.json")
# prefs.json 读-改-写锁:ThreadingHTTPServer 会并发处理请求,不加锁时
# "单条提交"与"全量推送"交错会互相覆盖(丢更新,表现为服务器风格预设被覆盖)。
_PREFS_LOCK = threading.Lock()      # 用户预设(系统提示词/风格预设/参数/提示词条目);不含任何密钥
LORE_F = os.path.join(BASE_DIR, u"续写台", "lorebooks", "packs.json")  # 设定包(前端 packs)服务端落盘点

def load_servercfg():
    """服务端配置。**在线密钥永不由服务端持有**:历史遗留的 onlineKey 一律忽略。"""
    try:
        with open(SCFG_F, encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        return {}
    if isinstance(cfg, dict):
        cfg.pop("onlineKey", None)
    return cfg

def save_servercfg(cfg):
    cfg = dict(cfg or {})
    cfg.pop("onlineKey", None)   # 双保险:任何调用都写不进密钥
    atomic_write(SCFG_F, cfg)    # 原子写:避免写入中途崩溃留下半个配置文件

# ---- 用户预设(服务端落盘) ----
# 为什么:系统提示词/风格预设等原先只存浏览器 localStorage,而 localStorage 按 origin(协议+主机+端口)
# 隔离 —— 路由器重分 IP / 换端口后就是一份全新空存储,表现为预设被"重置"且旧数据难以找回。
# 现在以服务端 prefs.json 为准,localStorage 仅作离线兜底。
PREF_ALLOWED = ("sysPrompt", "styles", "style", "modelCfg", "params", "promptItems", "template", "mode", "cfg")
# cfg 只允许落盘非敏感字段:onlineKey 永不落盘、永不下发
PREF_CFG_ALLOWED = ("backend", "ollamaUrl", "onlineBase", "tailChars", "maxTokens",
                    "think", "autoSummary", "scanEnabled", "fontScale")

def _sanitize_prefs(obj):
    out = {"updatedAt": int(time.time() * 1000)}
    if not isinstance(obj, dict):
        return out
    for k in PREF_ALLOWED:
        if k not in obj:
            continue
        if k == "cfg":
            c = obj.get("cfg") or {}
            if isinstance(c, dict):
                out["cfg"] = {kk: c[kk] for kk in PREF_CFG_ALLOWED if kk in c}
        else:
            out[k] = obj[k]
    return out

def load_lorebooks():
    """设定包(packs)读取:文件不存在/损坏时回空结构"""
    cur = slurp(LORE_F, None)
    if isinstance(cur, dict) and isinstance(cur.get("packs"), list):
        return cur
    return {"packs": [], "activePacks": [], "editPackId": ""}

def save_lorebooks(body):
    """设定包落盘:只收 packs/activePacks/editPackId 三字段,附 updatedAt"""
    b = body if isinstance(body, dict) else {}
    out = {
        "packs": b.get("packs") if isinstance(b.get("packs"), list) else [],
        "activePacks": b.get("activePacks") if isinstance(b.get("activePacks"), list) else [],
        "editPackId": b.get("editPackId") if isinstance(b.get("editPackId"), str) else "",
        "updatedAt": int(time.time() * 1000),
    }
    os.makedirs(os.path.dirname(LORE_F), exist_ok=True)
    dump(LORE_F, out)
    return out

def load_prefs():
    p = slurp(PREF_F, None)
    return p if isinstance(p, dict) else {}

def save_prefs(obj):
    out = _sanitize_prefs(obj)
    dump(PREF_F, out)
    return out

def ensure_dirs():
    for d in (WB_DIR, U_DIR, W_DIR):
        os.makedirs(d, exist_ok=True)

def slurp(path, default=None):
    """读 JSON。因写盘改为原子替换,Windows 下替换的瞬间目标文件可能短暂不可读
    （PermissionError: 文件被占用），故对 PermissionError 做几次短重试；
    文件不存在或内容真损坏时仍返回 default（保持原语义）。"""
    delay = 0.02
    for attempt in range(5):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except PermissionError:
            if attempt == 4:
                return default
            time.sleep(delay)
            delay = min(delay * 1.6, 0.15)
        except Exception:
            return default
    return default

def atomic_write(path, obj):
    """原子写 JSON：同目录写 .tmp → flush + fsync → os.replace 覆盖目标。

    为什么必须原子：原实现以 open(path,"w") 直接截断目标再写入，进程崩溃/断电会留下
    半个 JSON；而 slurp() 读失败会静默返回默认值，用户下次保存就把默认值写回磁盘 ——
    数据被永久覆盖且无从察觉。os.replace 在 POSIX 与 Windows 上均为原子替换，
    因此目标文件要么是旧的完整内容、要么是新的完整内容，不存在中间态。
    """
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())    # 先把 .tmp 落盘,再原子替换,避免断电拿到空/半文件
    # Windows 上若目标文件此刻正被其他线程/进程打开,os.replace 会抛 PermissionError;
    # ThreadingHTTPServer 是并发模型,读-改-写重叠是常态,故做指数退避重试(累计约 1.2s)。
    delay = 0.02
    for attempt in range(12):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 11:
                raise
            time.sleep(delay)
            delay = min(delay * 1.6, 0.15)


# 兼容保留旧名：项目中所有 dump(...) 调用点即为原子写
dump = atomic_write

# ---------------- 路径安全（防路径穿越） ----------------
# 背景：所有 /api/<实体>/<id> 路由都把 URL 片段 unquote() 后拼进 os.path.join。
# 攻击者可用 %2F 编码斜杠绕过 r"^/api/works/([^/]+)$"（%2F 不是 "/"，正则放行），
# unquote 后还原成分隔符并跳出数据目录；最严重者为
#   DELETE /api/works/..%2F..%2F..  → os.path.isdir() 为真 → shutil.rmtree 删除任意目录。
# 本文件采用三道防线：
#   ① HTTP 层 ID 白名单（非法 → 400）
#   ② 拼路径后 realpath 前缀校验（兜底，越界 → 抛 ValueError）
#   ③ 作品集删除改为移入回收站 _trash/（保留 7 天），不再直接 rmtree
_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def is_valid_id(s):
    """数据实体 id 白名单：仅字母/数字/下划线/连字符（与实际 id 形态一致，如 wb_1790267900403）。"""
    return isinstance(s, str) and bool(_ID_RE.match(s))


def _safe_join(root, *parts):
    """在 root 下安全拼接路径：realpath 归一后必须仍位于 root 之内，否则抛 ValueError。
    用 os.sep 后缀比较，避免 /data 与 /data-evil 这类前缀误判；normcase 兼容 Windows 盘符大小写。"""
    root_r = os.path.realpath(root)
    p = os.path.realpath(os.path.join(root_r, *parts))
    rn = os.path.normcase(root_r)
    pn = os.path.normcase(p)
    if pn != rn and not pn.startswith(rn + os.sep):
        raise ValueError("path escapes data root: %r" % (p,))
    return p


# ---------------- 回收站（删除作品集不再 rmtree） ----------------
TRASH_DIR = os.path.join(BASE_DIR, "_trash")
TRASH_KEEP_DAYS = 7


def _move_to_trash(path):
    """把目录整体移入 _trash/<时间戳>/<原名>，保留 7 天，返回落地路径。
    绝不直接 shutil.rmtree：误删可由用户手工从 _trash 取回。同秒重名自动加后缀。"""
    name = os.path.basename(os.path.normpath(path)) or "item"
    dest_dir = os.path.join(TRASH_DIR, time.strftime("%Y%m%d-%H%M%S"))
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, name)
    n = 1
    while os.path.exists(dest):
        dest = os.path.join(dest_dir, "%s__%d" % (name, n))
        n += 1
    shutil.move(path, dest)
    return dest


def purge_trash(days=TRASH_KEEP_DAYS):
    """启动时清理 _trash 中超过 days 天的条目，返回被清理的条目名列表（幂等）。"""
    if not os.path.isdir(TRASH_DIR):
        return []
    cutoff = time.time() - days * 86400
    removed = []
    for name in os.listdir(TRASH_DIR):
        p = os.path.join(TRASH_DIR, name)
        try:
            if os.path.getmtime(p) < cutoff:
                shutil.rmtree(p, ignore_errors=True)
                if not os.path.exists(p):
                    removed.append(name)
        except Exception:
            pass
    return removed

# ---------------- 索引重建 ----------------
def _is_sync_conflict(fn):
    """网盘同步冲突副本(wb_xxx_冲突文件_Heres_xxx.json 等)不是独立世界书,列表/索引一律忽略。
    (否则同一本书会被当成两本,列表重复显示。)"""
    if "_冲突文件_" in fn or "_冲突文件" in fn:
        return True
    return re.search(r"(?i)_(conflict|conflicted)[-_0-9]", fn) is not None

_INDEX_LOCK = threading.Lock()   # 索引「读-改-写」与全量重建互斥:防并发互相覆盖/写坏


def rebuild_index():
    """扫描 WorldBook / Universes / works，重建 _index.json（不含状态）。加锁。"""
    with _INDEX_LOCK:
        return _rebuild_index_locked()


def _rebuild_index_locked():
    """不加锁的实际重建逻辑。调用方必须已持有 _INDEX_LOCK。"""
    world_books = []
    if os.path.isdir(WB_DIR):
        for fn in os.listdir(WB_DIR):
            if fn.endswith(".json") and not _is_sync_conflict(fn):
                wb = slurp(os.path.join(WB_DIR, fn))
                if isinstance(wb, dict) and "id" in wb:
                    world_books.append({
                        "id": wb["id"],
                        "name": wb.get("name", fn),
                        "source": wb.get("source", "unknown"),
                        "entryCount": len(wb.get("entries") or {}),
                    })
    universes = {}
    if os.path.isdir(U_DIR):
        for fn in os.listdir(U_DIR):
            if fn.endswith("Universes.json"):
                u = slurp(os.path.join(U_DIR, fn))
                if isinstance(u, dict) and "id" in u:
                    universes[u["id"]] = {
                        "id": u["id"],
                        "name": u.get("name", fn),
                        "worldBookIds": u.get("worldBookIds", []),
                    }
    works = {}
    if os.path.isdir(W_DIR):
        for wn in os.listdir(W_DIR):
            wj = os.path.join(W_DIR, wn, wn + "works.json")
            if os.path.isfile(wj):
                w = slurp(wj)
                if isinstance(w, dict) and "id" in w:
                    works[w["id"]] = {
                        "id": w["id"],
                        "name": w.get("name", wn),
                        "universeId": w.get("universeId", ""),
                        "chapterIds": w.get("chapterIds", []),
                    }
    index = {"worldBooks": world_books, "universes": universes, "works": works}
    atomic_write(INDEX_F, index)
    return index


def update_index_work(w_id, w_obj):
    """增量更新 _index.json 中单个作品的条目(name / universeId / chapterIds)。

    原实现每保存一个章节都要全量重扫 WorldBook / Universes / works 三个目录，
    且 put_chapter → put_work → rebuild_index 会**连做两次**全量重建（数据量大时明显卡顿）。
    现在只改索引里对应的一个作品条目并原子写回；索引缺失/结构异常时回退全量重建兜底。
    """
    with _INDEX_LOCK:
        idx = slurp(INDEX_F, None)
        if not isinstance(idx, dict) or not isinstance(idx.get("works"), dict):
            return _rebuild_index_locked()
        idx["works"][w_id] = {
            "id": w_id,
            "name": w_obj.get("name", w_id),
            "universeId": w_obj.get("universeId", ""),
            "chapterIds": list(w_obj.get("chapterIds") or []),
        }
        atomic_write(INDEX_F, idx)
        return idx

def load_global():
    g = slurp(GLOBAL_F, None)
    if not isinstance(g, dict):
        g = {"globalActiveWB": []}
    if "globalActiveWB" not in g:
        g["globalActiveWB"] = []
    return g

def save_global(g):
    dump(GLOBAL_F, g)

# ---------------- 索引整理：清理悬空引用（写盘） ----------------
def clean_indexes():
    """扫描实际文件，清理各实体/索引中的无效引用：
       宇宙 worldBookIds、作品 chapterIds / universeId、_global.json globalActiveWB。
       幂等：无变化不写盘。返回清理报告。"""
    report = {"universes": [], "works": [], "global": []}
    # 有效世界书集合
    valid_wb = set()
    if os.path.isdir(WB_DIR):
        for fn in os.listdir(WB_DIR):
            if fn.endswith(".json") and not _is_sync_conflict(fn):
                wb = slurp(os.path.join(WB_DIR, fn))
                if isinstance(wb, dict) and wb.get("id"):
                    valid_wb.add(wb["id"])
    # 有效宇宙集合
    valid_u = set()
    if os.path.isdir(U_DIR):
        for fn in os.listdir(U_DIR):
            if fn.endswith("Universes.json"):
                u = slurp(os.path.join(U_DIR, fn))
                if isinstance(u, dict) and u.get("id"):
                    valid_u.add(u["id"])
    # 1) 宇宙文件：worldBookIds 过滤悬空
    if os.path.isdir(U_DIR):
        for fn in os.listdir(U_DIR):
            if not fn.endswith("Universes.json"):
                continue
            up = os.path.join(U_DIR, fn)
            u = slurp(up)
            if not isinstance(u, dict):
                continue
            ids = u.get("worldBookIds", [])
            if not isinstance(ids, list):
                ids = []
            good = [x for x in ids if x in valid_wb]
            if len(good) != len(ids):
                u["worldBookIds"] = good
                dump(up, u)
                report["universes"].append({"id": u.get("id"), "removed": [x for x in ids if x not in valid_wb]})
    # 2) 作品文件：chapterIds 过滤悬空章节 + universeId 过滤悬空宇宙
    if os.path.isdir(W_DIR):
        for wn in os.listdir(W_DIR):
            wj = os.path.join(W_DIR, wn, wn + "works.json")
            if not os.path.isfile(wj):
                continue
            w = slurp(wj)
            if not isinstance(w, dict):
                continue
            # 该作品实际存在的章节
            valid_ch = set()
            ch_dir = os.path.join(W_DIR, wn, "chapters")
            if os.path.isdir(ch_dir):
                for cf in os.listdir(ch_dir):
                    if cf.endswith(".json"):
                        ch = slurp(os.path.join(ch_dir, cf))
                        if isinstance(ch, dict) and ch.get("id"):
                            valid_ch.add(ch["id"])
            cids = w.get("chapterIds", [])
            if not isinstance(cids, list):
                cids = []
            changes = []
            good = [x for x in cids if x in valid_ch]
            if len(good) != len(cids):
                w["chapterIds"] = good
                changes.append("chapterIds:" + str([x for x in cids if x not in valid_ch]))
            uid = w.get("universeId", "")
            if uid and uid not in valid_u:
                w["universeId"] = ""
                changes.append("universeId:" + str(uid))
            if changes:
                dump(wj, w)
                report["works"].append({"id": w.get("id"), "changes": changes})
    # 3) _global.json：globalActiveWB 过滤悬空
    g = load_global()
    gids = g.get("globalActiveWB", [])
    if not isinstance(gids, list):
        gids = []
    good = [x for x in gids if x in valid_wb]
    if len(good) != len(gids):
        g["globalActiveWB"] = good
        save_global(g)
        report["global"].append({"removed": [x for x in gids if x not in valid_wb]})
    # 4) 有实体改动时重建 _index.json（从文件重建，天然干净）
    if report["universes"] or report["works"] or report["global"]:
        rebuild_index()
        report["index_rebuilt"] = True
    return report

# ---------------- SafeGate 安全闸门（哈希规则引擎，仓库无明文词库） ----------------
# 规则: rules/*.hash.json  {cat, label, buckets:{词长:[blake2b-64bit hex]}}
# 匹配: 正文归一化(NFKC→小写→去空白/标点/下划线) → 2~8 字滑窗 → 哈希查集合
# 标记持久化: safeGate.json  {flags:{"wbId:entryId":{cats,t}}}
RULES_DIR = os.path.join(BASE_DIR, "rules")
SG_FILE   = os.path.join(BASE_DIR, "safeGate.json")

HASH_TO_CAT = {}   # hex -> cat
BY_LEN      = {}   # 词长 -> set(hex)
CAT_LABELS  = {}   # cat -> 中文标签
RULE_LIST   = []   # [{path,layer,cat,label,words}] 启用状态由 ruleDisabled 决定


def load_rules():
    """递归加载 rules/ 下哈希集（跳过 ruleDisabled 中列出的文件）。
    优先级: 根目录(旧兼容) < official < community < user(最高)。"""
    HASH_TO_CAT.clear(); BY_LEN.clear(); CAT_LABELS.clear(); RULE_LIST.clear()
    if not os.path.isdir(RULES_DIR):
        return
    g = slurp(SG_FILE, None)
    disabled = set(g.get("ruleDisabled", [])) if isinstance(g, dict) and isinstance(g.get("ruleDisabled"), list) else set()
    order = ["official", "community", "user"]
    files = []
    for fn in sorted(os.listdir(RULES_DIR)):
        if fn.endswith(".hash.json"):
            files.append(os.path.join(RULES_DIR, fn))
    subdirs = [d for d in os.listdir(RULES_DIR) if os.path.isdir(os.path.join(RULES_DIR, d))]
    subdirs.sort(key=lambda d: order.index(d) if d in order else 99)
    for d in subdirs:
        full = os.path.join(RULES_DIR, d)
        for fn in sorted(os.listdir(full)):
            if fn.endswith(".hash.json"):
                files.append(os.path.join(full, fn))
    for path in files:
        rel = os.path.relpath(path, RULES_DIR).replace("\\", "/")
        d = slurp(path)
        if not isinstance(d, dict):
            continue
        cat = str(d.get("cat") or os.path.basename(path))
        label = str(d.get("label") or cat)
        buckets = d.get("buckets") or {}
        words = 0
        if isinstance(buckets, dict):
            for hs in buckets.values():
                if isinstance(hs, list):
                    words += len(hs)
        layer = "root"
        if rel.startswith("official/"): layer = "official"
        elif rel.startswith("community/"): layer = "community"
        elif rel.startswith("user/"): layer = "user"
        # 清单始终记录（含停用库，供 UI 显示/重新启用）
        RULE_LIST.append({"path": rel, "layer": layer, "cat": cat, "label": label, "words": words})
        if rel in disabled:
            continue   # 停用：不加载哈希（不参与匹配），但保留清单
        CAT_LABELS[cat] = label
        if not isinstance(buckets, dict):
            continue
        for n, hs in buckets.items():
            try:
                n = int(n)
            except Exception:
                continue
            if n < 2 or not isinstance(hs, list):
                continue
            s = BY_LEN.setdefault(n, set())
            for hx in hs:
                hx = str(hx).strip().lower()
                if len(hx) == 16:
                    s.add(hx)
                    HASH_TO_CAT[hx] = cat


def normalize_text(s):
    s = unicodedata.normalize("NFKC", str(s or ""))
    s = s.lower()
    s = re.sub(r"[\s\W_]+", "", s)
    return s


def normalize_map(s):
    """逐字符归一化并记录 归一化流 → 原文偏移 映射（供正文标红定位）。
    保留规则与 normalize_text 一致: 单词字符(\\w) 且非下划线。"""
    norm_chars, starts, ends = [], [], []
    for i, ch in enumerate(str(s or "")):
        nch = unicodedata.normalize("NFKC", ch).lower()
        for c in nch:
            if c == "_" or not re.match(r"[\w]", c):
                continue
            norm_chars.append(c)
            starts.append(i)
            ends.append(i + 1)
    return "".join(norm_chars), starts, ends


def check_text(text, positions=False):
    """命中返回违规类别列表（可选 positions: 命中区间原文坐标列表）；规则缺失时 fail-open。"""
    if not BY_LEN:
        return {"violation": False, "cats": [], "labels": [], "disabled": True, "hits": []}
    if positions:
        s, starts, ends = normalize_map(text)
    else:
        s = normalize_text(text)
    L = len(s)
    cats = set()
    hits = []
    for n, bucket in BY_LEN.items():
        if n > L:
            continue
        for i in range(0, L - n + 1):
            hx = hashlib.blake2b(s[i:i + n].encode("utf-8"), digest_size=8).hexdigest()
            if hx in bucket:
                cat = HASH_TO_CAT[hx]
                cats.add(cat)
                if positions:
                    hits.append([starts[i], ends[i + n - 1], cat])
    ordered = sorted(cats)
    out = {"violation": bool(ordered), "cats": ordered,
           "labels": [CAT_LABELS.get(c, c) for c in ordered], "disabled": False, "hits": []}
    if positions and hits:
        hits.sort(key=lambda x: x[0])
        merged = []
        for s0, e0, c in hits:
            if merged and s0 <= merged[-1][1]:
                if e0 > merged[-1][1]:
                    merged[-1][1] = e0
            else:
                merged.append([s0, e0, c])
        out["hits"] = [{"s": h[0], "e": h[1], "cat": h[2], "label": CAT_LABELS.get(h[2], h[2])} for h in merged]
    return out


def load_safegate():
    g = slurp(SG_FILE, None)
    if not isinstance(g, dict):
        g = {"flags": {}, "ruleDisabled": []}
    if not isinstance(g.get("flags"), dict):
        g["flags"] = {}
    if not isinstance(g.get("ruleDisabled"), list):
        g["ruleDisabled"] = []
    g["ruleDisabled"] = [str(x) for x in g["ruleDisabled"]]
    g["catLabels"] = dict(CAT_LABELS)
    dis = set(g["ruleDisabled"])
    g["rules"] = [dict(r, enabled=(r["path"] not in dis)) for r in RULE_LIST]
    return g


def save_safegate(g):
    if not isinstance(g, dict):
        g = {}
    flags = g.get("flags", {})
    rd = g.get("ruleDisabled", [])
    if not isinstance(flags, dict):
        flags = {}
    if not isinstance(rd, list):
        rd = []
    dump(SG_FILE, {"flags": flags, "ruleDisabled": [str(x) for x in rd]})
    load_rules()   # 启用/停用状态变更 → 重载规则（立即生效）


def build_user_rule(cat, label, words):
    """转化入口：用户明文词表 → 哈希集，写入 rules/user/（明文不落盘）。同 cat 已存在则合并。"""
    cat = str(cat or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", cat):
        raise ValueError("类别标识(cat)仅允许字母/数字/下划线/连字符，长度 ≤32")
    label = str(label or cat).strip()[:40] or cat
    buckets = {}
    path = os.path.join(RULES_DIR, "user", cat + ".hash.json")
    old = slurp(path, None)
    if isinstance(old, dict) and isinstance(old.get("buckets"), dict):
        for n, hs in old["buckets"].items():
            if isinstance(hs, list):
                try:
                    n = int(n)
                except Exception:
                    continue
                buckets.setdefault(n, set()).update(
                    str(h).strip().lower() for h in hs if len(str(h).strip().lower()) == 16)
    items = words if isinstance(words, list) else str(words or "").splitlines()
    added = 0
    for w in items:
        w = str(w).split("#", 1)[0].strip()
        if not w:
            continue
        s = normalize_text(w)
        if len(s) < 2:
            continue
        hx = hashlib.blake2b(s.encode("utf-8"), digest_size=8).hexdigest()
        if hx not in buckets.setdefault(len(s), set()):
            added += 1
        buckets.setdefault(len(s), set()).add(hx)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    dump(path, {"cat": cat, "label": label,
                "buckets": {str(k): sorted(v) for k, v in sorted(buckets.items())}})
    load_rules()
    return {"cat": cat, "label": label, "added": added,
            "words": sum(len(v) for v in buckets.values()),
            "path": "user/" + cat + ".hash.json"}

# ---------------- 世界书（SillyTavern 规范）----------------
def list_worldbooks():
    return [f[:-5] for f in os.listdir(WB_DIR)
            if f.endswith(".json") and not _is_sync_conflict(f)] if os.path.isdir(WB_DIR) else []

def get_worldbook(wb_id):
    try:
        return slurp(_safe_join(WB_DIR, wb_id + ".json"))
    except ValueError:
        return None

def put_worldbook(wb_id, obj):
    """原样直存 ST 世界书（保留 entries 字典等全部字段）。"""
    if not isinstance(obj, dict):
        obj = {"id": wb_id, "name": wb_id, "entries": {}}
    obj["id"] = wb_id
    dump(_safe_join(WB_DIR, wb_id + ".json"), obj)
    rebuild_index()
    return obj

def import_st_worldbook(raw):
    """从 SillyTavern 导出 JSON 导入。支持 entries 字典或数组。"""
    if isinstance(raw, str):
        raw = json.loads(raw)
    name = raw.get("name") or "未命名世界书"
    wb_id = "wb_" + str(int(time.time() * 1000))
    entries = raw.get("entries", {})
    if isinstance(entries, list):  # 数组形也归一为字典（用 uid/id 作 key）
        d = {}
        for e in entries:
            k = str(e.get("uid", e.get("id", len(d) + 1)))
            d[k] = e
        entries = d
    wb = {
        "id": wb_id,
        "name": name,
        "source": "sillytavern",
        "description": raw.get("description", ""),
        "scan_depth": raw.get("scan_depth", 2),
        "token_budget": raw.get("token_budget", 512),
        "recursive_scanning": raw.get("recursive_scanning", False),
        "extensions": raw.get("extensions", {}),
        "entries": entries,
    }
    dump(_safe_join(WB_DIR, wb_id + ".json"), wb)
    rebuild_index()
    return wb

# ---------------- 宇宙 ----------------
def _filter_existing_wb(ids):
    """过滤悬空世界书引用（文件已不存在的 id 不返回；只读过滤，不写盘）。"""
    if not isinstance(ids, list):
        return []
    out = []
    for i in ids:
        i = str(i)
        if not is_valid_id(i) or i in out:
            continue
        try:
            exists = os.path.isfile(_safe_join(WB_DIR, i + ".json"))
        except ValueError:
            continue
        if exists:
            out.append(i)
    return out


def list_universes():
    out = []
    if os.path.isdir(U_DIR):
        for fn in os.listdir(U_DIR):
            if fn.endswith("Universes.json"):
                u = slurp(os.path.join(U_DIR, fn))
                if isinstance(u, dict):
                    u["worldBookIds"] = _filter_existing_wb(u.get("worldBookIds", []))
                    out.append(u)
    return out

def get_universe(u_id):
    try:
        p = _safe_join(U_DIR, u_id + "Universes.json")
    except ValueError:
        return None
    u = slurp(p)
    if isinstance(u, dict):
        u["worldBookIds"] = _filter_existing_wb(u.get("worldBookIds", []))
    return u

def put_universe(u_id, obj):
    if not isinstance(obj, dict):
        obj = {"id": u_id, "name": u_id, "worldBookIds": []}
    obj["id"] = u_id
    obj.setdefault("worldBookIds", [])
    dump(_safe_join(U_DIR, u_id + "Universes.json"), obj)
    rebuild_index()
    return obj

def delete_universe(u_id):
    try:
        p = _safe_join(U_DIR, u_id + "Universes.json")
    except ValueError:
        return
    if os.path.isfile(p):
        os.remove(p)
    rebuild_index()

# ---------------- 作品 + 章节 ----------------
def list_works():
    out = []
    if os.path.isdir(W_DIR):
        for wn in os.listdir(W_DIR):
            wj = os.path.join(W_DIR, wn, wn + "works.json")
            if os.path.isfile(wj):
                out.append(slurp(wj))
    return out

def get_work(w_id):
    try:
        return slurp(_safe_join(W_DIR, w_id, w_id + "works.json"))
    except ValueError:
        return None

def put_work(w_id, obj):
    if not isinstance(obj, dict):
        obj = {"id": w_id, "name": w_id, "universeId": "", "chapterIds": []}
    obj["id"] = w_id
    obj.setdefault("universeId", "")
    obj.setdefault("chapterIds", [])
    atomic_write(_safe_join(W_DIR, w_id, w_id + "works.json"), obj)
    update_index_work(w_id, obj)      # 增量更新索引（不再全量重扫三个目录）
    return obj

def delete_work(w_id):
    """删除作品集：移入回收站（_trash/<时间戳>/，保留 7 天），不再直接 shutil.rmtree。"""
    try:
        p = _safe_join(W_DIR, w_id)
    except ValueError:
        return
    if os.path.isdir(p):
        _move_to_trash(p)
    rebuild_index()

def get_chapter(w_id, c_id):
    try:
        return slurp(_safe_join(W_DIR, w_id, "chapters", c_id + ".json"))
    except ValueError:
        return None

def put_chapter(w_id, c_id, obj):
    if not isinstance(obj, dict):
        obj = {"id": c_id, "title": "未命名", "tags": [], "body": "", "disabledEntryIds": []}
    obj["id"] = c_id
    obj.setdefault("tags", [])
    obj.setdefault("body", "")
    obj.setdefault("disabledEntryIds", [])
    atomic_write(_safe_join(W_DIR, w_id, "chapters", c_id + ".json"), obj)
    # 同步作品目录的 chapterIds：直接写作品文件 + 索引增量更新（避免全量重建两次）
    w = get_work(w_id) or {"id": w_id, "name": w_id, "universeId": "", "chapterIds": []}
    if c_id not in w["chapterIds"]:
        w["chapterIds"].append(c_id)
        atomic_write(_safe_join(W_DIR, w_id, w_id + "works.json"), w)
        update_index_work(w_id, w)
    return obj

def delete_chapter(w_id, c_id):
    try:
        p = _safe_join(W_DIR, w_id, "chapters", c_id + ".json")
    except ValueError:
        return
    if os.path.isfile(p):
        os.remove(p)
    w = get_work(w_id)
    if w and c_id in w["chapterIds"]:
        w["chapterIds"].remove(c_id)
        atomic_write(_safe_join(W_DIR, w_id, w_id + "works.json"), w)
        update_index_work(w_id, w)

# ---------------- 激活解析 ----------------
def resolve_active_worldbooks(universe_id):
    """返回对某宇宙实际激活的世界书 id 列表 = 全局激活 ∪ 宇宙 worldBookIds。"""
    g = load_global()
    active = list(g.get("globalActiveWB", []))
    if universe_id:
        u = get_universe(universe_id)
        if u:
            for wb in u.get("worldBookIds", []):
                if wb not in active:
                    active.append(wb)
    return active

def assemble_worldbook(wb_id, disabled_entry_ids=None):
    """取世界书 + 按章节 disabledEntryIds 过滤条目，返回可注入结构。"""
    wb = get_worldbook(wb_id)
    if not wb:
        return None
    entries = wb.get("entries", {})
    if disabled_entry_ids:
        entries = {k: v for k, v in entries.items() if str(v.get("uid", k)) not in disabled_entry_ids
                   and str(v.get("id", k)) not in disabled_entry_ids}
    return {"id": wb_id, "name": wb.get("name", wb_id),
            "scan_depth": wb.get("scan_depth", 2), "token_budget": wb.get("token_budget", 512),
            "recursive_scanning": wb.get("recursive_scanning", False),
            "entries": entries}

# ---------------- HTTP ----------------
class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # CORS：允许 localhost/127.0.0.1 混用及跨机访问（同源请求不受影响）
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Universe")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_OPTIONS(self):
        """预检请求（自定义头 X-Universe 触发）：返回 204 + CORS 头即可"""
        self.send_response(204)
        self.end_headers()

    def _proxy(self):
        """统一 API 代理:浏览器把外部请求 POST 到这里,服务端转发(密钥/Ollama 都在电脑端)。
        白名单:仅允许配置的在线 Base 与本地 Ollama;流式 SSE 透传(HTTP/1.1 chunked)。"""
        import http.client as _hc
        import ssl as _ssl
        from urllib.parse import urlparse as _up
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except Exception:
            return self._send_json({"error": "bad json"}, 400)
        url = req.get("url") or ""
        method = (req.get("method") or "GET").upper()
        hdrs = {k: v for k, v in (req.get("headers") or {}).items()}
        body = req.get("body")
        host = (_up(url).hostname or "").lower()
        sc = load_servercfg()
        allow = set()
        for base in (sc.get("onlineBase") or "", "https://api.deepseek.com",
                     "https://api.siliconflow.cn", "https://api.openai.com",
                     "https://dashscope.aliyuncs.com"):
            try:
                allow.add((_up(base).hostname or "").lower())
            except Exception:
                pass
        ollama = sc.get("ollamaUrl") or "http://127.0.0.1:11434"
        try:
            allow.add((_up(ollama).hostname or "").lower())
        except Exception:
            pass
        allow |= {"127.0.0.1", "localhost", "0.0.0.0"}
        if not host or host not in allow:
            return self._send_json({"error": "proxy target not allowed: " + host}, 403)
        # 服务端不再代持在线密钥:Authorization 由客户端请求头自带(见 app.js apiHeaders),此处不再注入
        data = body.encode("utf-8") if isinstance(body, str) else body
        hdrs.pop("Connection", None)   # 由 http.client 管理
        hdrs.pop("Host", None)         # http.client 自动加
        u = _up(url)
        port = u.port or (443 if u.scheme == "https" else 80)
        path = u.path or "/"
        if u.query:
            path += "?" + u.query
        # 连接阶段重试 3 次(响应头到手即止;流式部分不重试);Ollama 对部分请求间歇性拒绝
        conn = None
        last_exc = None
        for attempt in range(3):
            try:
                if u.scheme == "https":
                    conn = _hc.HTTPSConnection(u.hostname, port, timeout=600,
                                               context=_ssl.create_default_context())
                else:
                    conn = _hc.HTTPConnection(u.hostname, port, timeout=600)
                conn.request(method, path, body=data, headers=hdrs)
                resp = conn.getresponse()
                break
            except Exception as e:
                try:
                    conn.close()
                except Exception:
                    pass
                conn = None
                last_exc = e
                if attempt < 2:
                    time.sleep(0.15 * (attempt + 1))
        if conn is None:
            return self._send_json({"error": "proxy error: " + str(last_exc)}, 502)
        ctype = resp.getheader("Content-Type") or "application/octet-stream"
        self.protocol_version = "HTTP/1.1"   # 实例级:本响应用 1.1 + chunked,浏览器流式读取标准兼容
        self.send_response(resp.status)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        try:
            while True:
                chunk = resp.read(8192)
                if not chunk:
                    break
                self.wfile.write(("%x\r\n" % len(chunk)).encode() + chunk + b"\r\n")
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
        except Exception:
            pass
        conn.close()

    def _send_json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body_json(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        if n == 0:
            return {}
        return json.loads(self.rfile.read(n).decode("utf-8"))

    def _id_or_error(self, raw):
        """URL 片段 → 校验后的 id。设计要点：必须 unquote 之后再校验
        （正则匹配的是未解码的 path，%2F 会绕过 [^/]+）。非法直接回 400 并返回 None。"""
        s = unquote(raw)
        if not is_valid_id(s):
            self._send_json({"error": "invalid id"}, 400)
            return None
        return s

    def _prefs_item(self, body):
        """需求4:单条提交 —— 把浏览器本地某一条预设 upsert 进服务端 prefs.json(仅单条,不提供批量)"""
        if not isinstance(body, dict):
            return self._send_json({"error": "bad body"}, 400)
        field = body.get("field")
        if field not in ("sysPrompt", "styles", "promptItems"):
            return self._send_json({"error": "unsupported field: %s" % field}, 400)
        with _PREFS_LOCK:                     # 读-改-写串行,避免与并发全量推送互相覆盖
            cur = load_prefs()
            if field == "sysPrompt":
                val = body.get("value")
                if not isinstance(val, str):
                    return self._send_json({"error": "value must be string"}, 400)
                cur["sysPrompt"] = val
            else:
                item = body.get("item")
                if not isinstance(item, dict) or not item.get("id"):
                    return self._send_json({"error": "item.id required"}, 400)
                arr = cur.get(field)
                if not isinstance(arr, list):
                    arr = []
                arr = [x for x in arr if not (isinstance(x, dict) and x.get("id") == item.get("id"))]
                arr.append(item)
                cur[field] = arr
            return self._send_json(save_prefs(cur), 200)

    def do_GET(self):
        p = urlparse(self.path).path
        # 重构后 API
        if p == "/api/index":
            # GET 只读：不再有副作用（原实现会顺手全量重建并写盘）。
            # 需要主动重建请调用 POST /api/reindex。
            idx = slurp(INDEX_F, None)
            if not isinstance(idx, dict):
                idx = {"worldBooks": [], "universes": {}, "works": {}}
            return self._send_json(idx)
        if p == "/api/global":
            return self._send_json(load_global())
        if p == "/api/safegate":
            return self._send_json(load_safegate())
        if p == "/api/worldbooks":
            return self._send_json({"worldBooks": [get_worldbook(i) for i in list_worldbooks()]})
        m = re.match(r"^/api/worldbooks/([^/]+)$", p)
        if m:
            wb_id = self._id_or_error(m.group(1))
            if wb_id is None:
                return
            wb = get_worldbook(wb_id)
            return self._send_json(wb, 200 if wb else 404)
        if p == "/api/servercfg":
            # 只回传地址类配置;密钥永不出服务端(服务端也已不再持有)
            sc = load_servercfg()
            return self._send_json({"onlineBase": sc.get("onlineBase", ""), "ollamaUrl": sc.get("ollamaUrl", "")})
        if p == "/api/prefs":
            return self._send_json(load_prefs())
        if p == "/api/lorebooks":
            return self._send_json(load_lorebooks())
        if p == "/api/cleanup":
            return self._send_json(clean_indexes())
        if p == "/api/ping":
            # 手机 APP 局域网自动发现:指纹验证(排除路由器等误报)
            # port 取实际监听端口(不再硬编码 8000),自定义端口时手机端信息才准
            return self._send_json({"app": "xietai", "port": int(self.server.server_address[1]), "name": "续写台",
                                    "proto": DISCOVERY_PROTO, "pc_version": pc_version()})
        if p == "/api/universes":
            return self._send_json({"universes": list_universes()})
        m = re.match(r"^/api/universes/([^/]+)$", p)
        if m:
            u_id = self._id_or_error(m.group(1))
            if u_id is None:
                return
            u = get_universe(u_id)
            return self._send_json(u, 200 if u else 404)
        if p == "/api/works":
            return self._send_json({"works": list_works()})
        m = re.match(r"^/api/works/([^/]+)$", p)
        if m:
            w_id = self._id_or_error(m.group(1))
            if w_id is None:
                return
            w = get_work(w_id)
            return self._send_json(w, 200 if w else 404)
        m = re.match(r"^/api/works/([^/]+)/chapters$", p)
        if m:
            w_id = self._id_or_error(m.group(1))
            if w_id is None:
                return
            w = get_work(w_id) or {"chapterIds": []}
            chapters = [get_chapter(w_id, c) for c in w["chapterIds"]]
            return self._send_json({"chapters": [c for c in chapters if c]})
        m = re.match(r"^/api/works/([^/]+)/chapters/([^/]+)$", p)
        if m:
            w_id = self._id_or_error(m.group(1))
            if w_id is None:
                return
            c_id = self._id_or_error(m.group(2))
            if c_id is None:
                return
            c = get_chapter(w_id, c_id)
            return self._send_json(c, 200 if c else 404)
        if p == "/api/resolve":
            u = self.headers.get("X-Universe", "")
            if not is_valid_id(u):
                u = ""          # 非法宇宙 id 一律按"无宇宙"处理(仍返回全局激活),不参与路径拼接
            wb_ids = resolve_active_worldbooks(u)
            payload = {"activeWorldBookIds": wb_ids,
                       "worldBooks": [assemble_worldbook(i) for i in wb_ids if get_worldbook(i)]}
            return self._send_json(payload)
        # 静态文件
        return super().do_GET()

    def do_POST(self):
        p = urlparse(self.path).path
        if p == "/api/reindex":
            return self._send_json(rebuild_index())
        if p == "/api/moderate":
            body = self._body_json()
            return self._send_json(check_text(body.get("text", ""), bool(body.get("positions"))))
        if p == "/api/safegate/build":
            body = self._body_json()
            try:
                return self._send_json(build_user_rule(body.get("cat"), body.get("label"), body.get("words")), 200)
            except ValueError as e:
                return self._send_json({"error": str(e)}, 400)
        if p == "/api/prefs/item":
            return self._prefs_item(self._body_json())
        if p == "/api/lorebooks":
            return self._send_json(save_lorebooks(self._body_json()), 200)
        if p == "/api/proxy":
            return self._proxy()
        if p == "/api/worldbooks/import":
            raw = self._body_json()
            wb = import_st_worldbook(raw)
            return self._send_json(wb, 201)
        self._send_json({"error": "unknown POST " + p}, 405)

    def do_PUT(self):
        p = urlparse(self.path).path
        body = self._body_json()
        m = re.match(r"^/api/worldbooks/([^/]+)$", p)
        if m:
            wb_id = self._id_or_error(m.group(1))
            if wb_id is None:
                return
            wb = put_worldbook(wb_id, body)
            return self._send_json(wb, 200)
        m = re.match(r"^/api/universes/([^/]+)$", p)
        if m:
            u_id = self._id_or_error(m.group(1))
            if u_id is None:
                return
            u = put_universe(u_id, body)
            return self._send_json(u, 200)
        m = re.match(r"^/api/works/([^/]+)$", p)
        if m:
            w_id = self._id_or_error(m.group(1))
            if w_id is None:
                return
            w = put_work(w_id, body)
            return self._send_json(w, 200)
        m = re.match(r"^/api/works/([^/]+)/chapters/([^/]+)$", p)
        if m:
            w_id = self._id_or_error(m.group(1))
            if w_id is None:
                return
            c_id = self._id_or_error(m.group(2))
            if c_id is None:
                return
            c = put_chapter(w_id, c_id, body)
            return self._send_json(c, 200)
        if p == "/api/servercfg":
            sc = load_servercfg()
            for k in ("onlineBase", "ollamaUrl"):   # 不再接受 onlineKey:服务端不持有密钥
                if k in body:
                    sc[k] = body[k]
            save_servercfg(sc)
            return self._send_json({"ok": True})
        if p == "/api/prefs":
            # 乐观并发校验:客户端带 expectedUpdatedAt 且与服务端不一致 → 409(服务端权威,不被覆盖)
            # 校验与写入必须在同一临界区内(否则并发"单条提交"可在校验后、写入前插入 → 通过校验仍丢更新)
            with _PREFS_LOCK:
                cur = load_prefs()
                exp = body.get("expectedUpdatedAt") if isinstance(body, dict) else None
                if exp is not None and cur.get("updatedAt") and int(exp) != int(cur.get("updatedAt")):
                    return self._send_json({"error": "stale", "serverUpdatedAt": cur.get("updatedAt"), "prefs": cur}, 409)
                return self._send_json(save_prefs(body), 200)
        if p == "/api/global":
            g = body if isinstance(body, dict) else {}
            g.setdefault("globalActiveWB", [])
            save_global(g)
            return self._send_json(g, 200)
        if p == "/api/safegate":
            g = body if isinstance(body, dict) else {}
            save_safegate(g)
            return self._send_json(load_safegate(), 200)
        self._send_json({"error": "unknown PUT " + p}, 405)

    def do_DELETE(self):
        p = urlparse(self.path).path
        m = re.match(r"^/api/worldbooks/([^/]+)$", p)
        if m:
            wb_id = self._id_or_error(m.group(1))
            if wb_id is None:
                return
            try:
                fp = _safe_join(WB_DIR, wb_id + ".json")
            except ValueError:
                return self._send_json({"error": "forbidden"}, 403)
            if os.path.isfile(fp):
                os.remove(fp); rebuild_index()
                return self._send_json({"ok": True})
            return self._send_json({"ok": False}, 404)
        m = re.match(r"^/api/universes/([^/]+)$", p)
        if m:
            u_id = self._id_or_error(m.group(1))
            if u_id is None:
                return
            delete_universe(u_id)
            return self._send_json({"ok": True})
        m = re.match(r"^/api/works/([^/]+)$", p)
        if m:
            w_id = self._id_or_error(m.group(1))
            if w_id is None:
                return
            delete_work(w_id)
            return self._send_json({"ok": True})
        m = re.match(r"^/api/works/([^/]+)/chapters/([^/]+)$", p)
        if m:
            w_id = self._id_or_error(m.group(1))
            if w_id is None:
                return
            c_id = self._id_or_error(m.group(2))
            if c_id is None:
                return
            delete_chapter(w_id, c_id)
            return self._send_json({"ok": True})
        self._send_json({"error": "unknown DELETE " + p}, 405)

# ===== 版本号(单一来源:磁盘 version.json) =====
# A2:PC 版本号唯一来源为工程根 version.json(与仓库同根,GitHub Pages 也托管同一份),
#     不在多处硬编码;改文件即生效,无需改代码。
#     /api/ping 与 UDP 应答都会下发,供 D4C 读取(A1)。
PC_VERSION_FILE = os.path.join(BASE_DIR, "version.json")
PC_VERSION_FALLBACK = "26.67.10"         # 文件缺失/损坏时的兜底,与仓库 version.json 保持一致


def pc_version():
    """读 version.json 的 versions.pc;失败回退 PC_VERSION_FALLBACK"""
    try:
        obj = slurp(PC_VERSION_FILE, None)
        if isinstance(obj, dict):
            v = ((obj.get("versions") or {}).get("pc")) or ""
            if isinstance(v, str) and v.strip():
                return v.strip()
    except Exception:
        pass
    return PC_VERSION_FALLBACK


# ===== LAN Discovery Protocol (UDP 寻呼) =====
# 手机端广播 Probe(magic+type) → 本服务校验后单播回复 {ip, port}, 取代 254 个 IP 的暴力遍历。
DISCOVERY_PORT  = 45678
DISCOVERY_MAGIC = "XIETAI_DISCOVER_V1"
DISCOVERY_PROTO = 1


def _lan_ipv4_candidates():
    """本机局域网 IPv4 候选(排除回环)"""
    ips = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127.") and ip not in ips:
                ips.append(ip)
    except Exception:
        pass
    if not ips:
        try:
            sk = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sk.connect(("8.8.8.8", 80))
            ips.append(sk.getsockname()[0])
            sk.close()
        except Exception:
            pass
    return ips


def _pick_lan_ip(src_ip):
    """优先返回与请求方同网段的 IPv4,否则第一个候选(多网卡时避免报错网段)"""
    cands = _lan_ipv4_candidates()
    if src_ip:
        parts = str(src_ip).split(".")
        if len(parts) == 4:
            pref = ".".join(parts[:3]) + "."
            for ip in cands:
                if ip.startswith(pref):
                    return ip
    return cands[0] if cands else "0.0.0.0"


class DiscoveryResponder(threading.Thread):
    """UDP 寻呼应答线程:校验 magic/type,失败静默丢弃(不回复)"""

    def __init__(self, web_port, port=DISCOVERY_PORT, host="0.0.0.0"):
        super().__init__(daemon=True, name="DiscoveryResponder")
        self.web_port = web_port
        self.port = port
        self.host = host
        self.sock = None
        self._stop = False

    def run(self):
        try:
            sk = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sk.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sk.bind((self.host, self.port))
            self.sock = sk
        except Exception as e:
            print("[discovery] 启动失败(udp %d): %s" % (self.port, e))
            return
        print("[discovery] UDP 寻呼已就绪  端口=%d  magic=%s  proto=%d" % (self.port, DISCOVERY_MAGIC, DISCOVERY_PROTO))
        while not self._stop:
            try:
                data, addr = sk.recvfrom(4096)
            except OSError:
                break
            except Exception:
                continue
            try:
                msg = json.loads(data.decode("utf-8", "ignore"))
            except Exception:
                continue
            if not isinstance(msg, dict):
                continue
            # magic / type 校验失败 → 丢弃,不回复(避免误应答其他 UDP 服务)
            if msg.get("magic") != DISCOVERY_MAGIC or msg.get("type") != "discover_request":
                continue
            reply = {
                "magic": DISCOVERY_MAGIC,
                "type": "discover_response",
                "proto": DISCOVERY_PROTO,
                "app": "xietai",
                "name": "续写台",
                "ip": _pick_lan_ip(addr[0]),
                "port": self.web_port,
                "pc_version": pc_version(),
            }
            try:
                sk.sendto(json.dumps(reply, ensure_ascii=False).encode("utf-8"), addr)
                print("[discovery] probe %s:%d → 已回复 %s:%d" % (addr[0], addr[1], reply["ip"], reply["port"]))
            except Exception as e:
                print("[discovery] 回复失败: %s" % e)

    def stop(self):
        self._stop = True
        try:
            if self.sock:
                self.sock.close()
        except Exception:
            pass


def main():
    ensure_dirs()
    load_rules()
    rebuild_index()
    _purged = purge_trash()          # 回收站保留期清理(启动时执行,幂等)
    if _purged:
        print("回收站清理: 已移除超过 %d 天的条目 %s" % (TRASH_KEEP_DAYS, _purged))
    _clean = clean_indexes()
    if _clean["universes"] or _clean["works"] or _clean["global"]:
        print("索引整理: 清理悬空引用", json.dumps(_clean, ensure_ascii=False))
    if not os.path.isfile(GLOBAL_F):
        save_global({"globalActiveWB": []})
    root = "续写台"
    if len(sys.argv) > 1:
        root = sys.argv[1]
    # 兼容启动 bat 传的别名
    root_map = {"xietai": "续写台"}   # 仅续写台(小梦聊天壳已移除,开源版)
    if root in root_map:
        root = root_map[root]
    port = 8000
    host = "0.0.0.0"  # 默认监听所有网卡:手机/热点/局域网可访问;仅本机访问可用 --host 127.0.0.1
    if "--port" in sys.argv:
        port = int(sys.argv[sys.argv.index("--port") + 1])
    if "--host" in sys.argv:
        host = sys.argv[sys.argv.index("--host") + 1]
    disc_port = DISCOVERY_PORT
    disc_on = True
    if "--discovery-port" in sys.argv:
        disc_port = int(sys.argv[sys.argv.index("--discovery-port") + 1])
    if "--no-discovery" in sys.argv:
        disc_on = False
    root_path = os.path.join(BASE_DIR, root)
    if not os.path.isdir(root_path):
        print("目录不存在:", root_path); sys.exit(1)
    os.chdir(root_path)
    srv = ThreadingHTTPServer((host, port), Handler)
    print(f"SERVER UP  http://{host}:{port}/   静态目录: {root_path}")
    def _local_ips():
        ips = []
        try:
            for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
                ip = info[4][0]
                if not ip.startswith("127.") and ip not in ips:
                    ips.append(ip)
        except Exception:
            pass
        if not ips:
            try:
                sk = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                sk.connect(("8.8.8.8", 80))
                ips.append(sk.getsockname()[0])
                sk.close()
            except Exception:
                pass
        return ips
    for ip in _local_ips():
        print("  LAN/phone access: http://%s:%d/" % (ip, port))
    if disc_on:
        # UDP 寻呼应答(独立线程,不影响 Web 服务)
        DiscoveryResponder(web_port=port, port=disc_port).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")

if __name__ == "__main__":
    main()
