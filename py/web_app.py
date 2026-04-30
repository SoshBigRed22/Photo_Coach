from __future__ import annotations

import base64
import json
import os
import re
import secrets
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode, urlsplit

import cv2
import numpy as np
try:
    import requests
except ModuleNotFoundError:  # pragma: no cover
    requests = None
from flask import Flask, jsonify, redirect, render_template, request

# ---------------------------------------------------------------------------
# rembg (U²-Net) — optional; GrabCut is used as fallback if unavailable
# ---------------------------------------------------------------------------
_rembg_remove = None
_rembg_new_session = None
try:
    from rembg import remove as _rembg_remove, new_session as _rembg_new_session  # type: ignore[import-untyped]
    _REMBG_AVAILABLE = True
except ImportError:
    _REMBG_AVAILABLE = False

_rembg_session = None
_rembg_session_lock = None

def _get_rembg_session():
    """Lazy-load the rembg session on first use to avoid startup OOM on Render free tier."""
    global _rembg_session, _rembg_session_lock
    if not _REMBG_AVAILABLE:
        return None
    if _rembg_session is not None:
        return _rembg_session
    try:
        # u2netp is the lightweight model (~4MB vs ~176MB for u2net), fits in 512MB RAM
        _rembg_session = _rembg_new_session("u2netp")  # type: ignore[misc]
        print("[INFO] rembg u2netp model ready")
    except Exception as exc:
        print(f"[WARN] rembg session init failed: {exc}")
    return _rembg_session

def _preload_rembg_model():
    """Download/cache the u2netp model in a background thread at startup."""
    if not _REMBG_AVAILABLE:
        return
    try:
        _get_rembg_session()
    except Exception as exc:
        print(f"[WARN] rembg model preload failed: {exc}")

import threading as _threading
_threading.Thread(target=_preload_rembg_model, daemon=True).start()

from analyzer import analyze_image
from suggestions import build_suggestions, calculate_metric_scores, calculate_quality_score

BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent

app = Flask(
    __name__,
    template_folder=str(PROJECT_ROOT),
    static_folder=str(PROJECT_ROOT),
    static_url_path="",
)

# Allow the GitHub Pages frontend to call the /api endpoints.
# In production the CORS_ORIGIN env var should be set to your GitHub Pages URL,
# e.g. https://yourusername.github.io  — leave unset for local dev (allows all).
_raw_cors_origin = os.environ.get("CORS_ORIGIN", "*").strip()


def _normalize_origin(value: str) -> str:
    """Convert URL-like strings to scheme://host[:port] origin format."""
    clean = value.strip().rstrip("/")
    if not clean or clean == "*":
        return clean

    parsed = urlsplit(clean)
    if parsed.scheme and parsed.netloc:
        return f"{parsed.scheme}://{parsed.netloc}"
    return clean


if _raw_cors_origin == "*":
    _allowed_origins: str | set[str] = "*"
else:
    _allowed_origins = {
        _normalize_origin(item)
        for item in _raw_cors_origin.split(",")
        if item.strip()
    }


@app.before_request
def handle_cors_preflight():
    if request.method == "OPTIONS" and request.path.startswith("/api/"):
        return ("", 204)


@app.after_request
def add_cors_headers(response):
    if request.path.startswith("/api/"):
        request_origin = _normalize_origin(request.headers.get("Origin", ""))
        if _allowed_origins == "*":
            response.headers["Access-Control-Allow-Origin"] = request_origin or "*"
        elif request_origin in _allowed_origins:
            response.headers["Access-Control-Allow-Origin"] = request_origin
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Vary"] = "Origin"
    return response

CONFIG_PATH = PROJECT_ROOT / "js" / "config.json"

_face_cascade: cv2.CascadeClassifier | None = None
PINTEREST_AUTHORIZE_URL = "https://www.pinterest.com/oauth/"
PINTEREST_TOKEN_URL = "https://api.pinterest.com/v5/oauth/token"
PINTEREST_API_BASE = "https://api.pinterest.com/v5"
PINTEREST_SCOPES = ("boards:read", "pins:read", "user_accounts:read")
PINTEREST_REQUEST_TIMEOUT = 20
PINTEREST_STATE_TTL_SECONDS = 900

_pinterest_pending_states: dict[str, dict[str, Any]] = {}
_pinterest_auth_handles: dict[str, dict[str, Any]] = {}


def get_face_cascade() -> cv2.CascadeClassifier:
    global _face_cascade
    if _face_cascade is not None:
        return _face_cascade

    cv2_data = getattr(cv2, "data", None)
    if cv2_data is not None and hasattr(cv2_data, "haarcascades"):
        cascade_path = Path(cv2_data.haarcascades) / "haarcascade_frontalface_default.xml"
    else:
        # Fallback for type checkers or builds where cv2.data is not exposed.
        cascade_path = Path(cv2.__file__).resolve().parent / "data" / "haarcascade_frontalface_default.xml"
    cascade = cv2.CascadeClassifier(str(cascade_path))
    if cascade.empty():
        raise RuntimeError(f"Failed to load face cascade at {cascade_path}")
    _face_cascade = cascade
    return cascade


def detect_primary_face_box(frame) -> tuple[dict | None, int, int]:
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    frame_height, frame_width = gray.shape
    cascade = get_face_cascade()

    # Resize before detection to reduce CPU/time, then map box back to full frame.
    scale = 1.0
    detect_gray = gray
    max_detect_width = 520
    if frame_width > max_detect_width:
        scale = max_detect_width / float(frame_width)
        detect_gray = cv2.resize(
            gray,
            (max_detect_width, int(round(frame_height * scale))),
            interpolation=cv2.INTER_AREA,
        )

    detect_gray = cv2.equalizeHist(detect_gray)
    faces = cascade.detectMultiScale(
        detect_gray,
        scaleFactor=1.08,
        minNeighbors=6,
        minSize=(38, 38),
    )

    # If the fast pass misses, retry once on full-resolution frame.
    if len(faces) == 0 and scale != 1.0:
        faces = cascade.detectMultiScale(
            gray,
            scaleFactor=1.1,
            minNeighbors=5,
            minSize=(48, 48),
        )
        scale = 1.0

    if len(faces) == 0:
        return None, frame_width, frame_height

    x, y, w, h = max(faces, key=lambda box: box[2] * box[3])
    if scale != 1.0:
        x = int(round(x / scale))
        y = int(round(y / scale))
        w = int(round(w / scale))
        h = int(round(h / scale))

    return {
        "x": int(x),
        "y": int(y),
        "width": int(w),
        "height": int(h),
    }, frame_width, frame_height


def load_thresholds() -> dict:
    with CONFIG_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def get_pinterest_settings() -> dict[str, str]:
    return {
        "app_id": os.environ.get("PINTEREST_APP_ID", "").strip(),
        "app_secret": os.environ.get("PINTEREST_APP_SECRET", "").strip(),
        "redirect_uri": os.environ.get("PINTEREST_REDIRECT_URI", "").strip(),
    }


def pinterest_is_enabled() -> bool:
    settings = get_pinterest_settings()
    return bool(requests and settings["app_id"] and settings["app_secret"] and settings["redirect_uri"])


def ensure_pinterest_requests_available() -> None:
    if requests is None:
        raise RuntimeError("Pinterest integration is unavailable because the server dependency 'requests' is not installed.")


def prune_pinterest_state() -> None:
    cutoff = time.time() - PINTEREST_STATE_TTL_SECONDS
    expired = [key for key, value in _pinterest_pending_states.items() if value.get("created_at", 0) < cutoff]
    for key in expired:
        _pinterest_pending_states.pop(key, None)


def pinterest_basic_auth_header(app_id: str, app_secret: str) -> str:
    token = base64.b64encode(f"{app_id}:{app_secret}".encode("utf-8")).decode("ascii")
    return f"Basic {token}"


def exchange_pinterest_code_for_token(code: str) -> dict[str, Any]:
    ensure_pinterest_requests_available()
    http = requests
    assert http is not None
    settings = get_pinterest_settings()
    response = http.post(
        PINTEREST_TOKEN_URL,
        headers={
            "Authorization": pinterest_basic_auth_header(settings["app_id"], settings["app_secret"]),
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": settings["redirect_uri"],
        },
        timeout=PINTEREST_REQUEST_TIMEOUT,
    )
    payload = response.json()
    if not response.ok:
        raise RuntimeError(payload.get("message") or payload.get("error") or "Pinterest token exchange failed.")
    return payload


def refresh_pinterest_access_token(refresh_token: str) -> dict[str, Any]:
    ensure_pinterest_requests_available()
    http = requests
    assert http is not None
    settings = get_pinterest_settings()
    response = http.post(
        PINTEREST_TOKEN_URL,
        headers={
            "Authorization": pinterest_basic_auth_header(settings["app_id"], settings["app_secret"]),
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data={
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "scope": ",".join(PINTEREST_SCOPES),
        },
        timeout=PINTEREST_REQUEST_TIMEOUT,
    )
    payload = response.json()
    if not response.ok:
        raise RuntimeError(payload.get("message") or payload.get("error") or "Pinterest token refresh failed.")
    return payload


def ensure_valid_pinterest_auth(auth_handle: str) -> dict[str, Any]:
    record = _pinterest_auth_handles.get(auth_handle)
    if record is None:
        raise KeyError("Unknown Pinterest auth handle.")

    now = time.time()
    expires_at = float(record.get("expires_at", 0))
    if expires_at and expires_at - now > 300:
        return record

    refresh_token = record.get("refresh_token")
    if not refresh_token:
        return record

    refreshed = refresh_pinterest_access_token(refresh_token)
    record["access_token"] = refreshed["access_token"]
    record["refresh_token"] = refreshed.get("refresh_token", refresh_token)
    record["scope"] = refreshed.get("scope", record.get("scope", ""))
    record["expires_at"] = time.time() + int(refreshed.get("expires_in", 0))
    record["refresh_token_expires_in"] = refreshed.get("refresh_token_expires_in")
    return record


def pinterest_api_get(auth_handle: str, path: str, *, params: dict[str, Any] | None = None) -> dict[str, Any]:
    ensure_pinterest_requests_available()
    http = requests
    assert http is not None
    record = ensure_valid_pinterest_auth(auth_handle)
    response = http.get(
        f"{PINTEREST_API_BASE}{path}",
        headers={
            "Authorization": f"Bearer {record['access_token']}",
            "Content-Type": "application/json",
        },
        params=params or {},
        timeout=PINTEREST_REQUEST_TIMEOUT,
    )

    if response.status_code == 401 and record.get("refresh_token"):
        record = ensure_valid_pinterest_auth(auth_handle)
        response = http.get(
            f"{PINTEREST_API_BASE}{path}",
            headers={
                "Authorization": f"Bearer {record['access_token']}",
                "Content-Type": "application/json",
            },
            params=params or {},
            timeout=PINTEREST_REQUEST_TIMEOUT,
        )

    payload = response.json()
    if not response.ok:
        raise RuntimeError(payload.get("message") or payload.get("error") or "Pinterest API request failed.")
    return payload


def get_pinterest_user_profile(auth_handle: str) -> dict[str, Any]:
    payload = pinterest_api_get(auth_handle, "/user_account")
    return {
        "username": payload.get("username") or payload.get("account_type") or "Pinterest user",
        "account_type": payload.get("account_type", "user"),
        "profile_image": payload.get("profile_image"),
    }


def build_pinterest_callback_page(frontend_origin: str, payload: dict[str, Any]) -> str:
    encoded_origin = json.dumps(frontend_origin)
    encoded_payload = json.dumps(payload)
    return f"""<!doctype html>
<html lang=\"en\">
<head>
  <meta charset=\"utf-8\">
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
  <title>Pinterest Connection</title>
  <style>
    body {{ font-family: Arial, sans-serif; padding: 24px; color: #1a1b1d; background: #f8f4eb; }}
    .card {{ max-width: 520px; margin: 0 auto; background: white; border-radius: 16px; padding: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.08); }}
  </style>
</head>
<body>
  <div class=\"card\">
    <h1>Pinterest Connection</h1>
    <p id=\"message\">Finalizing your Pinterest connection...</p>
  </div>
  <script>
    const targetOrigin = {encoded_origin};
    const payload = {encoded_payload};
    const message = document.getElementById('message');
    if (window.opener && targetOrigin) {{
      window.opener.postMessage(payload, targetOrigin);
      message.textContent = payload.success
        ? 'Pinterest connected. This window will close automatically.'
        : (payload.error || 'Pinterest connection failed. You can close this window.');
      setTimeout(() => window.close(), 900);
    }} else {{
      message.textContent = payload.success
        ? 'Pinterest connected. Return to the app.'
        : (payload.error || 'Pinterest connection failed. Return to the app.');
    }}
  </script>
</body>
</html>"""


def build_analysis_payload(image_path: Path) -> dict:
    thresholds = load_thresholds()
    result = analyze_image(image_path)
    tips = build_suggestions(result, thresholds)
    score = calculate_quality_score(result, thresholds)
    metric_scores = calculate_metric_scores(result, thresholds)

    return {
        "score": round(float(score), 2),
        "metrics": metric_scores,
        "tips": tips,
    }


def capture_directshow_frame(camera_index: int) -> tuple[bool, str, Any]:
    cap = cv2.VideoCapture(camera_index, cv2.CAP_DSHOW)
    if not cap.isOpened():
        return False, f"System camera index {camera_index} could not be opened via DirectShow.", None

    for _ in range(8):
        cap.read()

    ok, frame = cap.read()
    cap.release()

    if not ok or frame is None:
        return False, f"System camera capture failed at index {camera_index}.", None

    return True, "ok", frame


def capture_frame_with_backend(camera_index: int, backend: int):
    cap = cv2.VideoCapture(camera_index, backend)
    if not cap.isOpened():
        return False, "open_failed", None

    for _ in range(10):
        cap.read()

    ok, frame = cap.read()
    cap.release()
    if not ok or frame is None:
        return False, "read_failed", None
    return True, "ok", frame


def frame_probe(frame) -> dict:
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    return {
        "mean": round(float(gray.mean()), 2),
        "variance": round(float(gray.var()), 2),
    }


def remove_background_to_data_url(img, raw_bytes: bytes | None = None) -> str:
    """Extract foreground with alpha and return a data:image/png;base64 URL.

    Tries rembg (U²-Net neural matting) first when raw_bytes are available,
    then falls back to the OpenCV GrabCut approach.
    """
    global _rembg_session

    # ── rembg path ────────────────────────────────────────────────────────
    if _REMBG_AVAILABLE and raw_bytes is not None:
        try:
            sess = _get_rembg_session()
            result = _rembg_remove(raw_bytes, session=sess)  # type: ignore[misc]
            b64 = base64.b64encode(result).decode("utf-8")
            print("[INFO] Background removed via rembg U\u00b2-Net")
            return f"data:image/png;base64,{b64}"
        except Exception as exc:
            print(f"[WARN] rembg failed, falling back to GrabCut: {exc}")

    # ── GrabCut fallback ──────────────────────────────────────────────────
    try:
        h, w = img.shape[:2]
        max_dim = 600
        if max(h, w) > max_dim:
            scale_factor = max_dim / max(h, w)
            img = cv2.resize(
                img,
                (int(w * scale_factor), int(h * scale_factor)),
                interpolation=cv2.INTER_AREA,
            )
            h, w = img.shape[:2]

        mask = np.zeros((h, w), np.uint8)
        bgd_model = np.zeros((1, 65), np.float64)
        fgd_model = np.zeros((1, 65), np.float64)

        margin_x = max(1, int(w * 0.10))  # Use 10% margin for better detection
        margin_y = max(1, int(h * 0.10))
        rect_w = max(1, w - 2 * margin_x)
        rect_h = max(1, h - 2 * margin_y)
        rect = (margin_x, margin_y, rect_w, rect_h)

        # Try GrabCut with error handling
        grabcut_success = False
        try:
            cv2.grabCut(img, mask, rect, bgd_model, fgd_model, 5, cv2.GC_INIT_WITH_RECT)
            fg_mask = np.where((mask == 2) | (mask == 0), 0, 255).astype(np.uint8)
            grabcut_success = True
        except Exception as e:
            print(f"[WARN] GrabCut failed (using full mask fallback): {e}")
            fg_mask = np.full((h, w), 255, dtype=np.uint8)

        # Remove near-white backgrounds
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        _, light = cv2.threshold(gray, 245, 255, cv2.THRESH_BINARY)
        fg_mask = cv2.bitwise_and(fg_mask, cv2.bitwise_not(light))

        # Check for mask collapse and recover if needed
        keep_ratio = float(np.count_nonzero(fg_mask)) / float(max(1, fg_mask.size))
        if keep_ratio < 0.015:
            # Mask collapsed - add dark regions back
            _, dark_regions = cv2.threshold(gray, 235, 255, cv2.THRESH_BINARY_INV)
            fg_mask = cv2.max(fg_mask, dark_regions)
            keep_ratio = float(np.count_nonzero(fg_mask)) / float(max(1, fg_mask.size))
            if keep_ratio < 0.015:
                # Still collapsed - use full mask
                print(f"[WARN] Mask still collapsed ({keep_ratio:.4f}), using full mask")
                fg_mask = np.full((h, w), 255, dtype=np.uint8)

        # Smooth and finalize mask
        fg_mask = cv2.GaussianBlur(fg_mask, (3, 3), 0)
        _, fg_mask = cv2.threshold(fg_mask, 128, 255, cv2.THRESH_BINARY)

        # Create RGBA image
        img_rgba = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
        img_rgba[:, :, 3] = fg_mask

        # Encode to PNG
        ok, buf = cv2.imencode(".png", img_rgba)
        if not ok:
            raise RuntimeError("Failed to encode PNG - cv2.imencode failed")

        b64 = base64.b64encode(buf.tobytes()).decode("utf-8")
        return f"data:image/png;base64,{b64}"

    except Exception as e:
        raise RuntimeError(f"Background removal failed: {str(e)[:100]}")


def is_usable_probe(probe: dict) -> bool:
    # Heuristic: pure-black or near-static feeds are unusable for capture.
    return probe["mean"] > 8 and probe["variance"] > 25


@app.get("/")
def index() -> str:
    return render_template("index.html")


@app.get("/api/pinterest/config")
def pinterest_config():
    settings = get_pinterest_settings()
    return jsonify(
        {
            "enabled": pinterest_is_enabled(),
            "redirect_uri": settings["redirect_uri"],
            "scopes": list(PINTEREST_SCOPES),
            "requires_app_setup": not pinterest_is_enabled(),
        }
    )


@app.get("/api/pinterest/connect")
def pinterest_connect():
    if not pinterest_is_enabled():
        return "Pinterest API is not configured on the server yet.", 503

    prune_pinterest_state()
    frontend_origin = _normalize_origin(request.args.get("origin", ""))
    if not frontend_origin:
        return "Missing frontend origin.", 400

    settings = get_pinterest_settings()
    state = secrets.token_urlsafe(24)
    _pinterest_pending_states[state] = {
        "created_at": time.time(),
        "frontend_origin": frontend_origin,
    }

    auth_url = f"{PINTEREST_AUTHORIZE_URL}?{urlencode({'client_id': settings['app_id'], 'redirect_uri': settings['redirect_uri'], 'response_type': 'code', 'scope': ','.join(PINTEREST_SCOPES), 'state': state})}"
    return redirect(auth_url)


@app.get("/api/pinterest/callback")
def pinterest_callback():
    state = request.args.get("state", "")
    code = request.args.get("code", "")
    error = request.args.get("error", "")
    pending = _pinterest_pending_states.pop(state, None)
    frontend_origin = pending.get("frontend_origin", "") if pending else ""

    if not pending:
        return "Pinterest OAuth state expired or is invalid.", 400

    if error:
        return build_pinterest_callback_page(frontend_origin, {"type": "pinterest-auth-complete", "success": False, "error": error})

    if not code:
        return build_pinterest_callback_page(frontend_origin, {"type": "pinterest-auth-complete", "success": False, "error": "Missing authorization code."}), 400

    try:
        token_payload = exchange_pinterest_code_for_token(code)
        auth_handle = secrets.token_urlsafe(24)
        _pinterest_auth_handles[auth_handle] = {
            "access_token": token_payload["access_token"],
            "refresh_token": token_payload.get("refresh_token"),
            "scope": token_payload.get("scope", ""),
            "expires_at": time.time() + int(token_payload.get("expires_in", 0)),
            "created_at": time.time(),
        }
        profile = get_pinterest_user_profile(auth_handle)
        _pinterest_auth_handles[auth_handle]["profile"] = profile
        return build_pinterest_callback_page(
            frontend_origin,
            {
                "type": "pinterest-auth-complete",
                "success": True,
                "authHandle": auth_handle,
                "profile": profile,
            },
        )
    except Exception as exc:  # pragma: no cover
        return build_pinterest_callback_page(frontend_origin, {"type": "pinterest-auth-complete", "success": False, "error": str(exc)}), 500


@app.get("/api/pinterest/status")
def pinterest_status():
    auth_handle = request.args.get("auth_handle", "").strip()
    if not auth_handle or auth_handle not in _pinterest_auth_handles:
        return jsonify({"connected": False})

    record = ensure_valid_pinterest_auth(auth_handle)
    profile = record.get("profile") or get_pinterest_user_profile(auth_handle)
    record["profile"] = profile
    return jsonify(
        {
            "connected": True,
            "auth_handle": auth_handle,
            "profile": profile,
            "scope": record.get("scope", ""),
            "expires_at": record.get("expires_at"),
        }
    )


@app.post("/api/pinterest/disconnect")
def pinterest_disconnect():
    body = request.get_json(silent=True) or {}
    auth_handle = str(body.get("auth_handle", "")).strip()
    if auth_handle:
        _pinterest_auth_handles.pop(auth_handle, None)
    return jsonify({"ok": True})


@app.get("/api/pinterest/boards")
def pinterest_boards():
    auth_handle = request.args.get("auth_handle", "").strip()
    if not auth_handle:
        return jsonify({"error": "Missing auth_handle."}), 400

    bookmark = request.args.get("bookmark", "").strip() or None
    page_size = max(1, min(int(request.args.get("page_size", 25)), 50))

    try:
        payload = pinterest_api_get(auth_handle, "/boards", params={"bookmark": bookmark, "page_size": page_size})
        items = []
        for item in payload.get("items", []):
            items.append(
                {
                    "id": item.get("id"),
                    "name": item.get("name") or "Untitled board",
                    "description": item.get("description") or "",
                    "privacy": item.get("privacy", "PUBLIC"),
                }
            )
        return jsonify({"items": items, "bookmark": payload.get("bookmark")})
    except KeyError:
        return jsonify({"error": "Pinterest session not found. Reconnect your account."}), 404
    except Exception as exc:  # pragma: no cover
        return jsonify({"error": str(exc)}), 500


@app.get("/api/pinterest/pins")
def pinterest_pins():
    auth_handle = request.args.get("auth_handle", "").strip()
    if not auth_handle:
        return jsonify({"error": "Missing auth_handle."}), 400

    board_id = request.args.get("board_id", "").strip()
    bookmark = request.args.get("bookmark", "").strip() or None
    page_size = max(1, min(int(request.args.get("page_size", 25)), 50))

    try:
        path = "/pins"
        if board_id:
            path = f"/boards/{quote(board_id, safe='')}/pins"
        payload = pinterest_api_get(auth_handle, path, params={"bookmark": bookmark, "page_size": page_size})
        items = []
        for item in payload.get("items", []):
            pin_id = item.get("id")
            items.append(
                {
                    "id": pin_id,
                    "title": item.get("title") or item.get("description") or "Untitled pin",
                    "description": item.get("description") or "",
                    "pinterest_url": item.get("url") or (f"https://www.pinterest.com/pin/{pin_id}" if pin_id else ""),
                    "link": item.get("link") or "",
                    "board_id": item.get("board_id") or board_id,
                }
            )
        return jsonify({"items": items, "bookmark": payload.get("bookmark")})
    except KeyError:
        return jsonify({"error": "Pinterest session not found. Reconnect your account."}), 404
    except Exception as exc:  # pragma: no cover
        return jsonify({"error": str(exc)}), 500


@app.post("/api/analyze")
def analyze_upload():
    tmp_path: Path | None = None
    if "photo" not in request.files:
        return jsonify({"error": "Missing file field 'photo'."}), 400

    uploaded = request.files["photo"]
    if not uploaded.filename:
        return jsonify({"error": "No file selected."}), 400

    suffix = Path(uploaded.filename).suffix or ".jpg"

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp_path = Path(tmp.name)
            uploaded.save(tmp_path)

        return jsonify(build_analysis_payload(tmp_path))
    except Exception as exc:  # pragma: no cover
        return jsonify({"error": str(exc)}), 500
    finally:
        if tmp_path is not None and tmp_path.exists():
            tmp_path.unlink(missing_ok=True)


@app.post("/api/track-face")
def track_face_box():
    """Detect a primary face in a frame and return its bounding box."""
    if "photo" not in request.files:
        return jsonify({"error": "Missing file field 'photo'."}), 400

    uploaded = request.files["photo"]
    if not uploaded.filename:
        return jsonify({"error": "No file selected."}), 400

    try:
        encoded = uploaded.read()
        if not encoded:
            return jsonify({"error": "Empty image payload."}), 400

        arr = np.frombuffer(encoded, dtype=np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if frame is None:
            return jsonify({"error": "Unable to decode image payload."}), 400

        box, frame_width, frame_height = detect_primary_face_box(frame)
        payload = {
            "face_detected": bool(box is not None),
            "frame_width": frame_width,
            "frame_height": frame_height,
            "face_box": box,
        }

        return jsonify(payload)
    except Exception as exc:  # pragma: no cover
        return jsonify({"error": str(exc)}), 500


@app.post("/api/capture-system")
def capture_from_system_camera():
    """Capture one frame using OpenCV DirectShow (Windows fallback path)."""
    tmp_path: Path | None = None
    try:
        body = request.get_json(silent=True) or {}
        camera_index = int(body.get("camera_index", 0))

        ok, message, frame = capture_directshow_frame(camera_index)
        if not ok:
            return jsonify({"error": message}), 500

        with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as tmp:
            tmp_path = Path(tmp.name)
            if not cv2.imwrite(str(tmp_path), frame):
                return jsonify({"error": "Failed to write captured frame."}), 500

        payload = build_analysis_payload(tmp_path)

        encoded_ok, encoded = cv2.imencode(".jpg", frame)
        if encoded_ok:
            payload["captured_image_base64"] = base64.b64encode(encoded.tobytes()).decode("ascii")

        payload["camera_index"] = camera_index

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        payload["frame_probe"] = {
            "mean": round(float(gray.mean()), 2),
            "variance": round(float(gray.var()), 2),
        }

        return jsonify(payload)
    except Exception as exc:  # pragma: no cover
        return jsonify({"error": str(exc)}), 500
    finally:
        if tmp_path is not None and tmp_path.exists():
            tmp_path.unlink(missing_ok=True)


@app.post("/api/system-preview")
def system_preview():
    """Capture one preview frame from a selected DirectShow camera index."""
    try:
        body = request.get_json(silent=True) or {}
        camera_index = int(body.get("camera_index", 0))

        ok, message, frame = capture_directshow_frame(camera_index)
        if not ok:
            return jsonify({"error": message}), 500

        encoded_ok, encoded = cv2.imencode(".jpg", frame)
        if not encoded_ok:
            return jsonify({"error": "Failed to encode preview frame."}), 500

        return jsonify(
            {
                "camera_index": camera_index,
                "preview_image_base64": base64.b64encode(encoded.tobytes()).decode("ascii"),
                "frame_probe": frame_probe(frame),
            }
        )
    except Exception as exc:  # pragma: no cover
        return jsonify({"error": str(exc)}), 500


@app.post("/api/system-autoprobe")
def system_autoprobe():
    """Probe multiple camera indices/backends and return candidates with frame stats."""
    body = request.get_json(silent=True) or {}
    max_index = int(body.get("max_index", 10))
    max_index = max(0, min(max_index, 20))

    backends = [
        ("DSHOW", cv2.CAP_DSHOW),
        ("MSMF", cv2.CAP_MSMF),
    ]

    candidates = []
    best = None

    for backend_name, backend in backends:
        for idx in range(max_index + 1):
            ok, status, frame = capture_frame_with_backend(idx, backend)
            if not ok:
                candidates.append(
                    {
                        "backend": backend_name,
                        "camera_index": idx,
                        "status": status,
                    }
                )
                continue

            probe = frame_probe(frame)
            usable = is_usable_probe(probe)
            candidate = {
                "backend": backend_name,
                "camera_index": idx,
                "status": "ok",
                "probe": probe,
                "usable": usable,
            }
            candidates.append(candidate)

            if usable:
                if best is None or probe["variance"] > best["probe"]["variance"]:
                    best = candidate

    return jsonify(
        {
            "best": best,
            "candidates": candidates,
        }
    )


@app.post("/api/capture-system-auto")
def capture_system_auto():
    """Auto-select the most usable camera feed and capture a frame."""
    body = request.get_json(silent=True) or {}
    max_index = int(body.get("max_index", 10))
    max_index = max(0, min(max_index, 20))

    best = None
    for backend_name, backend in [("DSHOW", cv2.CAP_DSHOW), ("MSMF", cv2.CAP_MSMF)]:
        for idx in range(max_index + 1):
            ok, _, frame = capture_frame_with_backend(idx, backend)
            if not ok:
                continue

            probe = frame_probe(frame)
            if not is_usable_probe(probe):
                continue

            if best is None or probe["variance"] > best["probe"]["variance"]:
                best = {
                    "backend": backend_name,
                    "camera_index": idx,
                    "probe": probe,
                    "frame": frame,
                }

    if best is None:
        return jsonify({"error": "No usable camera feed found. All detected frames appear black/blocked."}), 500

    frame = best.pop("frame")

    with tempfile.NamedTemporaryFile(delete=False, suffix=".jpg") as tmp:
        tmp_path = Path(tmp.name)
        if not cv2.imwrite(str(tmp_path), frame):
            return jsonify({"error": "Failed to write captured frame."}), 500

    try:
        payload = build_analysis_payload(tmp_path)
        encoded_ok, encoded = cv2.imencode(".jpg", frame)
        if encoded_ok:
            payload["captured_image_base64"] = base64.b64encode(encoded.tobytes()).decode("ascii")

        payload["auto_selected"] = best
        return jsonify(payload)
    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)


@app.post("/api/fetch-pin-image")
def fetch_pin_image():
    """Fetch a Pinterest pin image, remove background via GrabCut, return as base64 PNG."""
    data = request.get_json(silent=True) or {}
    pin_url = str(data.get("url", "")).strip()
    if not pin_url:
        return jsonify({"error": "Missing url"}), 400

    # Accept only Pinterest domains
    try:
        parsed = urlsplit(pin_url)
        hostname = parsed.hostname or ""
    except Exception:
        hostname = ""
    if "pinterest." not in hostname and "pinimg.com" not in hostname:
        return jsonify({"error": "URL must be from pinterest.com or pinimg.com"}), 400

    if requests is None:
        return jsonify({"error": "Server dependency 'requests' is not installed."}), 500

    hdrs = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
    }

    try:
        image_url = pin_url

        # If it's a Pinterest pin page, extract the image URL via og:image meta
        if "pinterest." in hostname:
            page_resp = requests.get(pin_url, headers=hdrs, timeout=12)
            page_resp.raise_for_status()
            patterns = [
                r'<meta[^>]+property=["\']og:image:secure_url["\'][^>]+content=["\']([^"\' ]+)["\']',
                r'<meta[^>]+content=["\']([^"\' ]+)["\'][^>]+property=["\']og:image',
                r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\' ]+)["\']',
                r'"image_url"\s*:\s*"(https://i\.pinimg\.com/[^"]+)"',
            ]
            found_url = None
            for pat in patterns:
                m = re.search(pat, page_resp.text)
                if m:
                    found_url = m.group(1)
                    break
            if not found_url:
                return jsonify({
                    "error": "Could not extract image from that pin page. Try pasting a direct image URL instead."
                }), 400
            image_url = found_url

        # Fetch the actual image bytes
        img_resp = requests.get(image_url, headers=hdrs, timeout=15)
        img_resp.raise_for_status()

        # Decode with OpenCV
        arr = np.frombuffer(img_resp.content, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            return jsonify({"error": "Could not decode image data."}), 400

        return jsonify({"image": remove_background_to_data_url(img, raw_bytes=img_resp.content), "sourceUrl": image_url})

    except requests.RequestException as exc:
        return jsonify({"error": f"Failed to fetch image: {exc}"}), 500
    except Exception as exc:  # pragma: no cover
        return jsonify({"error": f"Processing failed: {exc}"}), 500


@app.post("/api/process-overlay-upload")
def process_overlay_upload():
    """Process an uploaded piercing image into a transparent PNG overlay."""
    if "image" not in request.files:
        return jsonify({"error": "Missing file field 'image'."}), 400

    uploaded = request.files["image"]
    if not uploaded.filename:
        return jsonify({"error": "No file selected."}), 400

    try:
        encoded = uploaded.read()
        if not encoded:
            return jsonify({"error": "Empty image payload."}), 400

        arr = np.frombuffer(encoded, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            return jsonify({"error": "Could not decode uploaded image."}), 400

        return jsonify({"image": remove_background_to_data_url(img, raw_bytes=encoded), "source": "upload"})
    except Exception as exc:  # pragma: no cover
        return jsonify({"error": f"Upload processing failed: {exc}"}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=os.environ.get("PYTHON_ENV") != "production")
