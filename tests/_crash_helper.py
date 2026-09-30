#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""断电/崩溃模拟的子进程助手（被 tests/test_atomic_write.py 调用，本身不是测试）。

用法：python _crash_helper.py <mode> <target_path>

mode 说明：
  seed        原子写入一份完整基线，然后正常退出
  old_write   模拟"修复前"的直接覆盖写：先截断目标文件，只写入不完整内容后
              打印 READY 并挂起，等待父进程把它 kill 掉 → 目标文件被截断损坏
  atomic      模拟修复后的原子写：把完整内容写进 .tmp 并 fsync 后
              打印 READY 并挂起，等待父进程 kill → 目标文件保持基线不变

父进程在读到 READY 后立即 kill，以此验证：崩溃点发生在"目标文件被改动之后"（old_write）
或"目标文件被改动之前"（atomic）。
"""
import json
import os
import sys
import time

MODE = sys.argv[1]
TARGET = sys.argv[2]

BASELINE = {"id": "w_crash", "name": "BASELINE-完整基线", "universeId": "",
            "chapterIds": ["ch_old_1", "ch_old_2"]}


def big_payload():
    """足够大，保证写入过程有时间被中断。"""
    return {"id": "w_crash", "name": "NEW-新内容", "universeId": "",
            "chapterIds": ["ch_new_%05d" % i for i in range(20000)]}


def do_seed():
    tmp = TARGET + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(BASELINE, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, TARGET)


if MODE == "seed":
    do_seed()
    print("DONE")
    sys.stdout.flush()

elif MODE == "old_write":
    # 修复前的行为：open(...,"w") 先把目标文件截断，再慢慢写入
    f = open(TARGET, "w", encoding="utf-8")
    f.write(json.dumps(big_payload(), ensure_ascii=False)[:2000])   # 只写了开头 2000 字符
    f.flush()
    print("READY")
    sys.stdout.flush()
    time.sleep(120)
    f.close()

elif MODE == "atomic":
    # 修复后的行为：完整写 .tmp + fsync，但在 replace 之前被 kill
    tmp = TARGET + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(big_payload(), f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    print("READY")
    sys.stdout.flush()
    time.sleep(120)
    os.replace(tmp, TARGET)

else:
    print("UNKNOWN MODE", MODE)
    sys.exit(2)
