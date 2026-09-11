import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('manage_hours', Path(__file__).parents[1] / 'manage-business-hours.py')
manage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manage)


class StartupLeaseTests(unittest.TestCase):
    def test_short_window_begins_after_readiness(self):
        with patch.object(manage, 'invoke', side_effect=[{'publicReady': False}, {'publicReady': True}, {}]) as invoke, patch.object(manage.time, 'sleep'):
            manage.operate({'operation': 'hold', 'owner': 'manual', 'minutes': 5}, wait=True)
        self.assertEqual(invoke.call_args_list[0].args[0]['minutes'], 90)
        self.assertEqual(invoke.call_args_list[-1].args[0], {'operation': 'hold', 'owner': 'manual', 'minutes': 5})

    def test_first_phase_keeps_startup_lease_without_shortening(self):
        with patch.object(manage, 'invoke', return_value={'publicReady': False}) as invoke, patch.object(manage.time, 'monotonic', side_effect=[0, 2401]):
            manage.operate({'operation': 'hold', 'owner': 'manual', 'minutes': 5}, wait=True, pending_ok=True)
        self.assertEqual(invoke.call_count, 1)
        self.assertEqual(invoke.call_args.args[0]['minutes'], 90)

    def test_final_phase_fails_if_not_ready(self):
        with patch.object(manage, 'invoke', return_value={'publicReady': False}), patch.object(manage.time, 'monotonic', side_effect=[0, 2401]):
            with self.assertRaises(TimeoutError):
                manage.operate({'operation': 'hold', 'owner': 'deploy', 'minutes': 180}, wait=True)

    def test_optional_absent_controller_does_not_wait(self):
        with patch.object(manage, 'invoke', return_value=None) as invoke:
            manage.operate({'operation': 'hold', 'owner': 'deploy', 'minutes': 180}, optional=True, wait=True)
        self.assertEqual(invoke.call_count, 1)


if __name__ == '__main__':
    unittest.main()
