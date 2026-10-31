#!/bin/bash
# Bấm đúp file này trên macOS để chạy app và mở trình duyệt.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Chưa cài Node.js. Cài bằng: brew install node"; read -n 1 -s -r -p "Bấm phím bất kỳ để thoát"; exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Chưa cài FFmpeg. Cài bằng: brew install ffmpeg"; read -n 1 -s -r -p "Bấm phím bất kỳ để thoát"; exit 1
fi
(sleep 1.5 && open "http://localhost:3000") &
node server.js
