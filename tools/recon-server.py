#!/usr/bin/env python3
"""Tiny local sink for the recon extension. Writes each POST body to a file.

Usage: python3 tools/recon-server.py <output-dir> [port]
"""
import datetime
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

OUT = sys.argv[1]
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8765
os.makedirs(OUT, exist_ok=True)


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        name = re.sub(r"[^A-Za-z0-9_.-]", "_", self.path.strip("/")) or "dump"
        stamp = datetime.datetime.now().strftime("%H%M%S")
        path = os.path.join(OUT, f"{stamp}_{name}")
        with open(path, "wb") as f:
            f.write(body)
        print(f"wrote {path} ({len(body)} bytes)", flush=True)
        self.send_response(200)
        self._cors()
        self.end_headers()
        self.wfile.write(b"ok")


HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
