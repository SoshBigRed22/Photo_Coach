from __future__ import annotations

import base64
import json
import os
import tempfile
from pathlib import Path
from typing import Any

import cv2
from flask import Flask, jsonify, render_template, request

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
_cors_origin = os.environ.get("CORS_ORIGIN", "*")


@app.before_request
def handle_cors_preflight():
    if request.method == "OPTIONS" and request.path.startswith("/api/"):
        return ("", 204)


@app.after_request
def add_cors_headers(response):
    if request.path.startswith("/api/"):
        response.headers["Access-Control-Allow-Origin"] = _cors_origin
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response

CONFIG_PATH = PROJECT_ROOT / "js" / "config.json"


def load_thresholds() -> dict:
    with CONFIG_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


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
