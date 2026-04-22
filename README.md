# Quick Photo Improvement App (MVP)

This starter app captures a photo (or loads an existing one), analyzes quality, and suggests how to improve it.

## Features

- Webcam capture with SPACE key
- Basic quality analysis:
  - Brightness
  - Contrast
  - Blur estimate
  - Noise estimate
  - Resolution check
- Selfie checks:
  - Face detection count
  - Face framing size
  - Face centering
  - Face-region sharpness
- Quality score from 0 to 100
- Human-readable improvement suggestions
- Preview window with score, top tips, and primary face box overlay

## Setup

1. Create and activate a virtual environment (optional but recommended).
2. Install dependencies:

```bash
pip install -r requirements.txt
```

## Run

Capture from camera:

```bash
python py/main.py
```

Analyze an existing image:

```bash
python py/main.py --image path/to/photo.jpg
```

Use a custom config:

```bash
python py/main.py --config js/config.json
```

Run without opening the preview window:

```bash
python py/main.py --no-preview
```

## Browser App (Recommended for Demo)

This project now includes a browser UI served by Flask.

Start the web app:

```bash
python py/web_app.py
```

Open this URL in your browser:

```text
http://127.0.0.1:5000
```

Notes:

- You do not need VS Code Live Server for this app.
- The browser entry page is `index.html`, but it should be opened through Flask at the URL above.
- Camera capture in browser requires camera permission in your browser.

## Next Improvements

- Add aesthetic scoring model.
- Build a mobile frontend (Flutter/React Native) with this Python backend.
