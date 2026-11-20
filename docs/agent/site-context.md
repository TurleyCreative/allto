# Site context sent to the agent

When the chat connects, and again whenever the site changes (re-analysed, a building selected, a walk drawn),
Ultrahand sends a Direct Line **event** activity:

```json
{ "type": "event", "name": "allto.siteContext", "value": { …the site… } }
```

then, on connecting, `{ "type": "event", "name": "startConversation", "value": { "locale": "en-GB" } }`.

The same object can be copied as text or downloaded as JSON from the panel, which is useful for testing the agent
in Copilot Studio's test pane before the Worker is up. A real example: [example-site-context.json](example-site-context.json)
(Castlefield, Manchester; about 4.5 KB).

## Fields (`schema: "allto.ultrahand.site/1"`)

| Field | What it holds |
|---|---|
| `schema`, `generatedAt` | Format version; when Ultrahand built it (ISO time) |
| `place`, `localPlanningAuthority` | Place name; local planning authority (planning.data.gov.uk) |
| `location` | Centre of the red line (or study area): `lng`, `lat` |
| `redLine` | `areaM2`, `perimeterM`, `geometry` (GeoJSON, 6 decimal places), or `null` for a quick box |
| `studyArea` | `kind` (e.g. "200 m around the red line", "quick box"), `areaM2` |
| `buildings` | `inStudyArea`, `onSite`, `heightsRecorded`, `medianHeightM`, `tallestM`, `listedEntries`, `heightBands[]` |
| `townscape` | `studyArea` and `redLine`: `landM2`, `buildings`, `coverage` (0–1), `plotRatioEstimate`, `floorAreaEstimateM2`, `meanStoreys`; plus `medianFootprintM2`, `streetsAndPathsKmPerKm2`, `storeyHeightAssumedM` |
| `designations.onRedLine[]` | `type`, `name`, `reference`, `url` (planning.data.gov.uk entity) |
| `designations.inStudyArea` | By type: `count` and up to 12 `examples` |
| `gettingAbout` | `nearestStation` (`name`, `kind`, `distanceM`), `busStopsWithin400m` |
| `walkingReach` | If a walk is drawn: `from`, `speedKmh`, `bands[]` (`minutes`, `metres`, `streetsAndPathsKm`) |
| `selectedBuilding` | If one is selected: `ref`, `name`, `heightM`, `heightRecorded`, `footprintM2`, `onSite`, `listed[]`, `designations[]` |
| `proposedMassingHeightM` | If set in Ultrahand |
| `sources[]`, `caveats[]` | Where the data comes from; what it is not |

Bump `schema` (e.g. to `/2`) if fields are renamed or removed, so the agent's topic can tell versions apart.
