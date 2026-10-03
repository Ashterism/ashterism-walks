#!/usr/bin/env python3
"""Consume HALMAN's small shared queue using the existing downloader/ingest."""
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import time

UTC = dt.timezone.utc


def timestamp(value):
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('Timestamp requires an explicit timezone')
    return parsed.astimezone(UTC)


def validate(request, filename, now):
    walk_id = request['walkId']
    if not re.fullmatch(r'[A-Za-z0-9_-]+', walk_id) or filename != f'{walk_id}.json':
        raise ValueError('Invalid walk ID')
    start, end = timestamp(request['startDate']), timestamp(request['endDate'])
    requested = timestamp(request['requestedAt'])
    if request.get('schemaVersion') != 1 or not start < end:
        raise ValueError('Invalid refresh window')
    if start < now - dt.timedelta(days=8) or end > now + dt.timedelta(minutes=5):
        raise ValueError('Refresh is outside the recent-walk window')
    if end - start > dt.timedelta(days=8) or requested > now + dt.timedelta(minutes=5):
        raise ValueError('Invalid refresh span/request time')
    # The downloader organises capture dates in Europe/Paris. Include adjacent
    # years too, so a UTC/local New Year boundary cannot strand staged media.
    years = range((start - dt.timedelta(days=1)).year, (end + dt.timedelta(days=1)).year + 1)
    return [year for year in years]


def write_result(path, result):
    temporary = path.with_suffix(f'.{os.getpid()}.tmp')
    temporary.write_text(json.dumps(result, indent=2) + '\n')
    temporary.replace(path)


def process(queue, reports, tools, inbox):
    # Use the cron's own lock for the entire download+ingest transaction.
    # Each existing tool ALSO takes its .icloud-sync/.incremental lock.
    reports.mkdir(parents=True, exist_ok=True)
    with (reports / '.pipeline-cron.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        if not (queue / 'requests').is_dir():
            return
        (queue / 'results').mkdir(parents=True, exist_ok=True)
        for file in sorted((queue / 'requests').glob('*.json')):
            result_path = queue / 'results' / file.name
            try:
                request = json.loads(file.read_text())
                previous = json.loads(result_path.read_text()) if result_path.exists() else {}
                if not isinstance(request, dict) or not isinstance(previous, dict):
                    raise ValueError('Queue records must be JSON objects')
            except (ValueError, OSError) as error:
                print(f'{file.name}: unreadable queue record: {error}', flush=True)
                continue
            if previous.get('requestedAt') == request.get('requestedAt'):
                if previous.get('status') == 'complete':
                    continue
                if time.time() - previous.get('attemptedAtEpoch', 0) < 1800:
                    continue
            result = {'requestedAt': request.get('requestedAt'), 'attemptedAtEpoch': time.time()}
            try:
                years = validate(request, file.name, dt.datetime.now(UTC))
                subprocess.run([str(tools / 'run_icloud_sync.sh'), 'window',
                                request['startDate'], request['endDate']], check=True,
                               stdin=subprocess.DEVNULL)
                for year in years:
                    staging = inbox / str(year)
                    if staging.is_dir():
                        subprocess.run([str(tools / 'run_incremental_ingest.sh'), str(year)],
                                       env={**os.environ, 'PHOTO_INGEST_STAGING': str(staging)},
                                       check=True, stdin=subprocess.DEVNULL)
                result.update(status='complete', completedAt=dt.datetime.now(UTC).isoformat())
                print(f"{request['walkId']}: targeted download and safe ingest complete", flush=True)
            except (ValueError, KeyError, subprocess.CalledProcessError, OSError) as error:
                result.update(status='retry', error=str(error))
                print(f'{file.name}: refresh deferred: {error}', flush=True)
            write_result(result_path, result)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--queue', type=Path, default=Path('/mnt/photo/.walk-photo-refresh'))
    parser.add_argument('--reports', type=Path, default=Path('/home/ash/photo-ingest-reports'))
    parser.add_argument('--tools', type=Path, default=Path('/home/ash/photo-tools'))
    parser.add_argument('--inbox', type=Path, default=Path('/home/ash/icloud-inbox'))
    args = parser.parse_args()
    os.umask(0o007)
    process(args.queue, args.reports, args.tools, args.inbox)
