#!/usr/bin/env python3
"""Threaded, no-cache static server for local + iPad-LAN testing of the built app (dist/).

Why threaded: a single-threaded socketserver.TCPServer / HTTPServer processes one connection at a
time, so ONE socket a browser opens speculatively (a preconnect that hasn't sent a request yet)
blocks the server's only thread in handle_one_request -> rfile.readline(). Every other resource
request then stalls, and the page's `load` event never fires. Safari/WebKit opens more of these
preconnect sockets than Chrome, so it hit this intermittently (a 30s Playwright `waitUntil:'load'`
timeout) while Chrome stayed fine. ThreadingHTTPServer serves each connection on its own thread, so
an idle preconnect can't starve the real requests. (Stock `python -m http.server` is already
threaded since 3.7; this adds the no-cache headers an iPad-over-LAN needs to always fetch fresh.)

Usage:  python3 scripts/serve-nocache.py [dir=dist] [port=9000]
        npm run serve
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

directory = sys.argv[1] if len(sys.argv) > 1 else 'dist'
port = int(sys.argv[2]) if len(sys.argv) > 2 else 9000


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, *args):
        pass   # quiet


def main():
    handler = partial(NoCacheHandler, directory=directory)
    httpd = ThreadingHTTPServer(('0.0.0.0', port), handler)   # thread-per-connection: no preconnect stall
    httpd.daemon_threads = True
    print('serving %s on http://0.0.0.0:%d  (threaded, no-cache)' % (directory, port))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()


if __name__ == '__main__':
    main()
