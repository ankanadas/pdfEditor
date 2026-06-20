# Bundled fonts

The edit backend embeds one of these TTFs whenever the floating toolbar's font picker is used,
so the chosen font renders in the saved PDF on any host (incl. Linux/Render). **Every bundled
file is open-licensed (SIL Open Font License 1.1 or Apache-2.0) and redistributable.** The
dropdown keeps the familiar names, but the PDF only ever embeds the open metric-compatible font
below — the proprietary originals (Arial, Helvetica, Times New Roman, Georgia, Verdana, Courier
New, Comic Sans MS) are never bundled or embedded.

| Dropdown label   | Embedded open font | License    | Notes |
|------------------|--------------------|------------|-------|
| Arial            | Arimo              | Apache-2.0 | metric-compatible with Arial |
| Helvetica        | Arimo              | Apache-2.0 | metric-compatible with Arial/Helvetica |
| Verdana          | Arimo              | Apache-2.0 | nearest open sans |
| Times New Roman  | Tinos              | Apache-2.0 | metric-compatible with Times New Roman |
| Courier New      | Cousine            | Apache-2.0 | metric-compatible with Courier New |
| Georgia          | Gelasio            | OFL-1.1    | metric-compatible with Georgia |
| Comic Sans MS    | Comic Neue         | OFL-1.1    | open Comic-Sans-style face |
| Roboto           | Roboto             | Apache-2.0 | |
| Open Sans        | Open Sans          | OFL-1.1    | |
| Montserrat       | Montserrat         | OFL-1.1    | |

Each family ships Regular / Bold / Italic / Bold-Italic.

Sources (official Google Fonts upstreams):
- Arimo / Tinos / Cousine — github.com/googlefonts/{Arimo,Tinos,Cousine} (Apache-2.0)
- Gelasio — google/fonts `ofl/gelasio` variable font, Bold/Bold-Italic instanced at wght=700 (OFL-1.1)
- Comic Neue — google/fonts `ofl/comicneue` (OFL-1.1)
- Roboto / Open Sans / Montserrat — official Google Fonts repos (Apache-2.0 / OFL-1.1)

If a bundled file is ever missing, the backend falls back to the metric-compatible Base-14 builtin
(Helvetica / Times / Courier) — referenced by name, never embedded, so still non-proprietary.
