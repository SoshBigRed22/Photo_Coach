from __future__ import annotations

from pathlib import Path

import cv2


def capture_photo(output_path: Path) -> Path:
    """Open webcam preview and save a photo when SPACE is pressed."""
    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        raise RuntimeError("Could not open camera. Check permissions and camera availability.")

    # Improve capture quality
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
    cap.set(cv2.CAP_PROP_FPS, 30)
    cap.set(cv2.CAP_PROP_AUTOFOCUS, 1)

    window_name = "Press SPACE to capture, ESC to cancel"
    cv2.namedWindow(window_name, cv2.WINDOW_NORMAL)

    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                raise RuntimeError("Could not read frame from camera.")

            # Flip camera horizontally (mirror preview)
            frame = cv2.flip(frame, 1)
            cv2.imshow(window_name, frame)
            key = cv2.waitKey(1) & 0xFF

            if key == 27:  # ESC
                raise RuntimeError("Capture canceled by user.")

            if key == 32:  # SPACE
                output_path.parent.mkdir(parents=True, exist_ok=True)
                if not cv2.imwrite(str(output_path), frame):
                    raise RuntimeError(f"Failed to save image to {output_path}")
                return output_path
    finally:
        cap.release()
        cv2.destroyAllWindows()
