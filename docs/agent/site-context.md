# Site context sent to the agent

When the chat connects, and again whenever the site changes (re-analysed, a building selected, a walk drawn),
Ultrahand sends a Direct Line **event** activity:

```json
{ "type": "event", "name": "allto.siteContext", "value": { …the site… } }
```

then, on connecting, `{ "type": "event", "name": "startConversation", "value": { "locale": "en-GB" } }`.

The same object can be copied as text or downloaded as JSON from the panel, which is useful for testing the agent
in Copilot Studio's test pane before the Worker is up. A real example: [example-site-context.json](example-site-context.json)
(Castlefield, Manchester, with LIDAR heights and one proposed block; about 8 KB).

## Fields (`schema: "allto.ultrahand.site/2"`)

| Field | What it holds |
|---|---|
| `schema`, `generatedAt` | Format version; when Ultrahand built it (ISO time) |
| `place`, `localPlanningAuthority` | Place name; local planning authority (planning.data.gov.uk) |
| `location` | Centre of the red line (or study area): `lng`, `lat` |
| `redLine` | `areaM2`, `perimeterM`, `geometry` (GeoJSON, 6 decimal places), or `null` for a quick box |
| `studyArea` | `kind` (e.g. "200 m around the red line", "quick box"), `areaM2` |
| `buildings` | `inStudyArea`, `onSite`, `heightsRecorded`, `heightsMeasuredByLidar`, `medianHeightM`, `tallestM`, `listedEntries`, `heightBands[]` |
| `townscape` | `studyArea` and `redLine`: `landM2`, `buildings`, `coverage` (0–1), `plotRatioEstimate`, `floorAreaEstimateM2`, `meanStoreys`; plus `medianFootprintM2`, `streetsAndPathsKmPerKm2`, `storeyHeightAssumedM` |
| `publicTransportAccess` | `busStopsWithin5MinWalk[]`, `stationsWithin12MinWalk[]` (name, kind, minutes): walking times along streets; no frequencies |
| `surfaceWaterRiskOnRedLine` | By risk band (High, Medium, Low): `areaM2`, `share` of the red line (EA national assessment) |
| `peopleAndPlace` | Census 2021 for the overlapping neighbourhoods: `residents`, `households`, `peoplePerHectare`, `shares` (age, accommodation, tenure, householdsWithoutACar, travelToWork); `neighbourhoods[]` with `imdDecile2019` |
| `groundLevelsAOD` | From LIDAR, if measured: `min`, `max`, `fall` (metres above ordnance datum) and `over` (red line or study area) |
| `designations.onRedLine[]` | `type`, `name`, `reference`, `url` (planning.data.gov.uk entity) |
| `designations.inStudyArea` | By type: `count` and up to 12 `examples` |
| `gettingAbout` | `nearestStation` (`name`, `kind`, `distanceM`), `busStopsWithin400m` |
| `walkingReach` | If a walk is drawn: `from`, `speedKmh`, `bands[]` (`minutes`, `metres`, `streetsAndPathsKm`) |
| `selectedBuilding` | If one is selected: `ref`, `name`, `heightM`, `heightRecorded`, `footprintM2`, `onSite`, `listed[]`, `designations[]` |
| `proposedMassingHeightM` | The quick massing height over the red line, if set |
| `proposedBlocks` | Drawn blocks (`name`, `use`, `storeys`, `heightM`, `fromM`, `footprintM2`, `floorAreaM2`), `totals` (floor area by use, homes, dwellings per hectare, plot ratio, coverage, tallest) and the `assumptions` used |
| `sources[]`, `caveats[]` | Where the data comes from; what it is not |

Bump `schema` (now `/2`; `/1` had no transport, flood, people, LIDAR or block fields) if fields are renamed or removed, so the agent's topic can tell versions apart.
