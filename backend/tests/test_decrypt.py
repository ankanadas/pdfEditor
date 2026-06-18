"""Tests for the /decrypt endpoint that the client-side Merge feature uses to unlock
encrypted-but-openable PDFs (pdf-lib can't decrypt on its own)."""
import base64
import os
import sys
import unittest

import fitz

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # backend/
import app as appmod  # noqa: E402


def _encrypted(text, user_pw, enc=fitz.PDF_ENCRYPT_AES_256):
    d = fitz.open()
    d.new_page().insert_text((72, 100), text, fontsize=20)
    out = d.tobytes(encryption=enc, owner_pw="owner", user_pw=user_pw,
                    permissions=int(fitz.PDF_PERM_PRINT))
    d.close()
    return out


def _plain(text):
    d = fitz.open()
    d.new_page().insert_text((72, 100), text, fontsize=20)
    out = d.tobytes()
    d.close()
    return out


class DecryptTests(unittest.TestCase):
    def setUp(self):
        self.client = appmod.app.test_client()

    def _post(self, raw):
        return self.client.post('/decrypt', json={'pdfBase64': base64.b64encode(raw).decode()})

    def test_empty_password_pdf_is_decrypted_with_content_intact(self):
        r = self._post(_encrypted("UNLOCK ME", ""))
        self.assertEqual(r.status_code, 200)
        j = r.get_json()
        self.assertTrue(j.get('success'))
        out = base64.b64decode(j['pdfBase64'])
        d = fitz.open(stream=out, filetype='pdf')
        try:
            self.assertFalse(d.is_encrypted)              # truly unlocked
            self.assertIn("UNLOCK ME", d[0].get_text())   # content preserved, not garbled
        finally:
            d.close()

    def test_real_password_pdf_reports_needs_password(self):
        r = self._post(_encrypted("SECRET", "secret"))
        j = r.get_json()
        self.assertFalse(j.get('success'))
        self.assertTrue(j.get('needsPassword'))

    def test_plain_pdf_passes_through(self):
        r = self._post(_plain("HELLO"))
        self.assertTrue(r.get_json().get('success'))

    def test_missing_field_is_400(self):
        self.assertEqual(self.client.post('/decrypt', json={}).status_code, 400)


if __name__ == "__main__":
    unittest.main()
