import datetime as dt
import fcntl
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/ashserver/process-walk-photo-refresh.py'
spec = importlib.util.spec_from_file_location('refresh', SCRIPT)
refresh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(refresh)


class RefreshTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.queue = self.root / 'queue'
        self.reports = self.root / 'reports'
        self.tools = self.root / 'tools'
        self.inbox = self.root / 'inbox'
        (self.queue / 'requests').mkdir(parents=True)
        self.reports.mkdir()
        now = dt.datetime.now(dt.timezone.utc)
        self.request = {'schemaVersion': 1, 'walkId': '24576877588',
                        'startDate': (now - dt.timedelta(hours=10)).isoformat(),
                        'endDate': (now - dt.timedelta(hours=1)).isoformat(),
                        'requestedAt': now.isoformat()}
        (self.queue / 'requests/24576877588.json').write_text(json.dumps(self.request))
        (self.inbox / str(now.year)).mkdir(parents=True)

    def process(self):
        refresh.process(self.queue, self.reports, self.tools, self.inbox)

    def result(self):
        return json.loads((self.queue / 'results/24576877588.json').read_text())

    @patch.object(refresh.subprocess, 'run')
    def test_download_then_existing_ingest_and_idempotent_acknowledgement(self, run):
        self.process()
        self.assertEqual(self.result()['status'], 'complete')
        self.assertEqual(run.call_args_list[0].args[0], [str(self.tools / 'run_icloud_sync.sh'), 'window',
                                                       self.request['startDate'], self.request['endDate']])
        self.assertEqual(run.call_args_list[1].args[0][0], str(self.tools / 'run_incremental_ingest.sh'))
        self.assertEqual(run.call_args_list[1].kwargs['env']['PHOTO_INGEST_STAGING'],
                         str(self.inbox / str(dt.datetime.now().year)))
        run.reset_mock()
        self.process()
        run.assert_not_called()

    @patch.object(refresh.subprocess, 'run')
    def test_normal_pipeline_lock_defers_without_acknowledging(self, run):
        with (self.reports / '.pipeline-cron.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.process()
        run.assert_not_called()
        self.assertFalse((self.queue / 'results/24576877588.json').exists())

    @patch.object(refresh.subprocess, 'run')
    def test_ingest_failure_does_not_acknowledge_and_backs_off(self, run):
        run.side_effect = [None, subprocess.CalledProcessError(1, 'ingest')]
        self.process()
        self.assertEqual(self.result()['status'], 'retry')
        run.reset_mock()
        self.process()
        run.assert_not_called()

    @patch.object(refresh.subprocess, 'run')
    def test_reject_historical_or_naive_requests(self, run):
        self.request['startDate'] = '2020-01-01T00:00:00Z'
        (self.queue / 'requests/24576877588.json').write_text(json.dumps(self.request))
        self.process()
        run.assert_not_called()
        self.assertEqual(self.result()['status'], 'retry')
        with self.assertRaises(ValueError):
            refresh.timestamp('2026-10-02T12:00:00')

    def test_new_year_window_includes_local_year_boundaries(self):
        request = {**self.request, 'startDate': '2026-12-31T22:30:00Z', 'endDate': '2027-01-01T02:00:00Z',
                   'requestedAt': '2027-01-01T03:00:00Z'}
        self.assertEqual(refresh.validate(request, '24576877588.json', refresh.timestamp(request['requestedAt'])), [2026, 2027])

    @patch.object(refresh.subprocess, 'run')
    def test_bad_queue_record_does_not_block_other_walks(self, run):
        (self.queue / 'requests/000-broken.json').write_text('{')
        self.process()
        self.assertEqual(self.result()['status'], 'complete')
        self.assertGreaterEqual(run.call_count, 2)


if __name__ == '__main__':
    unittest.main()
