#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""第 3 步「原子写 + 索引锁」回归测试。

覆盖：
  A. atomic_write 基本行为 —— 写入正确、成功后不残留 .tmp、dump 已别名到 atomic_write
  B. 写入失败不破坏原文件 —— replace 抛错时目标文件保持旧的完整内容
  C. 崩溃模拟（对照实验） —— 写入中途 kill 进程：
       old_write（修复前的直接覆盖写）→ 目标文件被截断、JSON 不可解析
       atomic  （修复后的原子写）    → 目标文件仍是崩溃前的完整内容，可正常读取
  D. 索引锁 —— 多线程并发重建索引时，_index.json 任何时刻都可被完整解析
  E. 增量索引 —— 保存章节不再触发全量重建，但索引里的 chapterIds 正确
  F. GET /api/index 无副作用 —— GET 不写盘，重建由 POST /api/reindex 承担

运行：python tests/test_atomic_write.py -v
"""
import http.client
import json
import os
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import serve  # noqa: E402

HELPER = os.path.join(HERE, "_crash_helper.py")
_TIMING = bool(os.environ.get("XIETAI_TEST_TIMING"))


class _FastThreadingHTTPServer(ThreadingHTTPServer):
    """跳过 HTTPServer.server_bind() 的 socket.getfqdn() 反向 DNS（会阻塞数秒）。"""

    daemon_threads = True

    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = host
        self.server_port = port


class AtomicWriteTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._root = tempfile.mkdtemp(prefix="xietai_atomic_")
        cls.srv = _FastThreadingHTTPServer(("127.0.0.1", 0), serve.Handler)
        cls.port = cls.srv.server_address[1]
        cls._th = threading.Thread(target=cls.srv.serve_forever, daemon=True)
        cls._th.start()

    @classmethod
    def tearDownClass(cls):
        try:
            cls.srv.shutdown()
            cls.srv.server_close()
        except Exception:
            pass
        # 同 test_path_traversal：Windows 上 rmtree 多层目录会被杀软拖慢数十秒，默认保留。
        if os.environ.get("XIETAI_TEST_CLEANUP") == "1":
            shutil.rmtree(cls._root, ignore_errors=True)
        else:
            print("\n[note] 测试沙箱保留在: %s （XIETAI_TEST_CLEANUP=1 可自动清理）" % cls._root)

    def setUp(self):
        self.tmp = os.path.join(self.__class__._root, self._testMethodName)
        self.base = os.path.join(self.tmp, "base")
        self.wb = os.path.join(self.base, "WorldBook")
        self.ud = os.path.join(self.base, "Universes")
        self.wd = os.path.join(self.base, "works")
        for d in (self.wb, self.ud, self.wd):
            os.makedirs(d, exist_ok=True)
        self._orig = {k: getattr(serve, k) for k in
                      ("WB_DIR", "U_DIR", "W_DIR", "INDEX_F", "GLOBAL_F", "TRASH_DIR")}
        serve.WB_DIR = self.wb
        serve.U_DIR = self.ud
        serve.W_DIR = self.wd
        serve.INDEX_F = os.path.join(self.base, "_index.json")
        serve.GLOBAL_F = os.path.join(self.base, "_global.json")
        serve.TRASH_DIR = os.path.join(self.base, "_trash")

    def tearDown(self):
        for k, v in self._orig.items():
            setattr(serve, k, v)

    def req(self, method, path, body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        data = None
        h = {}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            h["Content-Type"] = "application/json"
        c.request(method, path, body=data, headers=h)
        r = c.getresponse()
        payload = r.read().decode("utf-8", "replace")
        c.close()
        return r.status, payload

    # ======================= A. 基本行为 =======================
    def test_A1_atomic_write_basic_and_no_tmp_left(self):
        target = os.path.join(self.base, "a1.json")
        serve.atomic_write(target, {"k": "值", "n": 1})
        self.assertEqual(serve.slurp(target), {"k": "值", "n": 1})
        self.assertFalse(os.path.exists(target + ".tmp"), "成功后残留了 .tmp")

    def test_A2_dump_is_atomic_write(self):
        self.assertIs(serve.dump, serve.atomic_write,
                      "dump 未别名到 atomic_write，可能仍有非原子写盘路径")

    def test_A3_atomic_write_creates_missing_dirs(self):
        target = os.path.join(self.base, "deep", "nested", "a3.json")
        serve.atomic_write(target, [1, 2, 3])
        self.assertEqual(serve.slurp(target), [1, 2, 3])

    def test_A4_servercfg_write_is_atomic(self):
        """save_servercfg 也必须走原子写（属于第 3 步要求替换的写盘调用）。"""
        target = self.base
        old = serve.SCFG_F
        serve.SCFG_F = os.path.join(target, "servercfg.json")
        try:
            serve.save_servercfg({"onlineBase": "https://x/v1", "onlineKey": "SHOULD-NOT-PERSIST"})
            self.assertEqual(serve.slurp(serve.SCFG_F),
                             {"onlineBase": "https://x/v1"})
            self.assertFalse(os.path.exists(serve.SCFG_F + ".tmp"))
        finally:
            serve.SCFG_F = old

    # ======================= B. 写入失败不破坏原文件 =======================
    def test_B1_replace_failure_keeps_original_intact(self):
        target = os.path.join(self.base, "b1.json")
        serve.atomic_write(target, {"v": 1})
        orig_replace = os.replace

        def boom(src, dst):
            raise OSError("simulated disk full")

        os.replace = boom
        try:
            with self.assertRaises(OSError):
                serve.atomic_write(target, {"v": 2})
        finally:
            os.replace = orig_replace
        # 目标文件必须仍是崩溃前的完整内容
        self.assertEqual(serve.slurp(target), {"v": 1}, "写入失败后原文件被破坏")
        self.assertTrue(os.path.exists(target + ".tmp"), ".tmp 应残留（提示中断点）")

    # ======================= C. 崩溃模拟（对照实验） =======================
    def _run_crash(self, mode, target):
        p = subprocess.Popen([sys.executable, HELPER, mode, target],
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             text=True, encoding="utf-8", errors="replace")
        try:
            line = (p.stdout.readline() or "").strip()
            if mode == "seed":
                p.wait(timeout=30)
            else:
                self.assertEqual(line, "READY", "helper 未进入可中断状态：%r" % line)
                time.sleep(0.2)
                p.kill()            # 模拟断电/进程崩溃
                p.wait(timeout=30)
        finally:
            if p.poll() is None:
                p.kill()
        if p.stdout:
            p.stdout.close()
        return line

    def test_C1_baseline_seeded(self):
        target = os.path.join(self.base, "c1.json")
        self._run_crash("seed", target)
        obj = serve.slurp(target)
        self.assertIsInstance(obj, dict)
        self.assertEqual(obj.get("name"), "BASELINE-完整基线")

    def test_C2_crash_during_OLD_overwrite_corrupts_file(self):
        """对照实验：修复前的直接覆盖写，被 kill 后文件损坏、JSON 不可解析。"""
        target = os.path.join(self.base, "c2.json")
        self._run_crash("seed", target)
        self._run_crash("old_write", target)
        with open(target, "r", encoding="utf-8") as f:
            raw = f.read()
        broken = False
        try:
            json.loads(raw)
        except Exception:
            broken = True
        self.assertTrue(broken,
                        "非原子写被中断后竟然仍是合法 JSON —— 对照实验未复现问题；内容长度=%d" % len(raw))
        self.assertLess(len(raw), 20000)     # 明显被截断

    def test_C3_crash_during_ATOMIC_write_keeps_file_readable(self):
        """修复后：原子写被 kill 后，目标文件仍是崩溃前的完整内容，可正常读取。"""
        target = os.path.join(self.base, "c3.json")
        self._run_crash("seed", target)
        before = serve.slurp(target)
        self._run_crash("atomic", target)
        after = serve.slurp(target)          # 必须可解析（slurp 失败会返回 None）
        self.assertIsNotNone(after, "原子写被中断后文件不可解析（数据损坏）")
        self.assertEqual(after, before, "原子写被中断后文件内容被部分改写")
        self.assertEqual(after.get("name"), "BASELINE-完整基线")
        # 崩溃点在 replace 之前：.tmp 残留（不影响目标文件）
        self.assertTrue(os.path.exists(target + ".tmp"))

    # ======================= D. 索引锁（并发） =======================
    def test_D1_concurrent_rebuild_never_yields_broken_index(self):
        w0 = os.path.join(self.wd, "w_lock0")
        os.makedirs(w0, exist_ok=True)
        with open(os.path.join(w0, "w_lock0works.json"), "w", encoding="utf-8") as f:
            json.dump({"id": "w_lock0", "name": "L", "universeId": "", "chapterIds": []}, f)
        serve.rebuild_index()               # 建立初始索引

        stop = threading.Event()
        errors = []
        corrupt = []
        other = []
        contested = []
        slurp_miss = []

        def writer():
            try:
                for _ in range(40):
                    serve.rebuild_index()
            except Exception as e:
                errors.append(repr(e))

        def reader():
            while not stop.is_set():
                p = serve.INDEX_F
                if os.path.isfile(p):
                    # 裸读：用于证明"原子替换永不产生半成品 JSON"
                    try:
                        with open(p, "r", encoding="utf-8") as f:
                            json.load(f)
                    except json.JSONDecodeError as e:
                        corrupt.append(repr(e))       # 真·数据损坏 → 必须为 0
                    except PermissionError as e:
                        contested.append(repr(e))     # 瞬时文件占用 → 允许（非数据完整性问题）
                    except Exception as e:
                        other.append(repr(e))
                    # 真实读路径（带重试的 slurp）必须拿到完整对象，不得为 None
                    v = serve.slurp(p, None)
                    if not isinstance(v, dict):
                        slurp_miss.append(repr(v))
                time.sleep(0.001)

        ts = [threading.Thread(target=writer) for _ in range(4)]
        rs = [threading.Thread(target=reader, daemon=True) for _ in range(3)]
        for r in rs:
            r.start()
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        stop.set()
        for r in rs:
            r.join(timeout=5)

        self.assertEqual(errors, [], "并发重建抛异常: %s" % errors)
        self.assertEqual(corrupt, [],
                         "并发期间读到了损坏的 _index.json（原子写失效）: %s" % corrupt[:3])
        self.assertEqual(other, [], "并发期间出现未预期异常: %s" % other[:3])
        self.assertEqual(slurp_miss, [],
                         "带重试的 slurp 仍读到非完整内容（读路径抗瞬时占用失效）: %s" % slurp_miss[:3])
        print("\n[info] 裸读遇到瞬时占用 %d 次（属 Windows 文件替换正常现象，非数据损坏）"
              % len(contested))
        idx = serve.slurp(serve.INDEX_F)
        self.assertIsInstance(idx, dict)
        self.assertIn("works", idx)

    # ======================= E. 增量索引 =======================
    def test_E1_put_chapter_uses_incremental_index(self):
        serve.rebuild_index()               # 先有索引，确保走增量分支
        calls = {"n": 0}
        orig = serve.rebuild_index

        def counting():
            calls["n"] += 1
            return orig()

        serve.rebuild_index = counting
        try:
            serve.put_chapter("w_inc", "ch_1", {"id": "ch_1", "body": "a"})
            serve.put_chapter("w_inc", "ch_2", {"id": "ch_2", "body": "b"})
            serve.delete_chapter("w_inc", "ch_2")
        finally:
            serve.rebuild_index = orig

        self.assertEqual(calls["n"], 0, "保存/删除章节仍触发了全量索引重建（应走增量）")
        idx = serve.slurp(serve.INDEX_F)
        self.assertIsInstance(idx, dict)
        self.assertEqual(idx["works"]["w_inc"]["chapterIds"], ["ch_1"])
        self.assertTrue(os.path.isfile(os.path.join(self.wd, "w_inc", "chapters", "ch_1.json")))

    def test_E2_incremental_falls_back_when_index_missing(self):
        """索引不存在时应回退全量重建，保证数据仍可见。"""
        if os.path.exists(serve.INDEX_F):
            os.remove(serve.INDEX_F)
        serve.put_chapter("w_fb", "ch_1", {"id": "ch_1", "body": "x"})
        idx = serve.slurp(serve.INDEX_F)
        self.assertIsInstance(idx, dict, "回退路径未生成索引")
        self.assertIn("w_fb", idx["works"])

    def test_E3_put_work_updates_index_fields(self):
        serve.rebuild_index()
        serve.put_work("w_f", {"id": "w_f", "name": "改名后", "universeId": "u_x",
                               "chapterIds": ["c1"]})
        idx = serve.slurp(serve.INDEX_F)
        self.assertEqual(idx["works"]["w_f"]["name"], "改名后")
        self.assertEqual(idx["works"]["w_f"]["universeId"], "u_x")

    # ======================= F. GET /api/index 无副作用 =======================
    def test_F1_get_index_has_no_side_effect(self):
        if os.path.exists(serve.INDEX_F):
            os.remove(serve.INDEX_F)
        code, payload = self.req("GET", "/api/index")
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(payload), {"worldBooks": [], "universes": {}, "works": {}})
        self.assertFalse(os.path.exists(serve.INDEX_F),
                         "GET /api/index 仍写入磁盘（副作用未去除）")

    def test_F2_post_reindex_still_rebuilds(self):
        if os.path.exists(serve.INDEX_F):
            os.remove(serve.INDEX_F)
        w0 = os.path.join(self.wd, "w_re")
        os.makedirs(w0, exist_ok=True)
        with open(os.path.join(w0, "w_re" + "works.json"), "w", encoding="utf-8") as f:
            json.dump({"id": "w_re", "name": "R", "universeId": "", "chapterIds": []}, f)
        code, payload = self.req("POST", "/api/reindex")
        self.assertEqual(code, 200)
        self.assertIn("w_re", json.loads(payload)["works"])
        self.assertTrue(os.path.exists(serve.INDEX_F), "POST /api/reindex 未重建索引")


if __name__ == "__main__":
    unittest.main(verbosity=2)
