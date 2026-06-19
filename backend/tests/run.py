"""Test runner that avoids a PyMuPDF interpreter-teardown segfault.

Some PyMuPDF builds crash while CPython tears down their C objects at exit. That happens
AFTER the tests have already passed, but it corrupts the process exit code and would abort
the build gate. We run the suite, flush output, then os._exit() with the real result so the
exit code reflects the tests, not the teardown.
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))  # backend/ on the path so `import app` works

if __name__ == "__main__":
    suite = unittest.TestLoader().discover(HERE, pattern="test_*.py")
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0 if result.wasSuccessful() else 1)
