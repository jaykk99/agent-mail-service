import json
import stat
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'phone'))
from provision import provision


class PhoneProvisionTests(unittest.TestCase):
    def test_1000_unique_persistent_extensions(self):
        with tempfile.TemporaryDirectory() as d:
            result = provision(d, 1000)
            self.assertEqual(result['count'], 1000)
            path = Path(d) / 'identities.json'
            initial = json.loads(path.read_text())['extensions']
            self.assertEqual(len(initial), 1000)
            self.assertEqual(set(initial), set(map(str, range(2000, 3000))))
            self.assertEqual(len({v['sipPassword'] for v in initial.values()}), 1000)
            provision(d, 1000)
            self.assertEqual(initial, json.loads(path.read_text())['extensions'])
            cfg = (Path(d) / 'pjsip_agents.conf').read_text()
            self.assertIn('[2999]', cfg)
            self.assertIn('username=2999', cfg)
            self.assertIn('context=agents-internal', cfg)
            self.assertEqual(cfg.count('type=endpoint'), 1000)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE((Path(d) / 'pjsip_agents.conf').stat().st_mode), 0o600)
            routes = (Path(d) / 'extensions_agents.conf').read_text()
            self.assertIn('Dial(PJSIP/${EXTEN},30)', routes)
            self.assertNotIn('trunk', routes.lower())

    def test_rejects_invalid_count_and_shrinking(self):
        with tempfile.TemporaryDirectory() as d:
            for n in (0, 1001, -1):
                with self.assertRaises(ValueError):
                    provision(d, n)
            provision(d, 5)
            with self.assertRaises(ValueError):
                provision(d, 3)
            self.assertEqual(provision(d, 7)['count'], 7)


if __name__ == '__main__':
    unittest.main()
