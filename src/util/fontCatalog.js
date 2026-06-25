// Font catalogue + related constants (preview CSS per key, signature script fonts, link
// colour). Extracted from PDFEditorApp static getters into module consts; values verbatim.

export const SIGN_FONTS = [
  '"Snell Roundhand","Savoye LET",cursive',
  '"Brush Script MT","Bradley Hand",cursive',
  '"Apple Chancery","Segoe Script",cursive',
  '"Savoye LET","Snell Roundhand",cursive',
];

/** The full font catalogue shown in the picker: { key, name, tag, css }. css is the on-screen
 *  preview/editor font-family (proprietary name first, then the bundled open pf-* face). */
export const FONT_CATALOG = [
  { key: 'arial', name: 'Arial', tag: 'Sans', css: 'Arial, "pf-arimo", sans-serif' },
  { key: 'helvetica', name: 'Helvetica', tag: 'Sans', css: 'Helvetica, "pf-arimo", Arial, sans-serif' },
  { key: 'times', name: 'Times New Roman', tag: 'Serif', css: '"Times New Roman", "pf-tinos", Times, serif' },
  { key: 'georgia', name: 'Georgia', tag: 'Serif', css: 'Georgia, "pf-gelasio", serif' },
  { key: 'verdana', name: 'Verdana', tag: 'Sans', css: 'Verdana, "pf-arimo", Geneva, sans-serif' },
  { key: 'courier', name: 'Courier New', tag: 'Mono', css: '"Courier New", "pf-cousine", Courier, monospace' },
  { key: 'roboto', name: 'Roboto', tag: 'Sans', css: 'Roboto, "pf-roboto", Arial, sans-serif' },
  { key: 'opensans', name: 'Open Sans', tag: 'Sans', css: '"Open Sans", "pf-open-sans", Arial, sans-serif' },
  { key: 'montserrat', name: 'Montserrat', tag: 'Sans', css: 'Montserrat, "pf-montserrat", Arial, sans-serif' },
  { key: 'comicsans', name: 'Comic Sans MS', tag: 'Script', css: '"Comic Sans MS", "pf-comic-neue", cursive' },
  { key: 'calibri', name: 'Calibri', tag: 'Sans', css: 'Calibri, "pf-carlito", sans-serif' },
  { key: 'tahoma', name: 'Tahoma', tag: 'Sans', css: 'Tahoma, "pf-arimo", sans-serif' },
  { key: 'trebuchet', name: 'Trebuchet MS', tag: 'Sans', css: '"Trebuchet MS", "pf-arimo", sans-serif' },
  { key: 'inter', name: 'Inter', tag: 'Sans', css: 'Inter, "pf-inter", sans-serif' },
  { key: 'lato', name: 'Lato', tag: 'Sans', css: 'Lato, "pf-lato", sans-serif' },
  { key: 'poppins', name: 'Poppins', tag: 'Sans', css: 'Poppins, "pf-poppins", sans-serif' },
  { key: 'nunito', name: 'Nunito', tag: 'Sans', css: 'Nunito, "pf-nunito", sans-serif' },
  { key: 'sourcesans', name: 'Source Sans Pro', tag: 'Sans', css: '"Source Sans Pro", "Source Sans 3", "pf-source-sans-3", sans-serif' },
  { key: 'ubuntu', name: 'Ubuntu', tag: 'Sans', css: 'Ubuntu, "pf-ubuntu", sans-serif' },
  { key: 'ptsans', name: 'PT Sans', tag: 'Sans', css: '"PT Sans", "pf-pt-sans", sans-serif' },
  { key: 'garamond', name: 'Garamond', tag: 'Serif', css: 'Garamond, "pf-eb-garamond", serif' },
  { key: 'cambria', name: 'Cambria', tag: 'Serif', css: 'Cambria, "pf-caladea", serif' },
  { key: 'baskerville', name: 'Baskerville', tag: 'Serif', css: 'Baskerville, "pf-libre-baskerville", serif' },
  { key: 'palatino', name: 'Palatino', tag: 'Serif', css: 'Palatino, "Palatino Linotype", "pf-noto-serif", serif' },
  { key: 'merriweather', name: 'Merriweather', tag: 'Serif', css: 'Merriweather, "pf-merriweather", serif' },
  { key: 'librebaskerville', name: 'Libre Baskerville', tag: 'Serif', css: '"Libre Baskerville", "pf-libre-baskerville", serif' },
  { key: 'playfair', name: 'Playfair Display', tag: 'Serif', css: '"Playfair Display", "pf-playfair-display", serif' },
  { key: 'notoserif', name: 'Noto Serif', tag: 'Serif', css: '"Noto Serif", "pf-noto-serif", serif' },
  { key: 'consolas', name: 'Consolas', tag: 'Mono', css: 'Consolas, "pf-cousine", monospace' },
  { key: 'firacode', name: 'Fira Code', tag: 'Mono', css: '"Fira Code", "pf-fira-code", monospace' },
  { key: 'jetbrainsmono', name: 'JetBrains Mono', tag: 'Mono', css: '"JetBrains Mono", "pf-jetbrains-mono", monospace' },
  { key: 'sourcecodepro', name: 'Source Code Pro', tag: 'Mono', css: '"Source Code Pro", "pf-source-code-pro", monospace' },
  { key: 'ibmplexmono', name: 'IBM Plex Mono', tag: 'Mono', css: '"IBM Plex Mono", "pf-ibm-plex-mono", monospace' },
  { key: 'brushscript', name: 'Brush Script', tag: 'Script', css: '"Brush Script MT", "pf-pacifico", cursive' },
  { key: 'pacifico', name: 'Pacifico', tag: 'Script', css: 'Pacifico, "pf-pacifico", cursive' },
  { key: 'comicneue', name: 'Comic Neue', tag: 'Script', css: '"Comic Neue", "pf-comic-neue", cursive' },
];

export const FONT_BY_KEY = Object.fromEntries(FONT_CATALOG.map(f => [f.key, f]));
export const TOOLBAR_FONT_KEYS = FONT_CATALOG.map(f => f.key);
export const LINK_BLUE = [0, 0, 238];
