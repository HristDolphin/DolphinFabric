#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SafeGate 词库构建工具（明文只在本地，仓库只收哈希）

用法:
  python tools/build_dict.py <词表文件> <cat> <label> [--out rules/<cat>.hash.json]

词表文件: 每行一个词（# 开头为注释）；构建前做与运行时完全相同的归一化。
注意: 词表明文文件不要提交到仓库（.gitignore 忽略），仓库只保留 *.hash.json。
"""
import sys, os, json, re, hashlib, unicodedata, argparse


def normalize(s):
    s = unicodedata.normalize("NFKC", str(s or ""))
    s = s.lower()
    s = re.sub(r"[\s\W_]+", "", s)
    return s


def h(word):
    return hashlib.blake2b(word.encode("utf-8"), digest_size=8).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("wordlist")
    ap.add_argument("cat")
    ap.add_argument("label")
    ap.add_argument("--out", default=None)
    ap.add_argument("--merge", action="store_true",
                    help="目标文件已存在时合并(增量扩充),默认覆盖")
    a = ap.parse_args()

    # 项目根 = 本脚本(tools/)的上级目录；默认输出锚定到项目内 rules/user/
    BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    buckets = {}
    with open(a.wordlist, "r", encoding="utf-8") as f:
        for line in f:
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            w = normalize(line)
            if len(w) < 2:
                continue
            buckets.setdefault(len(w), set()).add(h(w))

    # 默认输出到 rules/user/（用户本地，.gitignore 忽略，不入库）
    path = a.out or os.path.join(BASE, "rules", "user", a.cat + ".hash.json")
    merged = {}
    if a.merge and os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                old = json.load(f)
            if isinstance(old, dict) and isinstance(old.get("buckets"), dict):
                for k, v in old["buckets"].items():
                    if isinstance(v, list):
                        try:
                            k = int(k)
                        except Exception:
                            continue
                        merged.setdefault(k, set()).update(
                            str(h).strip().lower() for h in v if len(str(h).strip().lower()) == 16)
        except Exception as e:
            print("警告: 读取旧文件失败，将覆盖:", e)
    for n, hs in buckets.items():
        merged.setdefault(n, set()).update(hs)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"cat": a.cat, "label": a.label,
                   "buckets": {str(k): sorted(v) for k, v in sorted(merged.items())}}, f, ensure_ascii=False, indent=1)
    total = sum(len(v) for v in merged.values())
    print("已生成 %s: 类别[%s] 词数(归一化去重后) %d" % (path, a.label, total))


if __name__ == "__main__":
    main()
