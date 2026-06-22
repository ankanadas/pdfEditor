"""CORS allow-list and rate-limiting guards.

These prove the API only hands CORS headers to our own frontend and that the heavy
endpoints actually start returning 429 under a burst. Rate limiting stays enabled for the
whole suite; the limiter exempts loopback (127.0.0.1), so the other tests — which use the
default test-client IP — are never throttled, while these tests use public test IPs
(198.51.100.0/24, TEST-NET-2) to exercise real throttling.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # backend/
import app as appmod  # noqa: E402

FRONTEND = "https://quickpdfeditor.com"
EVIL = "https://evil.example.com"


class CorsTests(unittest.TestCase):
    def setUp(self):
        self.client = appmod.app.test_client()

    def test_allows_our_frontend_origin(self):
        r = self.client.get("/health", headers={"Origin": FRONTEND})
        self.assertEqual(r.headers.get("Access-Control-Allow-Origin"), FRONTEND)

    def test_does_not_allow_other_origins(self):
        r = self.client.get("/health", headers={"Origin": EVIL})
        # flask-cors omits the header entirely for origins not on the allow-list.
        self.assertIsNone(r.headers.get("Access-Control-Allow-Origin"))

    def test_localhost_dev_origin_allowed(self):
        r = self.client.get("/health", headers={"Origin": "http://localhost:9000"})
        self.assertEqual(r.headers.get("Access-Control-Allow-Origin"), "http://localhost:9000")

    def test_preflight_options_is_accepted(self):
        r = self.client.open(
            "/edit-pdf",
            method="OPTIONS",
            headers={
                "Origin": FRONTEND,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Content-Type",
            },
        )
        self.assertIn(r.status_code, (200, 204))
        self.assertEqual(r.headers.get("Access-Control-Allow-Origin"), FRONTEND)


class RateLimitTests(unittest.TestCase):
    def setUp(self):
        self.client = appmod.app.test_client()

    def test_health_is_never_rate_limited(self):
        # /health is exempt; well past the default 60/min it must keep returning 200.
        ip = {"REMOTE_ADDR": "198.51.100.10"}
        codes = {self.client.get("/health", environ_overrides=ip).status_code for _ in range(65)}
        self.assertEqual(codes, {200})

    def test_edit_pdf_starts_returning_429_under_a_burst(self):
        # The heavy limit is 30/min; a burst from one IP must hit 429. Empty bodies still
        # count against the limit (the limiter runs before the view), so we never need a
        # real PDF here.
        ip = {"REMOTE_ADDR": "198.51.100.20"}
        statuses = []
        for _ in range(40):
            statuses.append(self.client.post("/edit-pdf", json={}, environ_overrides=ip).status_code)
            if statuses[-1] == 429:
                break
        self.assertNotEqual(statuses[0], 429, "the very first request must not be throttled")
        self.assertIn(429, statuses, f"expected a 429 within 40 requests, got {statuses}")

    def test_a_different_ip_is_counted_separately(self):
        # Exhaust one IP, then confirm a fresh IP can still get through (per-IP keying).
        spent = {"REMOTE_ADDR": "198.51.100.30"}
        for _ in range(40):
            if self.client.post("/edit-pdf", json={}, environ_overrides=spent).status_code == 429:
                break
        fresh = {"REMOTE_ADDR": "198.51.100.31"}
        first = self.client.post("/edit-pdf", json={}, environ_overrides=fresh).status_code
        self.assertNotEqual(first, 429)

    def test_limiter_is_enabled_and_storage_is_redis_ready(self):
        # The single worker (render.yaml) makes the default in-memory counting exact. The storage
        # backend is taken from RATELIMIT_STORAGE_URI, so pointing it at Redis when scaling beyond
        # one worker is a config change, not a code change.
        self.assertIs(appmod.app.config.get("RATELIMIT_ENABLED"), True)
        self.assertEqual(appmod.limiter._storage_uri,
                         os.environ.get("RATELIMIT_STORAGE_URI", "memory://"))


if __name__ == "__main__":
    unittest.main()
