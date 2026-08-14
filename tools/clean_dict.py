#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""临时清洗脚本：下载的敏感词库 txt → 每行一词的标准词表（去尾逗号/空白、去重）。
明文只存本地临时目录，转换后由 build_dict.py 产出哈希入库。"""
import sys, re

def clean(src, out):
    words = set()
    # 编码探测: UTF-8 → UTF-16(BOM) → GBK
    raw = open(src, "rb").read()
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        enc = "utf-16"
    else:
        try:
            raw.decode("utf-8"); enc = "utf-8"
        except UnicodeDecodeError:
            enc = "gbk"
    for line in raw.decode(enc).splitlines():
        w = line.strip().rstrip("，,。.、")
        w = w.strip()
        if not w:
            continue
        words.add(w)
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(sorted(words)))
    return len(words)

if __name__ == "__main__":
    src, out = sys.argv[1], sys.argv[2]
    n = clean(src, out)
    print("%s → %s: %d 词" % (src, out, n))
