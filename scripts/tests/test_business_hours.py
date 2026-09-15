import importlib.util
import os
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('hours', Path(__file__).resolve().parents[1] / 'business_hours_controller.py')
hours = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hours)


class AWS:
    def __init__(self, running=1, desired=1, database='available', healthy=True, one_off=False):
        self.events = []
        self.services = [dict(serviceName=s, runningCount=running, pendingCount=0, desiredCount=desired) for s in hours.SERVICES]
        self.database = database
        self.healthy = healthy
        self.one_off = one_off
        self.path = hours.OPEN_PATH
        self.tasks = ([dict(taskArn='ai-task', group='service:ai-service', desiredStatus='RUNNING',
                           lastStatus='RUNNING', containers=[dict(name='ai-service', lastStatus='RUNNING', healthStatus='HEALTHY')])]
                      if running else [])
        if one_off:
            self.tasks.append(dict(taskArn='maintenance', group='family:maintenance', desiredStatus='RUNNING', lastStatus='PENDING'))
    def describe_services(self, **kwargs): return {'services': self.services, 'failures': []}
    def describe_db_instances(self, **kwargs): return {'DBInstances': [{'DBInstanceStatus': self.database}]}
    def describe_target_health(self, **kwargs): return {'TargetHealthDescriptions': [{'TargetHealth': {'State': 'healthy' if self.healthy else 'unhealthy'}}]}
    def describe_rules(self, **kwargs): return {'Rules': [{'Conditions': [{'Field': 'path-pattern', 'PathPatternConfig': {'Values': [self.path]}}]}]}
    def modify_rule(self, **kwargs):
        self.path = kwargs['Conditions'][0]['PathPatternConfig']['Values'][0]
        self.events.append(('gate', self.path))
    def update_service(self, **kwargs): self.events.append(('ecs', kwargs['service'], kwargs['desiredCount']))
    def start_db_instance(self, **kwargs): self.events.append(('start_db',))
    def stop_db_instance(self, **kwargs): self.events.append(('stop_db',))
    def list_tasks(self, **kwargs):
        return {'taskArns': [t['taskArn'] for t in self.tasks if t['desiredStatus'] == kwargs['desiredStatus']
                            and (not kwargs.get('serviceName') or t['group'] == 'service:' + kwargs['serviceName'])]}
    def describe_tasks(self, **kwargs):
        return {'tasks': [t for t in self.tasks if t['taskArn'] in kwargs['tasks']], 'failures': []}


class BusinessHoursTests(unittest.TestCase):
    def at(self, stamp): return hours.plan(datetime.fromisoformat(stamp))
    def test_winter_open_boundary(self):
        self.assertFalse(self.at('2026-09-10T20:29:59+00:00')['publicOpen'])
        self.assertTrue(self.at('2026-09-10T20:30:00+00:00')['publicOpen'])
    def test_exact_closing_boundary(self):
        self.assertTrue(self.at('2026-09-11T06:59:59+00:00')['publicOpen'])
        p = self.at('2026-09-11T07:00:00+00:00')
        self.assertFalse(p['publicOpen'])
        self.assertFalse(p['databaseOn'])
        self.assertFalse(p['servicesOn'])
    def test_both_weekend_days_off(self):
        for stamp in ['2026-09-11T20:30:00+00:00', '2026-09-12T20:30:00+00:00']:
            self.assertFalse(any(self.at(stamp)[k] for k in ['publicOpen', 'databaseOn', 'servicesOn']))
    def test_summer_dst_uses_auckland_clock(self):
        self.assertTrue(self.at('2026-01-18T19:30:00+00:00')['publicOpen'])
        self.assertFalse(self.at('2026-01-18T19:29:59+00:00')['publicOpen'])
        self.assertTrue(self.at('2026-01-19T05:59:59+00:00')['publicOpen'])
        self.assertFalse(self.at('2026-01-19T06:00:00+00:00')['publicOpen'])
    def test_dst_change_weekend_stays_closed(self):
        for stamp in ['2026-09-26T13:59:00+00:00', '2026-09-26T14:01:00+00:00']:
            self.assertFalse(self.at(stamp)['publicOpen'])
        self.assertTrue(self.at('2026-09-27T19:30:00+00:00')['publicOpen'])
    def test_warmup_stages_do_not_open_public_traffic(self):
        self.assertFalse(self.at('2026-09-10T19:29:59+00:00')['databaseOn'])
        p = self.at('2026-09-10T19:30:00+00:00')
        self.assertTrue(p['databaseOn']); self.assertFalse(p['servicesOn']); self.assertFalse(p['publicOpen'])
        p = self.at('2026-09-10T20:15:00+00:00')
        self.assertTrue(p['servicesOn']); self.assertFalse(p['publicOpen'])
    def test_expiring_maintenance(self):
        now = datetime.fromisoformat('2026-09-12T00:00:00+00:00')
        self.assertTrue(hours.plan(now, now + timedelta(minutes=1))['publicOpen'])
        self.assertFalse(hours.plan(now, now)['publicOpen'])
    def test_naive_time_rejected(self):
        with self.assertRaises(ValueError): hours.plan(datetime(2026, 9, 11, 10))
    def setUp(self):
        self.env = patch.dict(os.environ, {'CLUSTER':'circini-demo','DATABASE':'circini-demo','GATE_RULE':'gate','FRONTEND_TARGET':'front','BACKEND_TARGET':'back'})
        self.env.start(); self.addCleanup(self.env.stop)
    def reconcile(self, aws, stamp): return hours.reconcile(self.at(stamp), aws, aws, aws)
    def test_closes_before_scaling_and_waits_for_drain(self):
        aws = AWS()
        self.reconcile(aws, '2026-09-11T07:00:00+00:00')
        self.assertEqual(aws.events[0], ('gate', '/*'))
        self.assertEqual(len([e for e in aws.events if e[0]=='ecs']), 3)
        self.assertNotIn(('stop_db',), aws.events)
    def test_stops_database_only_after_tasks_drain(self):
        aws = AWS(running=0, desired=0)
        self.reconcile(aws, '2026-09-11T07:10:00+00:00')
        self.assertIn(('stop_db',), aws.events)
    def test_one_off_task_blocks_database_stop(self):
        aws = AWS(running=0, desired=0, one_off=True)
        self.reconcile(aws, '2026-09-11T07:10:00+00:00')
        self.assertNotIn(('stop_db',), aws.events)
    def test_starts_database_before_tasks_and_keeps_gate_closed(self):
        aws = AWS(running=0, desired=0, database='stopped', healthy=False)
        result = self.reconcile(aws, '2026-09-10T20:30:00+00:00')
        self.assertIn(('start_db',), aws.events)
        self.assertFalse(result['publicReady'])
        self.assertFalse(any(e[0]=='ecs' for e in aws.events))
    def test_unhealthy_target_does_not_open(self):
        aws = AWS(healthy=False)
        self.assertFalse(self.reconcile(aws, '2026-09-10T20:30:00+00:00')['publicReady'])
        self.assertEqual(aws.path, '/*')
    def test_ready_business_hours_are_idempotent(self):
        aws = AWS()
        self.assertTrue(self.reconcile(aws, '2026-09-10T20:30:00+00:00')['publicReady'])
        self.assertEqual(aws.events, [])
    def test_online_database_backup_does_not_stop_tasks(self):
        aws = AWS(database='backing-up')
        self.assertTrue(self.reconcile(aws, '2026-09-10T20:30:00+00:00')['publicReady'])
        self.assertEqual(aws.events, [])
    def test_missing_service_still_closes_gate_before_failed_inspection(self):
        aws = AWS(); aws.services.pop()
        with self.assertRaises(RuntimeError): self.reconcile(aws, '2026-09-11T07:00:00+00:00')
        self.assertEqual(aws.events, [('gate', '/*')])
    def test_rds_read_failure_cannot_leave_closed_hours_open(self):
        aws = AWS()
        with patch.object(aws, 'describe_db_instances', side_effect=RuntimeError('RDS read unavailable')):
            with self.assertRaises(RuntimeError): self.reconcile(aws, '2026-09-11T07:00:00+00:00')
        self.assertEqual(aws.events, [('gate', '/*')])
    def test_unknown_open_hours_readiness_closes_existing_open_gate(self):
        aws = AWS()
        with patch.object(aws, 'describe_tasks', side_effect=RuntimeError('Task health read unavailable')):
            with self.assertRaises(RuntimeError): self.reconcile(aws, '2026-09-10T20:30:00+00:00')
        self.assertEqual(aws.events, [('gate', '/*')])
    def test_unreadable_lease_closes_after_hours_without_stopping_compute(self):
        aws = AWS()
        clients = SimpleNamespace(client=lambda name: aws)
        with patch.dict(sys.modules, {'boto3': clients}), \
                patch.object(hours, 'read_lease', side_effect=RuntimeError('Lease unavailable')), \
                patch.object(hours, 'plan', return_value=self.at('2026-09-11T07:00:00+00:00')):
            with self.assertRaises(RuntimeError): hours.handler({'operation': 'reconcile'}, None)
        self.assertEqual(aws.events, [('gate', '/*')])
    def test_ai_running_with_unknown_or_failed_application_health_stays_closed(self):
        for health in ['UNKNOWN', 'UNHEALTHY']:
            with self.subTest(health=health):
                aws = AWS()
                aws.tasks[0]['healthStatus'] = 'HEALTHY'  # A healthy sidecar must not qualify the app.
                aws.tasks[0]['containers'][0]['healthStatus'] = health
                self.assertFalse(self.reconcile(aws, '2026-09-10T20:30:00+00:00')['publicReady'])
                self.assertEqual(aws.path, '/*')
    def test_one_off_healthy_ai_container_does_not_qualify_service_readiness(self):
        aws = AWS()
        aws.tasks[0]['group'] = 'family:ai-service'
        self.assertFalse(self.reconcile(aws, '2026-09-10T20:30:00+00:00')['publicReady'])
    def test_actual_stopping_task_blocks_database_stop(self):
        for state in ['DEACTIVATING', 'STOPPING', 'DEPROVISIONING']:
            with self.subTest(state=state):
                aws = AWS(running=0, desired=0)
                aws.tasks.append(dict(taskArn='draining', group='service:backend', desiredStatus='STOPPED', lastStatus=state))
                self.reconcile(aws, '2026-09-11T07:10:00+00:00')
                self.assertNotIn(('stop_db',), aws.events)
    def test_actual_stopped_history_does_not_block_database_stop(self):
        aws = AWS(running=0, desired=0)
        aws.tasks.append(dict(taskArn='finished', group='service:backend', desiredStatus='STOPPED', lastStatus='STOPPED'))
        self.reconcile(aws, '2026-09-11T07:10:00+00:00')
        self.assertIn(('stop_db',), aws.events)
    def test_task_lookup_failure_prevents_database_stop(self):
        aws = AWS(running=0, desired=0)
        aws.tasks.append(dict(taskArn='draining', group='service:backend', desiredStatus='STOPPED', lastStatus='STOPPING'))
        with patch.object(aws, 'describe_tasks', return_value={'tasks': [], 'failures': [{'reason': 'MISSING'}]}):
            with self.assertRaises(RuntimeError): self.reconcile(aws, '2026-09-11T07:10:00+00:00')
        self.assertNotIn(('stop_db',), aws.events)
    def test_drain_checks_empty_pages_before_stopping_database(self):
        aws = AWS(running=0, desired=0, one_off=True)
        original = aws.list_tasks
        def paged(**kwargs):
            if kwargs.get('serviceName'):
                return original(**kwargs)
            if kwargs['desiredStatus'] == 'RUNNING' and not kwargs.get('nextToken'):
                return {'taskArns': [], 'nextToken': 'more'}
            return original(**kwargs)
        with patch.object(aws, 'list_tasks', side_effect=paged):
            self.reconcile(aws, '2026-09-11T07:10:00+00:00')
        self.assertNotIn(('stop_db',), aws.events)
    def test_alarm_failure_happens_after_gate_closes_and_services_scale_down(self):
        aws = AWS()
        cloudwatch = SimpleNamespace(describe_alarms=lambda **kw: (_ for _ in ()).throw(RuntimeError('Alarm read unavailable')))
        clients = SimpleNamespace(client=lambda name: cloudwatch if name == 'cloudwatch' else aws)
        with patch.dict(sys.modules, {'boto3': clients}), patch.object(hours, 'read_lease', return_value=({}, None)), \
                patch.object(hours, 'plan', return_value=self.at('2026-09-11T07:00:00+00:00')):
            with self.assertRaises(RuntimeError): hours.handler({'operation': 'reconcile'}, None)
        self.assertEqual(aws.events[0], ('gate', '/*'))
        self.assertEqual(len([e for e in aws.events if e[0] == 'ecs']), 3)
    def test_only_availability_notifications_follow_open_hours(self):
        calls = []
        class CloudWatch:
            def describe_alarms(self, **kwargs):
                self.asserted = kwargs['AlarmNames']
                return {'MetricAlarms': [{'ActionsEnabled': True}]}
            def disable_alarm_actions(self, **kwargs): calls.append(kwargs['AlarmNames'])
        cw = CloudWatch()
        hours.set_availability_notifications(cw, False)
        self.assertEqual(calls, [['circini-backend-unavailable']])
        self.assertEqual(cw.asserted, ['circini-backend-unavailable'])

    def test_simulated_reconcile_rejected(self):
        with self.assertRaises(ValueError): hours.handler({'operation':'reconcile','at':'2026-09-11T07:00:00+00:00'}, None)
    def test_plan_does_not_create_aws_clients(self):
        self.assertFalse(hours.handler({'operation':'plan','at':'2026-09-12T00:00:00+00:00'}, None)['publicOpen'])

if __name__ == '__main__': unittest.main()
