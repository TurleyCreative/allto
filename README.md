# allto

One project, three ways to work on it.

| Product | Path | What it does | State |
|---|---|---|---|
| **allto: Consultation** | `public/consultation/` | Builds the public consultation site: scenes, map, markers, zones, questions, co-design and feedback. Publishes a standalone site. | In use (from `alltodev/editor-scr.html`) |
| **allto: Present** | `present/` | Presents the project from the same material. | Starter page |
| **allto: Ultrahand** | `ultrahand/` | Design and constraints: red line, study area, planning designations, plan / 3D / axonometric / atlas / eye level, building passports, SVG drawings. | New |

The home page (`index.html`) shows the current project and links the three.

## The shared project

Every page loads `public/shared/allto.js`, which provides `window.Allto`:

- **The project** lives in this browser under `allto:project`: `{ name, place, redLine, updatedAt, source }`.
- **The red line is drawn once.** Draw or import it in Consultation or Ultrahand and the other picks it up when it next opens, or straight away if it's open in another tab. A short notice says where it came from.
- **Consultation** shares its site title (as the project name), subtitle (as the place) and red line. Only the red line flows back in, so a public site's curated title is never overwritten. The editor exposes `window.alltoEditor` (one line at the end of its script) and `public/shared/consultation-bridge.js` does the rest.
- **Ultrahand** shares its red line and, once analysed, the place. A red line from elsewhere replaces its own and clears the old analysis.
- **The product switcher** (allto* logo, then Consultation · Present · Ultrahand) and the project chip come from the same file, so every product carries the same top bar.

Type is Plus Jakarta Sans across allto (`public/shared/allto.css`). Published consultation sites keep their own per-project font setting, which is client branding.

## Run it

```bash
npm install
```

```bash
echo "VITE_MAPBOX_TOKEN=pk.your-public-token" > .env.local
```

```bash
npm run dev
```

Open http://localhost:5173/. The consultation editor still takes its own Mapbox token under Settings, because that token is written into the sites it publishes.

The example site in `public/examples/` keeps its Mapbox token out of git as `__MAPBOX_TOKEN__`; the build (and dev server) fills in `VITE_MAPBOX_TOKEN`.

`npm run build` writes the whole site to `dist/`. On push to `main`, `.github/workflows/pages.yml` deploys it to GitHub Pages: set **Settings → Pages → Source: GitHub Actions** and add the repository variable `VITE_MAPBOX_TOKEN`.

## Layout

```
index.html, home/          allto home: current project + products
present/                   allto: Present (starter)
ultrahand/                 allto: Ultrahand (Vite + TypeScript, Mapbox GL v3)
lib/                       typed window.Allto, static red-line map, shared page styles
public/shared/             allto.js, allto.css, consultation-bridge.js, logos (served as-is)
public/consultation/       the consultation editor (single file, served as-is)
public/examples/           a published consultation site (Thompson's Yard)
```

## Next steps

1. **Projects on a server.** Move `allto:project`, the editor's project JSON and Ultrahand's settings to a shared backend (e.g. Supabase) with sign-in, so a project follows the team rather than the browser.
2. **Analysis as blocks.** Ultrahand's axonometric, atlas sheet, building passport and constraints summary become blocks the Consultation editor can place in scenes, and Present can place on slides, all live from the project's site model.
3. **Present proper.** Slides from consultation scenes (camera, layers, words), Ultrahand drawings, presenter view, PDF and PowerPoint export.
4. **One editor shell.** Bring Ultrahand's panels into the editor's left / right panel layout and its light and dark themes, so all three feel like modes of one editor.
5. **One Mapbox token** served from the backend for every product, instead of one per product.
