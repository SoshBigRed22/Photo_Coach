from __future__ import annotations

import base64
import json
import os
import secrets
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode, urlsplit

import cv2
import numpy as np
import requests
from flask import Flask, jsonify, redirect, render_template, request

from analyzer import analyze_image
from suggestions import build_suggestions, calculate_quality_score

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
    return bool(settings["app_id"] and settings["app_secret"] and settings["redirect_uri"])


def prune_pinterest_state() -> None:
    cutoff = time.time() - PINTEREST_STATE_TTL_SECONDS
    expired = [key for key, value in _pinterest_pending_states.items() if value.get("created_at", 0) < cutoff]
    for key in expired:
        _pinterest_pending_states.pop(key, None)


def pinterest_basic_auth_header(app_id: str, app_secret: str) -> str:
    token = base64.b64encode(f"{app_id}:{app_secret}".encode("utf-8")).decode("ascii")
    return f"Basic {token}"


def exchange_pinterest_code_for_token(code: str) -> dict[str, Any]:
    settings = get_pinterest_settings()
    response = requests.post(
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
    settings = get_pinterest_settings()
    response = requests.post(
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
    record = ensure_valid_pinterest_auth(auth_handle)
    response = requests.get(
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
        response = requests.get(
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

    return {
        "score": score,
        "metrics": {
            "brightness": round(result.brightness, 2),
            "contrast": round(result.contrast, 2),
            "blur_score": round(result.blur_score, 2),
            "noise_score": round(result.noise_score, 2),
            "width": result.width,
            "height": result.height,
            "face_count": result.face_count,
            "face_area_ratio": round(result.primary_face_area_ratio, 4),
            "face_center_offset": round(result.primary_face_center_offset, 4),
            "face_sharpness": round(result.face_sharpness, 2),
        },
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


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=os.environ.get("PYTHON_ENV") != "production")
