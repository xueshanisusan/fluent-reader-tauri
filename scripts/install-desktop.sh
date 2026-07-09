#!/usr/bin/env bash
set -euo pipefail

APP_NAME="fluent-reader-tauri-spike"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE_DIR="$PROJECT_DIR/src-tauri/target/release/bundle"
RELEASE_DIR="$PROJECT_DIR/src-tauri/target/release"

APPIMAGE_PATH=""
for f in "$BUNDLE_DIR/appimage"/*.AppImage; do
    if [ -f "$f" ]; then
        APPIMAGE_PATH="$f"
        break
    fi
done

BINARY_PATH="$RELEASE_DIR/$APP_NAME"

if [ -n "$APPIMAGE_PATH" ]; then
    SRC="$APPIMAGE_PATH"
elif [ -x "$BINARY_PATH" ]; then
    SRC="$BINARY_PATH"
else
    echo "No binary or AppImage found. Run 'pnpm tauri:build' first."
    exit 1
fi

BIN_DIR="$HOME/.local/bin"
APPS_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"

mkdir -p "$BIN_DIR" "$APPS_DIR" "$ICON_DIR"

cp "$SRC" "$BIN_DIR/$APP_NAME"
chmod +x "$BIN_DIR/$APP_NAME"

ICON_SRC="$PROJECT_DIR/src-tauri/icons/icon.png"
if [ -f "$ICON_SRC" ]; then
    cp "$ICON_SRC" "$ICON_DIR/$APP_NAME.png"
fi

cat > "$APPS_DIR/$APP_NAME.desktop" << EOF
[Desktop Entry]
Name=Fluent Reader
Exec=$BIN_DIR/$APP_NAME
Icon=$APP_NAME
Type=Application
Categories=Network;News;
EOF

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" || true

echo "Installed: $BIN_DIR/$APP_NAME"
echo "Desktop:   $APPS_DIR/$APP_NAME.desktop"
echo "You can now launch it from dmenu/rofi."
