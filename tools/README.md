# tools/

`extract_catalog.mjs` mechanically derives a declarative action catalog from a
hand-maintained runner table by introspecting its buildArgs functions — used once
during the original extraction, kept because it documents how the shipped catalogs
were produced and can re-derive them if a game's runner table changes.

The one-time Python port scripts that lived here during the original extraction
from the first game this harness was built on are deleted; they are in git
history before `v0.1.0` if ever needed.
