#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""路径穿越防护回归测试 —— 第 2 步「修路径穿越」的验收护栏。

背景（修复前）：
    do_DELETE 用 re.match(r"^/api/works/([^/]+)$", p) 校验"不含斜杠"，但 %2F 不是 "/"，
    正则放行；随后 unquote() 解码成真实分隔符并 os.path.join → 跳出数据目录：
      DELETE /api/works/..%2F..%2F..  → os.path.isdir() 为真 → shutil.rmtree 删除任意目录。

本测试覆盖四条防线：
    A. HTTP 层 ID 白名单 —— 各种越界 id 必须 400/403，且沙箱内外均无文件被删除
    B. 数据层 realpath 前缀兜底 —— _safe_join 越界抛 ValueError
    C. 回收站 —— 删除作品集移入 _trash/<时间戳>/，7 天保留策略可被 purge_trash 清理
    D. 正常 id 回归 —— 防误伤：合法实体 CRUD 仍工作

安全设计：全程在 tempfile 沙箱内，通过改写 serve 模块的目录常量 + 启动真实
ThreadingHTTPServer 发真实 HTTP 请求，绝不触碰 D:\\续写工作台 的真实用户数据。

运行：python tests/test_path_traversal.py -v
（可直接用便携解释器：python\\portable\\python.exe tests\\test_path_traversal.py -v）
"""
import http.client
import json
import os
import shutil
import socketserver
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import serve  # noqa: E402

W_OK = "w_1700000000000"
W_OK2 = "w_1700000000001"
_TIMING = bool(os.environ.get("XIETAI_TEST_TIMING"))   # 设该环境变量可打印每用例 setUp/tearDown 耗时


class _FastThreadingHTTPServer(ThreadingHTTPServer):
    """跳过 HTTPServer.server_bind() 中的 socket.getfqdn() 反向 DNS 查询。
    该查询在无法解析本机 FQDN 的机器上每次绑定要阻塞数秒，会把整套测试拖到超时。"""

    daemon_threads = True

    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = host
        self.server_port = port


class PathTraversalTest(unittest.TestCase):
    # ------------------------------------------------ 服务器（整个测试类共享）
    @classmethod
    def setUpClass(cls):
        # 单个类级根目录：每个用例用其独立子目录，避免 Windows 上
        # 每用例一次 shutil.rmtree（实测约 3.6s，会被杀软放大）拖垮整套测试。
        cls._root = tempfile.mkdtemp(prefix="xietai_sec_")
        cls._t_start = time.time()
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
        # Windows 上 shutil.rmtree 删除多层目录树会被杀软逐文件扫描拖到数十秒
        # （实测单个沙箱树约 2~4s，14 个树可达 90s+），足以让整套测试看起来"卡死"。
        # 因此默认不清理：沙箱位于系统临时目录，可安全丢弃；需要清理时设 XIETAI_TEST_CLEANUP=1。
        if os.environ.get("XIETAI_TEST_CLEANUP") == "1":
            shutil.rmtree(cls._root, ignore_errors=True)
        else:
            print("\n[note] 测试沙箱保留在: %s\n        设 XIETAI_TEST_CLEANUP=1 可在结束时自动清理。"
                  % cls._root)

    # ------------------------------------------------------------------ 沙箱
    def setUp(self):
        self._t0 = time.time()
        self.tmp = os.path.join(self.__class__._root, self._testMethodName)
        self.base = os.path.join(self.tmp, "base")
        self.wb = os.path.join(self.base, "WorldBook")
        self.ud = os.path.join(self.base, "Universes")
        self.wd = os.path.join(self.base, "works")
        for d in (self.wb, self.ud, self.wd):
            os.makedirs(d, exist_ok=True)

        # 诱饵：数据根附近的哨兵（越界攻击的真实目标）
        self.canary_dir = os.path.join(self.base, "canary_dir")
        os.makedirs(self.canary_dir, exist_ok=True)
        self.canary_file = os.path.join(self.canary_dir, "canary.txt")
        with open(self.canary_file, "w", encoding="utf-8") as f:
            f.write("DO NOT DELETE")
        # 诱饵：数据根之外
        self.outside = os.path.join(self.tmp, "outside")
        os.makedirs(self.outside, exist_ok=True)
        self.outside_file = os.path.join(self.outside, "outside.txt")
        with open(self.outside_file, "w", encoding="utf-8") as f:
            f.write("OUTSIDE - MUST SURVIVE")

        # 合法实体（回归 / 删除测试用）
        wdir = os.path.join(self.wd, W_OK)
        os.makedirs(os.path.join(wdir, "chapters"), exist_ok=True)
        with open(os.path.join(wdir, W_OK + "works.json"), "w", encoding="utf-8") as f:
            json.dump({"id": W_OK, "name": "测试作品", "universeId": "",
                       "chapterIds": ["ch_1"]}, f)

        # 把 serve 模块的目录常量重定向到沙箱
        self._orig = {k: getattr(serve, k) for k in
                      ("WB_DIR", "U_DIR", "W_DIR", "INDEX_F", "GLOBAL_F", "TRASH_DIR")}
        serve.WB_DIR = self.wb
        serve.U_DIR = self.ud
        serve.W_DIR = self.wd
        serve.INDEX_F = os.path.join(self.base, "_index.json")
        serve.GLOBAL_F = os.path.join(self.base, "_global.json")
        serve.TRASH_DIR = os.path.join(self.base, "_trash")
        if _TIMING:
            print("  [timing] %s setUp %.3fs (t=%.3f)" % (
                self._testMethodName, time.time() - self._t0, time.time() - self.__class__._t_start),
                file=sys.stderr)

    def tearDown(self):
        for k, v in self._orig.items():
            setattr(serve, k, v)
        if _TIMING:
            print("  [timing] %s total %.3fs (t=%.3f)" % (
                self._testMethodName, time.time() - self._t0, time.time() - self.__class__._t_start),
                file=sys.stderr)

    # ------------------------------------------------------------------ 工具
    def req(self, method, path, body=None, headers=None):
        """发原始请求：path 原样发送（%2F 不会被再次编码）。"""
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        data = None
        h = dict(headers or {})
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            h["Content-Type"] = "application/json"
        conn.request(method, path, body=data, headers=h)
        r = conn.getresponse()
        payload = r.read().decode("utf-8", "replace")
        conn.close()
        return r.status, payload

    def assert_sandbox_intact(self):
        """越界攻击后：哨兵与沙箱外文件必须原封不动。"""
        self.assertTrue(os.path.isdir(self.canary_dir), "canary_dir 被删除了！")
        self.assertTrue(os.path.isfile(self.canary_file), "canary.txt 被删除了！")
        self.assertTrue(os.path.isfile(self.outside_file), "沙箱外文件被删除了！")
        self.assertTrue(os.path.isdir(self.base), "沙箱数据根被删除了！")

    # ============================ A. HTTP 层 ID 白名单 ============================
    def test_A1_traversal_delete_works_rejected(self):
        """核心用例：DELETE /api/works/<越界 id> 必须 400/403，且不删任何目录。"""
        payloads = [
            "/api/works/..%2F..%2F..",            # 用户指定的攻击串
            "/api/works/..%2F..",                 # 指向沙箱数据根
            "/api/works/%2e%2e%2f%2e%2e%2f",      # 编码的 ../
            "/api/works/%252F..%252F..",          # 双层编码
            "/api/works/%2F..%2F..%2F..",         # 前导斜杠
            "/api/works/..%5C..%5C",              # 反斜杠
            "/api/works/C%3A%5CWindows",          # Windows 盘符
            "/api/works/%00",                     # NUL 字节
            "/api/works/.%2E%2F.%2E%2F",          # 混合大小写编码
            "/api/works/" + "a" * 300 + "%2F..",  # 超长
        ]
        for path in payloads:
            with self.subTest(path=path):
                code, _ = self.req("DELETE", path)
                self.assertIn(code, (400, 403),
                              "%s 未被拒绝（返回 %s）" % (path, code))
                self.assert_sandbox_intact()
                self.assertTrue(os.path.isdir(os.path.join(self.wd, W_OK)),
                                "合法作品目录被经 %s 的请求误删" % path)

    def test_A2_traversal_delete_universe_worldbook_chapter_rejected(self):
        """其余删除路由同样必须拒绝越界 id。"""
        cases = [
            "/api/universes/..%2F..%2F..",
            "/api/worldbooks/..%2F..%2Fcanary_dir%2Fcanary.txt",
            "/api/worldbooks/..%2F..%2F..",
            "/api/works/" + W_OK + "/chapters/..%2F..%2F..",
            "/api/works/..%2F..%2F..%2Fchapters%2Fch_1",
        ]
        for path in cases:
            with self.subTest(path=path):
                code, _ = self.req("DELETE", path)
                self.assertIn(code, (400, 403))
                self.assert_sandbox_intact()

    def test_A3_traversal_read_and_write_rejected(self):
        """GET / PUT 的越界 id 同样必须拒绝；PUT 越界不得创建任何文件。"""
        cases = [
            ("GET", "/api/worldbooks/..%2F..%2Fservercfg", None),
            ("GET", "/api/universes/..%2F..%2F..", None),
            ("GET", "/api/works/..%2F..%2F..", None),
            ("GET", "/api/works/" + W_OK + "/chapters/..%2F..%2F..", None),
            ("GET", "/api/works/" + W_OK + "/chapters", None),          # 合法 id，应 200
            ("PUT", "/api/worldbooks/..%2F..%2Fevil", {"id": "x"}),
            ("PUT", "/api/works/..%2F..%2Fevil", {"id": "x"}),
            ("PUT", "/api/universes/..%2F..%2Fevil", {"id": "x"}),
            ("PUT", "/api/works/" + W_OK + "/chapters/..%2F..%2Fevil", {"id": "x"}),
        ]
        for method, path, body in cases:
            with self.subTest(m=method, p=path):
                code, _ = self.req(method, path, body)
                if path.endswith("/chapters"):
                    self.assertEqual(code, 200, "合法 id 被误伤：%s" % path)
                else:
                    self.assertIn(code, (400, 403))
                self.assert_sandbox_intact()
        # 越界 PUT 不得在数据根之外落盘
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "evil")),
                         "越界 PUT 在沙箱外创建了文件！")
        self.assertFalse(os.path.exists(os.path.join(self.base, "evil.json")),
                         "越界 PUT 在数据根创建了文件！")
        self.assertFalse(os.path.exists(os.path.join(self.base, "evil")),
                         "越界 PUT 创建了目录！")

    def test_A4_dotdot_with_real_slash_not_routed(self):
        """含真实斜杠的路径不匹配路由正则 → 405（同样不能造成删除）。"""
        for path in ("/api/works/....//", "/api/works/../../..", "/api/works/../.."):
            with self.subTest(path=path):
                code, _ = self.req("DELETE", path)
                self.assertEqual(code, 405, "%s 应落到 405，实际 %s" % (path, code))
                self.assert_sandbox_intact()

    def test_A5_resolve_ignores_invalid_universe_header(self):
        """X-Universe 头非法时按"无宇宙"处理，不得参与路径拼接。"""
        for bad in ("../../..", "..%2F..", "a/b", "", "a\\b", "a%2Fb"):
            with self.subTest(header=bad):
                code, payload = self.req("GET", "/api/resolve", headers={"X-Universe": bad})
                self.assertEqual(code, 200)
                self.assertEqual(json.loads(payload).get("activeWorldBookIds"), [])
                self.assert_sandbox_intact()

    # ============================ B. realpath 前缀兜底 ============================
    def test_B1_safe_join_blocks_escape(self):
        for parts in [("..",), ("..", ".."), ("..", "..", ".."),
                      ("a", "..", ".."), ("chapters", "..", "..", ".."),
                      ("C:\\Windows",)]:
            with self.subTest(parts=parts):
                with self.assertRaises(ValueError):
                    serve._safe_join(self.wd, *parts)

    def test_B2_safe_join_allows_normal(self):
        p = serve._safe_join(self.wd, W_OK, W_OK + "works.json")
        self.assertTrue(p.startswith(os.path.realpath(self.wd) + os.sep))
        self.assertTrue(os.path.isfile(p))

    def test_B3_sibling_prefix_not_confused(self):
        """works-evil 不得被当作 works 之内（防 startswith 前缀误判）。"""
        sibling = self.wd + "-evil"
        os.makedirs(sibling, exist_ok=True)
        with self.assertRaises(ValueError):
            serve._safe_join(self.wd, "..", os.path.basename(sibling))

    def test_B4_is_valid_id_whitelist(self):
        for good in ("wb_1790267900403", "u_1790267866099", "w_1790267868814",
                     "ch_1790267869981", "a", "A_b-9", "x" * 64):
            self.assertTrue(serve.is_valid_id(good), "%r 应合法" % good)
        for bad in ("", "../x", "/abs", "a/b", "a\\b", "a b", "a%2Fb", "a\x00b",
                    "中文", "a.b", "a:b", None, 123, ["a"], "a\nb"):
            self.assertFalse(serve.is_valid_id(bad), "%r 应非法" % (bad,))

    # ============================ C. 回收站 ============================
    def test_C1_delete_work_moves_to_trash_not_rmtree(self):
        code, _ = self.req("DELETE", "/api/works/" + W_OK)
        self.assertEqual(code, 200)
        self.assertFalse(os.path.isdir(os.path.join(self.wd, W_OK)),
                         "作品目录仍在 works/（未被移走）")
        # 必须出现在 _trash/<时间戳>/ 下（保 7 天）
        entries = []
        for root, dirs, _files in os.walk(serve.TRASH_DIR):
            for d in dirs:
                entries.append(d)
        self.assertIn(W_OK, entries, "作品未进入回收站：%r" % entries)
        self.assert_sandbox_intact()

    def test_C2_purge_trash_respects_retention(self):
        dest = serve._move_to_trash(os.path.join(self.wd, W_OK))
        self.assertTrue(os.path.isdir(dest))
        # 保留期内：不清理
        self.assertEqual(serve.purge_trash(7), [])
        self.assertTrue(os.path.isdir(dest))
        # 超过 7 天：应被清理
        old = time.time() - 8 * 86400
        os.utime(os.path.dirname(dest), (old, old))
        removed = serve.purge_trash(7)
        self.assertTrue(removed, "过期回收站条目未被清理")
        self.assertFalse(os.path.exists(dest))

    def test_C3_trash_move_handles_same_second_name_collision(self):
        src = os.path.join(self.wd, W_OK)
        d1 = serve._move_to_trash(src)
        src2 = os.path.join(self.wd, W_OK2)
        os.makedirs(os.path.join(src2, "chapters"), exist_ok=True)
        with open(os.path.join(src2, W_OK2 + "works.json"), "w", encoding="utf-8") as f:
            json.dump({"id": W_OK2, "name": "B", "universeId": "", "chapterIds": []}, f)
        d2 = serve._move_to_trash(src2)
        self.assertTrue(os.path.isdir(d1))
        self.assertTrue(os.path.isdir(d2))
        self.assertNotEqual(d1, d2, "同秒重名未加后缀，发生覆盖")

    # ============================ D. 正常 CRUD 回归（防误伤） ============================
    def test_D1_normal_crud_still_works(self):
        w = "w_ok1"
        code, _ = self.req("PUT", "/api/works/" + w,
                           {"id": w, "name": "N", "universeId": "", "chapterIds": []})
        self.assertEqual(code, 200)
        self.assertTrue(os.path.isfile(os.path.join(self.wd, w, w + "works.json")))

        code, payload = self.req("GET", "/api/works/" + w)
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(payload)["id"], w)

        code, _ = self.req("PUT", "/api/works/%s/chapters/ch_ok1" % w,
                           {"id": "ch_ok1", "body": "hello"})
        self.assertEqual(code, 200)
        code, payload = self.req("GET", "/api/works/%s/chapters/ch_ok1" % w)
        self.assertEqual(code, 200)
        self.assertEqual(json.loads(payload)["body"], "hello")

        code, payload = self.req("GET", "/api/works/%s/chapters" % w)
        self.assertEqual(code, 200)
        self.assertEqual(len(json.loads(payload)["chapters"]), 1)

        code, _ = self.req("DELETE", "/api/works/%s/chapters/ch_ok1" % w)
        self.assertEqual(code, 200)
        self.assertFalse(os.path.exists(
            os.path.join(self.wd, w, "chapters", "ch_ok1.json")))

        code, _ = self.req("PUT", "/api/worldbooks/wb_ok1",
                           {"id": "wb_ok1", "name": "WB", "entries": {}})
        self.assertEqual(code, 200)
        code, _ = self.req("GET", "/api/worldbooks/wb_ok1")
        self.assertEqual(code, 200)
        code, _ = self.req("DELETE", "/api/worldbooks/wb_ok1")
        self.assertEqual(code, 200)
        self.assertFalse(os.path.exists(os.path.join(self.wb, "wb_ok1.json")))

        code, _ = self.req("PUT", "/api/universes/u_ok1",
                           {"id": "u_ok1", "name": "U", "worldBookIds": []})
        self.assertEqual(code, 200)
        code, payload = self.req("GET", "/api/universes/u_ok1")
        self.assertEqual(code, 200)

        # 不存在的合法 id → 404（不是 400/403）
        code, _ = self.req("GET", "/api/works/w_notexist")
        self.assertEqual(code, 404)

    def test_D2_dot_in_id_is_rejected(self):
        """含点的 id 非白名单：即便看起来温和也拒绝（防 ../ 变体）。"""
        for path in ("/api/works/a.b", "/api/works/..", "/api/works/."):
            with self.subTest(path=path):
                code, _ = self.req("DELETE", path)
                self.assertIn(code, (400, 403, 405))
                self.assert_sandbox_intact()


if __name__ == "__main__":
    unittest.main(verbosity=2)
