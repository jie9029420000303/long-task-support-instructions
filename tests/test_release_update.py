import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest


INSTALL = Path(__file__).resolve().parents[1] / 'install-update.py'
ROOTS = runpy.run_path(str(INSTALL))['ROOTS']


class ReleaseUpdateTests(unittest.TestCase):
    def test_platforms_restore_their_own_originals_and_preserve_unrelated_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            old, new, host, backup = [root / name for name in ('old', 'new', 'host', 'backup')]
            for src, dst in ROOTS:
                for base, rel, text in [(old, src, src), (new, src, 'updated'), (host, dst, src)]:
                    (base / rel).mkdir(parents=True)
                    (base / rel / 'same-name').write_text(text)
                (new / src / 'added').write_text('new')
            unrelated = host / '.claude' / 'agents' / 'mine.md'
            unrelated.write_text('mine')
            call = [sys.executable, str(INSTALL), 'install', '--old', str(old), '--new', str(new),
                    '--home', str(host), '--backup', str(backup)]
            output = subprocess.check_output(call, text=True)
            self.assertEqual(json.loads(output)['changed'], 2 * len(ROOTS))
            for src, dst in ROOTS:
                self.assertEqual((backup / src / 'same-name').read_text(), src)
                self.assertEqual((host / dst / 'same-name').read_text(), 'updated')
            subprocess.run([sys.executable, str(INSTALL), 'restore', '--home', str(host), '--backup', str(backup)], check=True)
            for src, dst in ROOTS:
                self.assertEqual((host / dst / 'same-name').read_text(), src)
                self.assertFalse((host / dst / 'added').exists())
            self.assertEqual(unrelated.read_text(), 'mine')
            changed = host / ROOTS[-1][1] / 'same-name'
            changed.write_text('local')
            refused = subprocess.run(call, capture_output=True, text=True)
            self.assertIn('Installed local change', refused.stderr)
            self.assertEqual(changed.read_text(), 'local')
            self.assertEqual((host / ROOTS[0][1] / 'same-name').read_text(), ROOTS[0][0])
