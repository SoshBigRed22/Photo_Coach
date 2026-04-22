"""
WSGI entry point for production deployment (Render, Railway, etc.).

This file lets gunicorn find the Flask app even though web_app.py
lives inside the py/ subfolder.

Start command used by Render:
    gunicorn wsgi:app
"""
from __future__ import annotations

import sys
from pathlib import Path

# Make the py/ folder importable so 'from web_app import app' works.
sys.path.insert(0, str(Path(__file__).resolve().parent / "py"))

from web_app import app  # noqa: E402  (import after sys.path change is intentional)

if __name__ == "__main__":
    app.run()
