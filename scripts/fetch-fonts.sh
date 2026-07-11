#!/usr/bin/env bash
# Fetch the bundled OPEN-SOURCE fonts (OFL / Apache-2.0) from the fontsource CDN.
#   - Static per-weight TTFs  -> backend/fonts/<Stem>-<Variant>.ttf   (embedded into saved PDFs)
#   - Regular woff2           -> assets/fonts/<id>.woff2              (browser dropdown preview only)
# Proprietary fonts (Calibri, Cambria, Consolas, Tahoma, Trebuchet, Garamond, Baskerville, Palatino,
# Brush Script) are NEVER fetched — the UI keeps their familiar names but they map to these open faces.
# Re-runnable; skips weights a family doesn't publish (404). See backend/fonts/NOTICE.md for the map.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TTF_DIR="$ROOT/backend/fonts"
W2_DIR="$ROOT/assets/fonts"
CDN="https://cdn.jsdelivr.net/fontsource/fonts"
mkdir -p "$TTF_DIR" "$W2_DIR"

# fontsource-id : Stem  (Stem is the backend/fonts/ file prefix)
FAMILIES=(
  "carlito:Carlito" "caladea:Caladea" "eb-garamond:EBGaramond" "libre-baskerville:LibreBaskerville"
  "inter:Inter" "lato:Lato" "poppins:Poppins" "nunito:Nunito" "source-sans-3:SourceSans3"
  "ubuntu:Ubuntu" "pt-sans:PTSans" "merriweather:Merriweather" "noto-serif:NotoSerif"
  "playfair-display:PlayfairDisplay" "fira-code:FiraCode" "jetbrains-mono:JetBrainsMono"
  "source-code-pro:SourceCodePro" "ibm-plex-mono:IBMPlexMono" "pacifico:Pacifico"
)
# fontsource weight-style  ->  variant suffix
VARIANTS=( "400-normal:Regular" "700-normal:Bold" "400-italic:Italic" "700-italic:BoldItalic" )

dl() { curl -fsSL --max-time 30 -o "$2" "$1" 2>/dev/null; }

echo "== backend TTFs =="
for fam in "${FAMILIES[@]}"; do
  id="${fam%%:*}"; stem="${fam##*:}"
  for v in "${VARIANTS[@]}"; do
    ws="${v%%:*}"; suf="${v##*:}"
    out="$TTF_DIR/$stem-$suf.ttf"
    if dl "$CDN/$id@latest/latin-$ws.ttf" "$out"; then echo "  $stem-$suf.ttf"; else rm -f "$out"; fi
  done
done

# Regular woff2 for the in-browser dropdown preview. Includes the substitutes already bundled as TTF
# (Arimo/Tinos/Cousine/Gelasio/ComicNeue/Roboto/OpenSans/Montserrat) so every dropdown row can render
# in its own face. fontsource ids differ from our stems for a few of these.
echo "== preview woff2 =="
PREVIEW=(
  "carlito" "caladea" "eb-garamond" "libre-baskerville" "inter" "lato" "poppins" "nunito"
  "source-sans-3" "ubuntu" "pt-sans" "merriweather" "noto-serif" "playfair-display" "fira-code"
  "jetbrains-mono" "source-code-pro" "ibm-plex-mono" "pacifico"
  "arimo" "tinos" "cousine" "gelasio" "comic-neue" "roboto" "open-sans" "montserrat"
)
for id in "${PREVIEW[@]}"; do
  out="$W2_DIR/$id.woff2"
  if dl "$CDN/$id@latest/latin-400-normal.woff2" "$out"; then echo "  $id.woff2"; else rm -f "$out"; echo "  !! $id MISSING"; fi
done

# Bold / italic / bold-italic woff2 for editor DISPLAY of substitutes that have NO system font on
# macOS/Linux (Calibri->carlito, Cambria->caladea): without a real bold face a *-Bold heading previewed as
# LIGHT synthetic bold while the save stayed bold. Registered in fonts.css; guarded by the headingbold
# test. Named <id>-bold / -italic / -bolditalic.woff2. (Arial/Times/Georgia have system faces — not needed.)
echo "== editor bold/italic woff2 =="
for id in carlito caladea; do
  for wv in "700-normal:bold" "400-italic:italic" "700-italic:bolditalic"; do
    ws="${wv%%:*}"; sfx="${wv##*:}"
    out="$W2_DIR/$id-$sfx.woff2"
    if dl "$CDN/$id@latest/latin-$ws.woff2" "$out"; then echo "  $id-$sfx.woff2"; else rm -f "$out"; echo "  !! $id-$sfx MISSING"; fi
  done
done
echo "done"
