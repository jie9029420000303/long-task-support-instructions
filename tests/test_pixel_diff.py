"""長頁像素比對工具（pixel-diff.js）回歸測試。

為什麼重要：換版時「受影響範圍外沒變」是沿用前一版肉眼查核的唯一依據（共用規格不變量 7）。
該判 outside 卻判成 identical／inside，舊查核就被錯誤沿用；同一版截兩次就不一樣，每次換版都會被
誤判成要重驗、省不到時間；兩個平台的工具內容不同，同一個任務換平台就換判準。
本機沒有 playwright 或 chrome-headless-shell 時，實際截圖比對的測試會明確標為 skipped，不算通過。
"""
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[1]
CANDIDATES = [
    REPOSITORY / "claude-code" / ".claude" / "skills" / "long-task-orchestrator" / "scripts" / "pixel-diff.js",
    REPOSITORY / "codex" / ".agents" / "skills" / "goal-orchestrator" / "scripts" / "pixel-diff.js",
    REPOSITORY / ".claude" / "skills" / "long-task-orchestrator" / "scripts" / "pixel-diff.js",
    REPOSITORY / "goal-orchestrator" / "scripts" / "pixel-diff.js",
]
TOOLS = [p for p in CANDIDATES if p.is_file()]
NODE = shutil.which("node")


def page(changed="height:200px;background:#4a8", foot="background:#333", clock="10:00:00", extra=""):
    return (
        '<!doctype html><html><head><meta charset="utf-8"><style>'
        "body{margin:0;font-family:sans-serif}header{height:80px;background:#123}section{padding:40px}"
        ".card{height:300px;background:#eee;margin:20px 0}#changed{" + changed + "}"
        "footer{height:120px;color:#fff;" + foot + "}"
        "@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}"
        ".spin{width:40px;height:40px;background:red;animation:spin 2s infinite linear}"
        '</style></head><body><header id="top"></header>'
        '<section id="s1"><div class="card"></div><div id="changed">x</div><div class="spin"></div></section>'
        '<section id="s2"><div class="card"></div><div class="card"></div></section>'
        + extra
        + '<div id="clock">' + clock + '</div><footer id="foot">footer</footer></body></html>'
    )


class PixelDiffParityTests(unittest.TestCase):
    @unittest.skipUnless(len(TOOLS) >= 2, "獨立技能副本只有一份 pixel-diff.js，兩平台一致性只在正式 repo 驗")
    def test_both_platforms_ship_the_same_tool(self):
        # 判準寫在程式裡：兩份不同，同一個任務在 Claude 與 Codex 會得到不同的沿用結論。
        first = TOOLS[0].read_bytes()
        for other in TOOLS[1:]:
            self.assertEqual(first, other.read_bytes(), str(other))


@unittest.skipUnless(TOOLS and NODE, "找不到 pixel-diff.js 或 node")
class PixelDiffBehaviourTests(unittest.TestCase):
    tool = TOOLS[0] if TOOLS else None

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="pixel-diff-test-"))
        probe = cls.tmp / "probe.html"
        probe.write_text(page(), encoding="utf-8")
        result = subprocess.run([NODE, str(cls.tool), "capture", str(probe), str(cls.tmp / "probe"), "--widths", "320"], capture_output=True, text=True, timeout=120)
        if result.returncode == 2:
            raise unittest.SkipTest("本機沒有 playwright 或 chrome-headless-shell：" + result.stderr.strip())
        if result.returncode != 0:
            raise AssertionError("探測截圖失敗：" + result.stderr)
        cls.counter = 0

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def capture(self, html, widths="320,800", *extra):
        type(self).counter += 1
        name = "c%03d" % self.counter
        src = self.tmp / (name + ".html")
        src.write_text(html, encoding="utf-8")
        out = self.tmp / name
        result = subprocess.run([NODE, str(self.tool), "capture", str(src), str(out), "--widths", widths, "--wait", "50", *extra], capture_output=True, text=True, timeout=180)
        self.assertEqual(result.returncode, 0, result.stderr)
        return out

    def compare(self, old, new, *extra):
        result = subprocess.run([NODE, str(self.tool), "compare", str(old), str(new), *extra], capture_output=True, text=True, timeout=180)
        report = None
        if result.returncode in (0, 1):
            summary = json.loads(result.stdout)
            report = json.loads(Path(summary["report"]).read_text(encoding="utf-8"))
        return result, report

    def test_same_page_captured_twice_is_identical_even_with_running_animation(self):
        # 同一版截兩次不同，每次換版都會被誤判成要重驗；無限動畫是最常見的不穩定來源。
        a, b = self.capture(page()), self.capture(page())
        result, report = self.compare(a, b)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(report["verdict"], "identical")

    def test_change_inside_affected_scope_keeps_the_rest_reusable(self):
        a = self.capture(page())
        b = self.capture(page(changed="height:200px;background:#a48"), "320,800", "--track", "#changed")
        result, report = self.compare(a, b, "--affected", "#changed")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(report["verdict"], "inside")
        self.assertEqual(report["needsReverify"], [])

    def test_unlisted_change_is_outside_and_located(self):
        # 執行端漏列受影響範圍時，比對必須抓到、並指出落在哪個區段。
        a = self.capture(page())
        b = self.capture(page(changed="height:200px;background:#a48"))
        result, report = self.compare(a, b)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["verdict"], "outside")
        sections = [s for item in report["needsReverify"] for band in item["bands"] for s in band["sections"]]
        self.assertIn("#changed", sections)

    def test_growth_inside_affected_scope_that_pushes_content_down_stays_inside(self):
        # 受影響元件變高、下方整段往下推是最常見的修正型態；不能因為頁高改變就要求整頁重驗。
        a = self.capture(page())
        b = self.capture(page(changed="height:260px;background:#4a8"))
        result, report = self.compare(a, b, "--affected", "#changed")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(report["verdict"], "inside")
        self.assertTrue(all(r.get("heightChanged") for r in report["results"]))

    def test_outside_change_is_reported_even_when_an_inside_change_exists(self):
        a = self.capture(page())
        b = self.capture(page(changed="height:200px;background:#a48", foot="background:#336"), "800")
        result, report = self.compare(a, b, "--affected", "#changed")
        self.assertEqual(result.returncode, 1)
        widths = {item["width"]: item for item in report["needsReverify"]}
        self.assertTrue(widths[320]["wholePage"], "本版少截 320 寬，必須整頁重驗")
        bands = widths[800]["bands"]
        self.assertTrue(bands and all("#foot" in band["sections"] for band in bands), bands)
        self.assertFalse(any("#changed" in band["sections"] for band in bands), bands)

    def test_masked_dynamic_region_is_ignored_but_unmasked_is_caught(self):
        a = self.capture(page(clock="10:00:00"), "800", "--mask", "#clock")
        b = self.capture(page(clock="23:59:59 changed"), "800", "--mask", "#clock")
        result, report = self.compare(a, b)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(report["verdict"], "identical")
        c = self.capture(page(clock="10:00:00"), "800")
        d = self.capture(page(clock="23:59:59 changed"), "800")
        result, report = self.compare(c, d, "--affected", "#changed")
        self.assertEqual(result.returncode, 1)

    def test_horizontal_overflow_forces_whole_page_reverify(self):
        a = self.capture(page(), "800")
        b = self.capture(page(extra='<div style="width:2000px;height:10px"></div>'), "800")
        result, report = self.compare(a, b, "--affected", "#changed")
        self.assertEqual(result.returncode, 1)
        self.assertTrue(report["needsReverify"][0]["wholePage"])

    def test_long_page_is_stitched_without_seams(self):
        # 超過單次截圖高度的長頁要分段接合；接縫錯位會讓同一版比對不相同。
        rows = "".join('<div id="r%d" style="height:500px;background:hsl(%d,60%%,70%%)">%d</div>' % (i, i * 17, i) for i in range(20))
        html = page(extra=rows)
        a, b = self.capture(html, "800"), self.capture(html, "800")
        manifest = json.loads((a / "manifest.json").read_text(encoding="utf-8"))
        self.assertGreater(manifest["widths"][0]["pixelHeight"], 9000)
        result, report = self.compare(a, b)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(report["verdict"], "identical")

    def test_unknown_affected_scope_is_an_input_error(self):
        a = self.capture(page(), "320")
        result, _ = self.compare(a, a, "--affected", "#does-not-exist")
        self.assertEqual(result.returncode, 3)
        self.assertIn("--track", result.stderr)

    def test_capture_refuses_to_overwrite(self):
        a = self.capture(page(), "320")
        src = self.tmp / "again.html"
        src.write_text(page(), encoding="utf-8")
        result = subprocess.run([NODE, str(self.tool), "capture", str(src), str(a), "--widths", "320"], capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 3)

    def test_tampered_capture_is_rejected(self):
        a = self.capture(page(), "320")
        b = self.capture(page(), "320")
        png = b / "w320.png"
        data = bytearray(png.read_bytes())
        data[-20] ^= 0xFF
        png.write_bytes(bytes(data))
        result, _ = self.compare(a, b)
        self.assertEqual(result.returncode, 3)


if __name__ == "__main__":
    unittest.main()

