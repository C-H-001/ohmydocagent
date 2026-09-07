"""Exercise real streaming RPCs for current and legacy backend package names."""
import importlib
import importlib.util
import os
import socket
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import grpc

PACKAGE = next(name for name in ("ohmydocagent_parser", "docmind_parser")
               if importlib.util.find_spec(name) is not None)
server_module = importlib.import_module(f"{PACKAGE}.server")
pb = importlib.import_module(f"{PACKAGE}.generated.parser_pb2")


class SourceHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        source = b"Parser RPC contract check."
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(source)))
        self.end_headers()
        self.wfile.write(source)

    def log_message(self, *args):
        pass


class ParserRpcContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = ThreadingHTTPServer(("127.0.0.1", 0), SourceHandler)
        cls.thread = threading.Thread(target=cls.source.serve_forever, daemon=True)
        cls.thread.start()
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        cls.server = server_module.serve(port)
        cls.channel = grpc.insecure_channel(f"127.0.0.1:{port}")
        grpc.channel_ready_future(cls.channel).result(timeout=5)

    @classmethod
    def tearDownClass(cls):
        cls.channel.close()
        cls.server.stop(0).wait(timeout=5)
        cls.source.shutdown()
        cls.source.server_close()
        cls.thread.join(timeout=5)

    def parse(self, service_name):
        call = self.channel.unary_stream(
            f"/{service_name}/Parse", request_serializer=pb.ParseRequest.SerializeToString,
            response_deserializer=pb.ParseEvent.FromString)
        request = pb.ParseRequest(
            job_id="contract-check", source_url=f"http://127.0.0.1:{self.source.server_port}/sample.txt",
            mime_type="text/plain", engine="mineru")
        try:
            events = list(call(request, timeout=10))
        except grpc.RpcError as error:
            self.fail(f"{service_name}/Parse failed: {error.code().name}")
        self.assertFalse(any(event.HasField("error") for event in events))
        blocks = [event.block for event in events if event.HasField("block")]
        self.assertEqual([block.text for block in blocks], ["Parser RPC contract check."])
        completed = [event.completed for event in events if event.HasField("completed")]
        self.assertEqual(len(completed), 1)
        self.assertEqual(completed[0].block_count, 1)

    def test_current_backend_parse_rpc(self):
        self.parse("ohmydocagent.parser.v1.Parser")

    def test_legacy_backend_parse_rpc(self):
        self.parse("docmind.parser.v1.Parser")


class ParserEnvironmentTests(unittest.TestCase):
    def test_current_container_environment_takes_precedence(self):
        with patch.dict(os.environ, {
            "OHMYDOCAGENT_PARSER_BIND": "0.0.0.0", "DOCMIND_PARSER_BIND": "127.0.0.1",
            "OHMYDOCAGENT_PARSER_CONCURRENCY": "2", "DOCMIND_PARSER_CONCURRENCY": "1",
            "OHMYDOCAGENT_PARSER_MAX_SOURCE_BYTES": "2048", "DOCMIND_PARSER_MAX_SOURCE_BYTES": "1024",
            "OHMYDOCAGENT_PARSER_SOURCE_TIMEOUT_SECONDS": "20", "DOCMIND_PARSER_SOURCE_TIMEOUT_SECONDS": "10",
        }, clear=True):
            self.assertEqual(server_module._parser_bind_target(50051), "0.0.0.0:50051")
            self.assertEqual(server_module._parser_concurrency(), 2)
            self.assertEqual(server_module._max_source_bytes(), 2048)
            self.assertEqual(server_module._source_timeout_seconds(), 20)

    def test_legacy_container_environment_remains_supported(self):
        with patch.dict(os.environ, {
            "DOCMIND_PARSER_BIND": "0.0.0.0", "DOCMIND_PARSER_CONCURRENCY": "2",
            "DOCMIND_PARSER_MAX_SOURCE_BYTES": "1024", "DOCMIND_PARSER_SOURCE_TIMEOUT_SECONDS": "10",
        }, clear=True):
            self.assertEqual(server_module._parser_bind_target(50051), "0.0.0.0:50051")
            self.assertEqual(server_module._parser_concurrency(), 2)
            self.assertEqual(server_module._max_source_bytes(), 1024)
            self.assertEqual(server_module._source_timeout_seconds(), 10)


if __name__ == "__main__":
    unittest.main()
