# Bundled fonts

The edit backend embeds one of these TTFs whenever the floating toolbar's font picker is used,
so the chosen font renders in the saved PDF on any host (incl. Linux/Render). **Every bundled
file is open-licensed (SIL Open Font License 1.1 or Apache-2.0) and redistributable.** The
dropdown keeps the familiar names, but the PDF only ever embeds the open font below — the
proprietary originals (Arial, Helvetica, Times New Roman, Georgia, Verdana, Courier New,
Comic Sans MS, Calibri, Cambria, Consolas, Tahoma, Trebuchet MS, Garamond, Baskerville,
Palatino, Brush Script) are **never** bundled or embedded.

| Dropdown label    | Embedded open font  | License    | Notes |
|-------------------|---------------------|------------|-------|
| Arial             | Arimo               | Apache-2.0 | metric-compatible with Arial |
| Helvetica         | Arimo               | Apache-2.0 | metric-compatible with Arial/Helvetica |
| Verdana           | Arimo               | Apache-2.0 | nearest open sans |
| Tahoma            | Arimo               | Apache-2.0 | nearest open sans |
| Trebuchet MS      | Arimo               | Apache-2.0 | nearest open sans |
| Times New Roman   | Tinos               | Apache-2.0 | metric-compatible with Times New Roman |
| Courier New       | Cousine             | Apache-2.0 | metric-compatible with Courier New |
| Consolas          | Cousine             | Apache-2.0 | open Liberation-Mono-equivalent mono |
| Georgia           | Gelasio             | OFL-1.1    | metric-compatible with Georgia |
| Comic Sans MS     | Comic Neue          | OFL-1.1    | open Comic-Sans-style face |
| Calibri           | Carlito             | Apache-2.0 | metric-compatible with Calibri |
| Cambria           | Caladea             | Apache-2.0 | metric-compatible with Cambria |
| Garamond          | EB Garamond         | OFL-1.1    | open Garamond-style serif |
| Baskerville       | Libre Baskerville   | OFL-1.1    | open Baskerville-style serif |
| Palatino          | Noto Serif          | OFL-1.1    | nearest open serif |
| Brush Script      | Pacifico            | OFL-1.1    | open brush-script face |
| Roboto            | Roboto              | Apache-2.0 | |
| Open Sans         | Open Sans           | OFL-1.1    | |
| Montserrat        | Montserrat          | OFL-1.1    | |
| Inter             | Inter               | OFL-1.1    | |
| Lato              | Lato                | OFL-1.1    | |
| Poppins           | Poppins             | OFL-1.1    | |
| Nunito            | Nunito              | OFL-1.1    | |
| Source Sans Pro   | Source Sans 3       | OFL-1.1    | renamed upstream of Source Sans Pro |
| Ubuntu            | Ubuntu              | UFL-1.0    | Ubuntu Font Licence (open/redistributable) |
| PT Sans           | PT Sans             | OFL-1.1    | |
| Merriweather      | Merriweather        | OFL-1.1    | |
| Libre Baskerville | Libre Baskerville   | OFL-1.1    | |
| Playfair Display  | Playfair Display    | OFL-1.1    | |
| Noto Serif        | Noto Serif          | OFL-1.1    | |
| Fira Code         | Fira Code           | OFL-1.1    | no italic upstream (uses Regular) |
| JetBrains Mono    | JetBrains Mono      | OFL-1.1    | |
| Source Code Pro   | Source Code Pro     | OFL-1.1    | |
| IBM Plex Mono     | IBM Plex Mono       | OFL-1.1    | |
| Pacifico          | Pacifico            | OFL-1.1    | Regular weight only |
| Comic Neue        | Comic Neue          | OFL-1.1    | |

### LaTeX / TeX fallback faces (`.otf`)

Used only to redraw edited *existing* text from LaTeX-generated PDFs, whose embedded subset fonts
(Computer Modern / Latin Modern / TeX Gyre) can't be safely re-embedded — so the edit blends in
instead of dropping to Arial/Times. All are GUST e-foundry releases under the **GUST Font License
(GFL)**, a free, LPPL-based, OFL-compatible licence permitting unrestricted use and redistribution.

| Family            | Files (stem)        | Licence    | Open look-alike for |
|-------------------|---------------------|------------|---------------------|
| Latin Modern Roman| LMRoman             | GFL (GUST) | Computer Modern Roman (CMR/CMBX/CMTI) |
| Latin Modern Sans | LMSans              | GFL (GUST) | Computer Modern Sans (CMSS) |
| Latin Modern Mono | LMMono              | GFL (GUST) | Computer Modern Typewriter (CMTT) |
| TeX Gyre Termes   | TeXGyreTermes       | GFL (GUST) | Times-like LaTeX text |
| TeX Gyre Heros    | TeXGyreHeros        | GFL (GUST) | Helvetica-like LaTeX text |
| TeX Gyre Cursor   | TeXGyreCursor       | GFL (GUST) | Courier-like LaTeX text |

Fetched from CTAN (`mirrors.ctan.org/fonts/lm`, `.../fonts/tex-gyre`). These carry GUST's own
internal names ("Latin Modern Roman", "TeX Gyre Termes", …) — never the proprietary originals — and
no embedded font is ever extracted from a user's PDF into reusable app assets.

Most families ship Regular / Bold / Italic / Bold-Italic; a few publish fewer weights upstream
(Fira Code has no italic, Pacifico is Regular-only) and reuse their own Regular for the missing
weights rather than a foreign substitute.

Sources: all files are fetched from the **fontsource** mirror of the official upstreams
(`cdn.jsdelivr.net/fontsource`) by `scripts/fetch-fonts.sh`, which also writes the Regular `.woff2`
the in-browser dropdown preview uses (`assets/fonts/`). Carlito & Caladea are Google's Chrome OS
fonts (metric-compatible with Calibri/Cambria); Cousine is Google's open equivalent of Liberation
Mono (used for both Courier New and Consolas).

If a bundled file is ever missing, the backend falls back to the metric-compatible Base-14 builtin
(Helvetica / Times / Courier) — referenced by name, never embedded, so still non-proprietary.
