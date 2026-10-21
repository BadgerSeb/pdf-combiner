# PDF Combiner (web)

The web version of PDF Combiner for Badger Metal & Machine Fabrication (Riverdale, NJ). Combine PDFs,
pictures, text files and DXF drawings into one PDF; pick, skip and rotate pages; save as PDF (one file or one
per page), Word, OpenDocument text, RTF, plain text, a web page, PowerPoint, Excel, OpenDocument spreadsheet,
CSV, DXF, SVG, EPS, or pictures: PNG, JPEG, WebP, AVIF, GIF, BMP, TIFF, Photoshop, TGA, PPM or Windows icon.
Always dark (light mode cannot be turned on, by request).

**Everything happens in your browser. Files are never uploaded anywhere.**

Word, Excel, PowerPoint, SOLIDWORKS and DWG files need programs a browser can't use; for those, use
the PDF Combiner desktop app.

## Use it

Open the site in Edge or Chrome. To install it like a program (its own window, Start menu entry,
works offline, and "Open with" for PDFs and pictures), click the **Install** icon at the right of
the address bar, or **⋯ → Apps → Install PDF Combiner**.

Updates arrive by themselves: the app checks for a new version whenever it opens and every half
hour. If files are open, a "Restart now" button appears in the top bar instead of interrupting you.

## Publish an update

```powershell
powershell -ExecutionPolicy Bypass -File publish.ps1 "What changed"
```

This stamps a new version into `sw.js`, commits and pushes. GitHub Pages serves it within a minute or two.

## Try it locally

```powershell
powershell -ExecutionPolicy Bypass -File tools\serve.ps1
```

Then open http://localhost:8123/ .

## Layout

```
index.html, css/app.css   the window and its two themes
js/app.js                 state and actions: list, page grid, Pages box, theme, paste/drop, keys, updates
js/convert.js             files -> PDF in the browser (PDF, pictures, TIFF, text, DXF)
js/thumbs.js              page previews (pdf.js), size-limited cache
js/viewer.js              full-size page viewer
js/save.js                the save formats and writing files (Save dialog, a folder for one-file-per-page, download)
js/dxf/                   DXF reader and renderer (port of the desktop app's)
js/export/                combine and split (pdf-lib); Excel, CSV, ODS, DXF, SVG, EPS and documents from the PDF's
                          content (docs.js, tables.js, vector.js); pictures (images.js, avif.js: AV1 via WebCodecs)
sw.js, manifest.webmanifest  offline copy, install, automatic updates, "Open with"
vendor/                   pdf.js 6.4 (Apache-2.0), pdf-lib 1.17.1, fflate, UTIF, gifenc (MIT); licenses in vendor/LICENSES
tools/                    local server, headless-Edge test driver, icon drawing, version stamping
tests/                    test pages and scripts (sample files are kept out of the repository)
```
