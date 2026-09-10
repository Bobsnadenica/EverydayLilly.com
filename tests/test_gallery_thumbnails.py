"""Thumbnail worker behavior with an in-memory S3 substitute; no AWS writes."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import Mock, patch

with patch.dict(os.environ, {'GALLERY_BUCKET': 'private-test'}), patch.dict(sys.modules, {'boto3': types.SimpleNamespace(client=lambda _: Mock())}):
    spec = importlib.util.spec_from_file_location('thumbnail_worker', 'app/backend/live/prod/lambda/gallery_thumbnails/handler.py')
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)


class ThumbnailTests(unittest.TestCase):
    def setUp(self):
        worker.s3 = Mock()
        worker.s3.head_object.return_value = {'ContentLength': 100, 'ETag': '"abc123"'}
        worker.s3.list_objects_v2.return_value = {}
        worker.s3.generate_presigned_url.return_value = 'https://private.example/original?signature=secret'

    def test_derived_objects_do_not_trigger_recursive_generation(self):
        self.assertEqual(worker.generate('private-test', 'previews/months/example.jpg'), 'ignored')
        self.assertEqual(worker.generate('another-bucket', 'months/0/example.jpg'), 'ignored')
        worker.s3.head_object.assert_not_called()

    def test_repeated_event_reuses_existing_preview(self):
        target = worker.thumbnail_key('months/0/example.jpg', 'abc123')
        worker.s3.list_objects_v2.return_value = {'Contents': [{'Key': target}]}
        self.assertEqual(worker.generate('private-test', 'months/0/example.jpg'), 'exists')
        worker.s3.generate_presigned_url.assert_not_called()
        worker.s3.put_object.assert_not_called()

    def test_s3_event_decodes_filename_before_loading_original(self):
        event = {'Records': [{'s3': {'bucket': {'name': 'private-test'}, 'object': {'key': 'months/0/photo+one%2B.jpg'}}}]}
        with patch.object(worker, 'generate', return_value='exists') as generate:
            self.assertEqual(worker.handler(event, None), {'exists': 1})
            generate.assert_called_once_with('private-test', 'months/0/photo one+.jpg')

    def test_generation_only_writes_a_conditional_private_jpeg(self):
        def decode(command, **kwargs):
            Path(command[-1]).write_bytes(b'\xff\xd8preview')
            return types.SimpleNamespace(returncode=0)
        with patch.object(worker.subprocess, 'run', side_effect=decode):
            self.assertEqual(worker.generate('private-test', 'months/0/example.mov'), 'created')
        request = worker.s3.put_object.call_args.kwargs
        self.assertTrue(request['Key'].startswith('previews/months/'))
        self.assertEqual(request['ContentType'], 'image/jpeg')
        self.assertEqual(request['IfNoneMatch'], '*')
        self.assertIn('private', request['CacheControl'])

    def test_decoder_timeout_does_not_expose_signed_source(self):
        with patch.object(worker.subprocess, 'run', side_effect=subprocess.TimeoutExpired('secret URL', 60)):
            with self.assertRaisesRegex(RuntimeError, '^Gallery preview decoding timed out$'):
                worker.generate('private-test', 'months/0/example.mov')
        worker.s3.put_object.assert_not_called()


if __name__ == '__main__':
    unittest.main()
