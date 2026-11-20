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

## One look

Every product follows the style Ultrahand set: white ground, thin warm-grey rules, square corners, black primary actions, blue for selection, sentence case and Plus Jakarta Sans. The product switcher is a row of underlined text tabs. The consultation editor gets this look from `public/shared/allto-editor.css`, which re-points its design tokens (the editor's code is untouched) and fixes it to the light theme.

## The allto intro

The allto intro animation (`public/shared/allto-intro.gif`) opens the whole process: it plays once per browser session on the allto home page (`Allto.playIntro()`; skip with a click or Esc; off with reduced motion). It no longer plays inside the consultation editor. Published consultation sites keep their own copy so the public still sees it, and Present's exports will open with it too.

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

## Ultrahand: what it does now

- **Red line or quick box**, study area (around, walk, drawn, box), planning designations, transport and everyday places
- **Views:** plan, 3D, axonometric (cut-out model, buildings grow from the site), atlas (every building on a numbered grid), eye level (first person: drag to look, W/S to walk)
- **Massing:** draw proposed blocks with a use and storeys; live floor area by use, homes, density, plot ratio and coverage, with stated assumptions; in every view and export
- **LIDAR (Environment Agency, 1 m):** measured building heights, ground levels in metres AOD, true-scale site sections, 1 m contours
- **Walking reach from a point:** click a spot; 5 / 10 / 15 minutes spread along the streets; toggle bands and set colours in the key
- **Public transport access:** stations and stops by walking time along the streets
- **Surface water flood risk:** the EA national assessment as a layer, and the share of the red line at each risk level
- **People and place:** Census 2021 (population, density, age, homes, tenure, cars, travel to work) and deprivation (IMD 2019) for the surrounding neighbourhoods, with a map layer
- **Townscape:** coverage, estimated plot ratio and floor area, storeys, height bands, grain, street density
- **Building passport**, selection with a leader line, sun and shadow, **sun study sheet** (21 March, June, December at 9, 12, 15) with a sun-path diagram
- **Drawings:** axonometric, atlas sheet, plan and sun study (SVG); site section (SVG); CAD plan (DXF on British National Grid); 3D model (OBJ)
- **Land Registry parcels** (INSPIRE index polygons) as a layer, through the allto Worker
- **Ask about this site:** a Copilot Studio agent with the site already in hand. Setup: [docs/agent](docs/agent/README.md); Worker: [workers/agent-token](workers/agent-token)

Open data used: OpenStreetMap (via Mapbox), planning.data.gov.uk, Environment Agency LIDAR and surface water (OGL), ONS and Nomis (Census 2021, OGL), MHCLG English Indices of Deprivation 2019 (OGL), HM Land Registry INSPIRE Index Polygons.

## Layout

```
index.html, home/          allto home: current project + products
present/                   allto: Present (starter)
ultrahand/                 allto: Ultrahand (Vite + TypeScript, Mapbox GL v3)
lib/                       typed window.Allto, static red-line map, shared page styles
public/shared/             allto.js, allto.css, consultation-bridge.js, logos (served as-is)
public/consultation/       the consultation editor (single file, served as-is)
public/examples/           a published consultation site (Thompson's Yard)
workers/agent-token/       Cloudflare Worker: Direct Line tokens for the site agent
docs/agent/                setting up the Copilot Studio site agent
```

## Next steps

1. **Projects on a server.** Move `allto:project`, the editor's project JSON and Ultrahand's settings to a shared backend (e.g. Supabase) with sign-in, so a project follows the team rather than the browser.
2. **Analysis as blocks.** Ultrahand's axonometric, atlas sheet, building passport and constraints summary become blocks the Consultation editor can place in scenes, and Present can place on slides, all live from the project's site model.
3. **Present proper.** Slides from consultation scenes (camera, layers, words), Ultrahand drawings, presenter view, PDF and PowerPoint export.
4. **One editor shell.** Bring Ultrahand's panels into the editor's left / right panel layout and its light and dark themes, so all three feel like modes of one editor.
5. **One Mapbox token** served from the backend for every product, instead of one per product.
