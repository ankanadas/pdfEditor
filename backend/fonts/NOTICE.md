# Bundled fonts

These TTFs are embedded by the edit backend when the floating toolbar's font picker
selects a non-Base-14 family, so the chosen font renders in the saved PDF on any host
(incl. Linux/Render). All are open-licensed and redistributable.

| Family (toolbar)   | Bundled font | License |
|--------------------|--------------|---------|
| Roboto             | Roboto        | Apache-2.0 |
| Open Sans          | Open Sans     | OFL-1.1 |
| Montserrat         | Montserrat    | OFL-1.1 |
| Comic Sans MS      | Comic Neue    | OFL-1.1 |
| Georgia            | Gelasio (Regular/Italic; metric-compatible) | OFL-1.1 |

Arial / Helvetica / Times New Roman / Courier New render via PyMuPDF's Base-14 builtins
(metric-compatible), and Verdana via the local system font when present (Base-14 sans
fallback otherwise) — none need bundling.
