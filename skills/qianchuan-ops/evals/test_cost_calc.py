"""Synthetic, offline arithmetic checks. These do not test a real ad account."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("cost_calc_under_test", ROOT / "scripts/cost_guarantee_calc.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

class CostCalcTests(unittest.TestCase):
    def run_case(self, payload, **expected):
        result = MODULE.calculate(payload)
        for key, value in expected.items():
            self.assertEqual(result[key], value, key)
        self.assertFalse(result["eligibility_confirmed"])
        self.assertTrue(result["calculation_only"])
        return result

    def test_cpa_exact_boundary_does_not_trigger(self):
        self.run_case({"kind":"boost_cpa","spend":"240","periods":[{"target":"20","orders":10}]}, effect_threshold_met=False, conditional_amount_if_all_rules_satisfied="0")

    def test_cli_accepts_bom_from_stdin_and_file(self):
        payload = {"kind":"boost_cpa", "spend":"320", "periods":[{"target":"20", "orders":5}, {"target":"30", "orders":5}], "note":"模拟数据"}
        encoded = ("\ufeff" + json.dumps(payload, ensure_ascii=False)).encode("utf-8")
        env = dict(os.environ, PYTHONUTF8="1")
        with tempfile.TemporaryDirectory() as task_directory:
            path = Path(task_directory) / "模拟输入.json"
            path.write_bytes(encoded)
            for args in ([], ["--input", str(path)]):
                with self.subTest(input="file" if args else "stdin"):
                    result = subprocess.run([sys.executable, str(ROOT / "scripts/cost_guarantee_calc.py"), *args], input=encoded if not args else None, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=task_directory, env=env)
                    self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8"))
                    data = json.loads(result.stdout.decode("utf-8"))
                    self.assertEqual(data["conditional_amount_if_all_rules_satisfied"], "70")
                    self.assertFalse(data["eligibility_confirmed"])
            self.assertEqual(path.read_bytes(), encoded)

    def test_cpa_above_boundary(self):
        self.run_case({"kind":"boost_cpa","spend":"260","periods":[{"target":"20","orders":10}]}, effect_threshold_met=True, conditional_amount_if_all_rules_satisfied="60")

    def test_cpa_changed_target(self):
        self.run_case({"kind":"boost_cpa","spend":"320","periods":[{"target":"20","orders":5},{"target":"30","orders":5}]}, total_target_amount="250", composite_target="25", conditional_amount_if_all_rules_satisfied="70")

    def test_roi_changed_target(self):
        self.run_case({"kind":"main_roi","spend":"130","periods":[{"target":"2","gmv":"100","orders":4},{"target":"4","gmv":"200","orders":6}]}, total_target_amount="100", composite_target="3", conditional_amount_if_all_rules_satisfied="30")

    def test_roi_exact_fractional_boundary(self):
        # 1/3 + 2/3 = 1 exactly; 1.25 * 0.8 = 1. No strict inequality.
        self.run_case({"kind":"boost_roi","spend":"1.25","periods":[{"target":"3","gmv":"1","orders":5},{"target":"3","gmv":"2","orders":5}]}, total_target_amount="1", effect_threshold_met=False, conditional_amount_if_all_rules_satisfied="0")

    def test_missing_roi_orders_does_not_confirm_threshold(self):
        self.run_case({"kind":"main_roi","spend":"700","periods":[{"target":"2.6","gmv":"1300"}]}, order_threshold_met=None, conditional_amount_if_all_rules_satisfied=None)

    def test_insufficient_orders_not_qualified_even_if_cost_high(self):
        self.run_case({"kind":"boost_cpa","spend":"260","periods":[{"target":"20","orders":9}]}, order_threshold_met=False, conditional_amount_if_all_rules_satisfied="0")

    def test_zero_orders_does_not_invent_cpa(self):
        self.run_case({"kind":"boost_cpa","spend":"50","periods":[{"target":"20","orders":0}]}, actual_metric=None, effect_threshold_met=None, conditional_amount_if_all_rules_satisfied="0")

    def test_zero_spend(self):
        self.run_case({"kind":"main_roi","spend":"0","periods":[{"target":"2","gmv":"100","orders":10}]}, actual_metric=None, effect_threshold_met=False, conditional_amount_if_all_rules_satisfied="0")

    def test_zero_gmv_no_weighted_target(self):
        self.run_case({"kind":"main_roi","spend":"50","periods":[{"target":"2","gmv":"0","orders":0}]}, composite_target=None, conditional_amount_if_all_rules_satisfied="0")

    def test_bad_values_rejected(self):
        bad = [
            {"kind":"boost_volume","spend":"100","periods":[{"target":"20","orders":10}]},
            {"kind":"boost_cpa","spend":"-1","periods":[{"target":"20","orders":10}]},
            {"kind":"boost_cpa","spend":"NaN","periods":[{"target":"20","orders":10}]},
            {"kind":"boost_cpa","spend":"100","periods":[{"target":"0","orders":10}]},
            {"kind":"boost_cpa","spend":"100","periods":[{"target":"20","orders":True}]},
            {"kind":"boost_cpa","spend":"100","periods":[{"target":"20","orders":1.5}]},
            {"kind":"boost_cpa","spend":"100","periods":[]},
            {"kind":"boost_cpa","spend":"100","periods":[{"target":"20"}]},
        ]
        for payload in bad:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                MODULE.calculate(payload)

if __name__ == "__main__":
    unittest.main()
