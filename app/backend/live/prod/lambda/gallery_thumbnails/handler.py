"""Create private, immutable JPEG previews after original gallery uploads."""
import hashlib
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import unquote_plus

import boto3

s3 = boto3.client('s3')
BUCKET = os.environ['GALLERY_BUCKET']
PREFIX = os.environ.get('GALLERY_PREFIX', 'months')
FFMPEG = os.environ.get('FFMPEG_PATH', '/var/task/ffmpeg')
MEDIA = re.compile(r'\.(avif|gif|jpe?g|m4v|mov|mp4|png|webm|webp)$', re.I)
VIDEO = re.compile(r'\.(m4v|mov|mp4|webm)$', re.I)


def thumbnail_key(key, etag):
    digest = hashlib.sha256((key + '\n' + etag.strip('"')).encode()).hexdigest()
    return f'previews/{PREFIX}/{digest}.jpg'


def generate(bucket, key):
    if bucket != BUCKET or not key.startswith(PREFIX + '/') or not MEDIA.search(key):
        return 'ignored'
    source = s3.head_object(Bucket=BUCKET, Key=key)
    if not source['ContentLength']:
        return 'ignored'
    target = thumbnail_key(key, source['ETag'])
    existing = s3.list_objects_v2(Bucket=BUCKET, Prefix=target, MaxKeys=1)
    if any(item['Key'] == target for item in existing.get('Contents', [])):
        return 'exists'
    url = s3.generate_presigned_url('get_object', Params={'Bucket': BUCKET, 'Key': key}, ExpiresIn=300)
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory) / 'preview.jpg'
        for seek in ([0.25, 0] if VIDEO.search(key) else [0]):
            command = [FFMPEG, '-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1']
            if seek:
                command += ['-ss', str(seek)]
            command += ['-i', url, '-frames:v', '1', '-an', '-vf',
                        'scale=640:640:force_original_aspect_ratio=decrease',
                        '-q:v', '5', '-map_metadata', '-1', '-update', '1', '-y', str(output)]
            # Never log FFmpeg stderr: errors can include the private signed URL.
            try:
                result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=60)
            except subprocess.TimeoutExpired:
                raise RuntimeError('Gallery preview decoding timed out') from None
            if result.returncode == 0 and output.exists() and output.stat().st_size:
                break
        else:
            raise RuntimeError('Unable to decode gallery preview')
        s3.put_object(Bucket=BUCKET, Key=target, Body=output.read_bytes(), ContentType='image/jpeg',
                      CacheControl='private, max-age=31536000, immutable', IfNoneMatch='*')
    return 'created'


def handler(event, context):
    # Direct invocation supports controlled backfills; S3 events handle new uploads.
    records = event.get('Records', [])
    if 'key' in event:
        records = [{'s3': {'bucket': {'name': BUCKET}, 'object': {'key': event['key']}}}]
    counts = {}
    for record in records:
        obj = record.get('s3', {})
        key = obj.get('object', {}).get('key', '')
        if 'key' not in event:
            key = unquote_plus(key)
        result = generate(obj.get('bucket', {}).get('name'), key)
        counts[result] = counts.get(result, 0) + 1
    return counts
