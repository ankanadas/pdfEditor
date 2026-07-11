// Client-side font helpers — pure mapping (PDF.js font object -> style; font name -> catalogue
// key). Extracted verbatim from PDFEditorApp.

/**
 * The weight/slant PDF.js computed for a loaded font — the SAME source PDF.js uses to style its
 * own text layer (commonObjs holds the parsed font with .bold/.black/.italic). Read at EDIT time,
 * after the page has rendered, so the object is resolved. This recovers a bold/italic the font-NAME
 * heuristic misses for NON-EMBEDDED standard fonts (a "Helvetica-Bold" heading PDF.js draws via a
 * system font, not a loadedName web font). Returns null when the font object isn't available.
 */
export function fontStyleFromPdfjs(pv, fontName) {
  try {
    const objs = pv && pv.page && pv.page.commonObjs;
    if (!objs || !fontName || !objs.has(fontName)) return null;
    const f = objs.get(fontName);
    if (!f) return null;
    // For a NON-embedded standard font, PDF.js renders via a system-font @font-face it injects
    // during render (systemFontInfo.css -> src: local(Helvetica…)); reuse that exact family so the
    // edit box shows the real font, not the Arial fallback. Embedded fonts have no systemFontInfo.
    const css = (f.systemFontInfo && f.systemFontInfo.css) ? f.systemFontInfo.css : null;
    // PDF.js often leaves .bold/.italic UNSET on embedded fonts (a subset whose loadedName hides
    // the weight) but still exposes the real PostScript name, e.g. "ABCDEF+Calibri-Bold" — read the
    // weight/slant from that name too, so an embedded bold/italic face is recognised. Mirrors the
    // item-level name heuristic (incl. the LaTeX cmbx/cmti/cmsl hints).
    const nm = String(f.name || '').toLowerCase();
    // Treat MEDIUM / SEMIBOLD / DEMIBOLD as bold too: many forms (e.g. the I-94) set their labels in a
    // "-Medium" face (weight 500) against a Regular body — visually bold, but the name has no "Bold". A
    // binary bold model reads that as emphasis, so the label previews + saves bold like the user expects.
    const bold = !!(f.black || f.bold) || /bold|black|heavy|semi.?bold|demi.?bold|medium|cmbx/.test(nm);
    const italic = !!f.italic || /italic|oblique|cmti|cmsl/.test(nm);
    return { bold, italic, css };
  } catch (e) {
    return null;
  }
}

/** Best-guess catalogue key from a PDF font NAME, incl. the open SUBSTITUTE actually embedded
 *  (e.g. 'Carlito' -> calibri, 'Inter' -> inter) so a saved+reopened font shows its name again.
 *  Returns '' for a font the picker doesn't offer (e.g. Computer Modern) -> placeholder. */
export function familyKeyFromFont(name) {
  const n = (name || '').toLowerCase();
  if (!n) return '';
  // Ordered most-specific-first; matches both the real face and its embedded open substitute.
  const hits = [
    ['ibm plex mono', 'ibmplexmono'], ['ibmplex', 'ibmplexmono'], ['jetbrains', 'jetbrainsmono'],
    ['source code', 'sourcecodepro'], ['fira code', 'firacode'], ['firacode', 'firacode'],
    ['source sans', 'sourcesans'], ['sourcesans', 'sourcesans'],
    ['libre baskerville', 'librebaskerville'], ['librebaskerville', 'librebaskerville'], ['baskerville', 'baskerville'],
    ['playfair', 'playfair'], ['noto serif', 'notoserif'], ['notoserif', 'notoserif'],
    ['eb garamond', 'garamond'], ['ebgaramond', 'garamond'], ['garamond', 'garamond'],
    ['merriweather', 'merriweather'], ['pt sans', 'ptsans'], ['ptsans', 'ptsans'],
    ['poppins', 'poppins'], ['nunito', 'nunito'], ['ubuntu', 'ubuntu'], ['lato', 'lato'], ['inter', 'inter'],
    ['carlito', 'calibri'], ['calibri', 'calibri'], ['caladea', 'cambria'], ['cambria', 'cambria'],
    ['consolas', 'consolas'], ['trebuchet', 'trebuchet'], ['tahoma', 'tahoma'], ['palatino', 'palatino'],
    ['comic neue', 'comicneue'], ['comicneue', 'comicneue'], ['comic', 'comicsans'],
    ['pacifico', 'pacifico'], ['brush script', 'brushscript'], ['brushscript', 'brushscript'],
    ['arimo', 'arial'], ['arial', 'arial'], ['geneva', 'arial'], ['helvetica', 'helvetica'], ['verdana', 'verdana'],
    ['tinos', 'times'], ['times', 'times'], ['cousine', 'courier'], ['courier', 'courier'],
    ['gelasio', 'georgia'], ['georgia', 'georgia'], ['roboto', 'roboto'],
    ['open sans', 'opensans'], ['opensans', 'opensans'], ['montserrat', 'montserrat'],
  ];
  for (const [needle, key] of hits) if (n.includes(needle)) return key;
  return '';
}
