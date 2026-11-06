# Data Templates

Sample JSON files showing the raw format used in `test/data/*_table.json`.
Actual data files are gitignored — these templates exist for reference and onboarding.

**Row-absence rule (Phase 15.4 D-14):** Each template sub-block (`classic` or
`auction`) produces exactly one DB row; an absent sub-block produces NO row for
that draftMode. There is no zero-padding fallback. See
`.planning/ROADMAP.md` §Phase 15.4 and `.planning/phases/15.4-cost-table-draftmode-restructure/15.4-CONTEXT.md`
for the full decision context.

**Canonical shape (Phase 15 D-22):** snake_case keys throughout; `cost` is a
wrapping object with `cost_set_id` (int, `0` = default sentinel) + one block per
game mode (`memory_of_chaos`, `apocalyptic_shadow`, `anomaly_arbitration`);
`positioning` is optional in JSON (convention: include with `{0,0,0}` when no
tweak) but DB columns are required `i32` with `0` defaults; Spine fields
(`skel_url`, `atlas_url`, `atlas_img_url`) live only on characters and are
optional (empty string / empty array = absent).

**Sibling-block shape (Phase 15.1 D-01 + Phase 15.4 D-12):** Every mode block on
all three cost domains (characters, lightcones, pairings) has the same
`{ classic?, auction? }` sub-block structure. Both sub-blocks are optional at
the template level. The seed emits one DB row per present sub-block, tagged with
`draftMode: 'Classic' | 'Auction'`.

## Field Transforms Applied by seed-data.ts

### characters_table.json -> HsrCharacter + HsrCharacterCost

| Raw field | Target field | Transform |
|-----------|-------------|-----------|
| `name` | `name` | direct copy |
| `display_name` | `displayName` | snake_case -> camelCase |
| `aliases` | `aliases` | direct copy (array); missing -> `[]` |
| `rarity` | `rarity` | direct copy (int) |
| `path` | `path` | lowercase -> PascalCase (e.g. `"nihility"` -> `"Nihility"`) |
| `element` | `element` | lowercase -> PascalCase (e.g. `"lightning"` -> `"Lightning"`) |
| `role` | `role` | lowercase -> CharRole PascalCase (`"dps"` -> `"Dps"`) |
| `image_url` | `imageUrl` | snake_case -> camelCase; missing -> `""` |
| `version_released` | `versionReleased` | snake_case -> camelCase; missing -> `0` |
| `treat_as_version` | `treatAsVersion` | snake_case -> camelCase; missing -> `0` |
| `skel_url` | `skelUrl` | snake_case -> camelCase; empty string -> `null` |
| `atlas_url` | `atlasUrl` | snake_case -> camelCase; empty string -> `null` |
| `atlas_img_url` | `atlasImgUrls` | snake_case -> camelCase; missing -> `[]` |
| `positioning.x` | `posX` | nested -> flat int; missing block -> `0` |
| `positioning.y` | `posY` | nested -> flat int; missing block -> `0` |
| `positioning.width` | `width` | nested -> flat int; missing block -> `0` |
| `cost.cost_set_id` | (lifts to `costSetId` on each fanned row) | missing -> `0` |
| `cost.<mode>.classic.E0..E6` | HsrCharacterCost row with `draftMode='Classic'`, `costs={e0..e6}` | present -> emit row; absent -> no Classic row for that mode |
| `cost.<mode>.auction.E0..E6` | HsrCharacterCost row with `draftMode='Auction'`, `costs={e0..e6}` | present -> emit row; absent -> no Auction row for that mode |
| (mode block present but both `classic` + `auction` sub-blocks absent) | (no row written) | Skip the mode entirely (D-14) |
| `E0..E6` (uppercase) | `e0..e6` | lowercase keys in EidolonCost struct |

**Fan-out:** one DB row per `(characterName, gameMode, draftMode, costSetId)`
combination. For each character with a `cost` block, every (mode × draftMode)
sub-block that is present in the template produces one row. Absent sub-block =
no row for that draftMode (D-14). Maximum rows per character = 3 modes × 2
draftModes = **6 HsrCharacterCost rows**. Typical Classic-only character = 3
rows (one per mode).

### lightcones_table.json -> HsrLightcone + HsrLightconeCost

| Raw field | Target field | Transform |
|-----------|-------------|-----------|
| `name` | `name` | direct copy |
| `display_name` | `displayName` | snake_case -> camelCase |
| `aliases` | `aliases` | direct copy; missing -> `[]` |
| `path` | `path` | lowercase -> PascalCase |
| `rarity` | `rarity` | direct copy (int) |
| `image_url` | `imageUrl` | snake_case -> camelCase; missing -> `""` |
| `positioning.x` | `posX` | nested -> flat int; missing block -> `0` |
| `positioning.y` | `posY` | nested -> flat int; missing block -> `0` |
| `positioning.width` | `width` | plain int (was `"120%"` string with parseInt in pre-D-22 shape; now always int) |
| `cost.cost_set_id` | (lifts to `costSetId` on each fanned row) | missing -> `0` |
| `cost.<mode>.classic.S1..S5` | HsrLightconeCost row with `draftMode='Classic'`, `costs={s1..s5}` | present -> emit row; absent -> no Classic row for that mode |
| `cost.<mode>.auction.S1..S5` | HsrLightconeCost row with `draftMode='Auction'`, `costs={s1..s5}` | present -> emit row; absent -> no Auction row for that mode |
| (mode block present but both `classic` + `auction` sub-blocks absent) | (no row written) | Skip the mode entirely (D-14) |
| `S1..S5` (uppercase) | `s1..s5` | lowercase keys in SuperimpositionCost struct |

**Fan-out:** one DB row per `(lightconeName, gameMode, draftMode, costSetId)`
combination. Maximum rows per lightcone = 3 modes × 2 draftModes = **6
HsrLightconeCost rows**. Typical Classic-only lightcone = 3 rows.

### pairing_table.json -> HsrSynergyCost

**Input shape (Phase 15.4 D-12, sibling-block):**

```json
{
  "source_name": "cerydra",
  "target_name": "anaxa",
  "cost": {
    "cost_set_id": 0,
    "memory_of_chaos":     { "classic": { "modifier": 3.0 }, "auction": { "modifier": 0.0 } },
    "apocalyptic_shadow":  { "classic": { "modifier": 3.0 }, "auction": { "modifier": 0.0 } },
    "anomaly_arbitration": { "classic": { "modifier": 3.0 }, "auction": { "modifier": 0.0 } }
  }
}
```

| Raw field | Target field | Transform |
|-----------|-------------|-----------|
| `source_name` | `sourceName` | snake_case -> camelCase |
| `target_name` | `targetName` | snake_case -> camelCase |
| `cost.cost_set_id` | (lifts to `costSetId` on each fanned row) | missing -> `0` |
| `cost.<mode>.classic.modifier` | HsrSynergyCost row with `draftMode='Classic'`, `costModifier=<value>` | present -> emit row; absent -> no Classic row for that mode |
| `cost.<mode>.auction.modifier` | HsrSynergyCost row with `draftMode='Auction'`, `costModifier=<value>` | present -> emit row; absent -> no Auction row for that mode |
| (mode block present but both `classic` + `auction` sub-blocks absent) | (no row written) | Skip the mode entirely (D-14) |

**Fan-out:** one DB row per `(sourceName, targetName, gameMode, draftMode, costSetId)`
combination. Maximum rows per pairing = 3 modes × 2 draftModes = **6 HsrSynergyCost
rows**.

**Worked example.** For the `cerydra -> anaxa` entry above with all three modes
carrying both `classic` and `auction` sub-blocks, the seed emits 6 rows:

| sourceName | targetName | gameMode | draftMode | costModifier |
|---|---|---|---|---|
| cerydra | anaxa | MemoryOfChaos | Classic | 3.0 |
| cerydra | anaxa | MemoryOfChaos | Auction | 0.0 |
| cerydra | anaxa | ApocalypticShadow | Classic | 3.0 |
| cerydra | anaxa | ApocalypticShadow | Auction | 0.0 |
| cerydra | anaxa | AnomalyArbitration | Classic | 3.0 |
| cerydra | anaxa | AnomalyArbitration | Auction | 0.0 |

Default-seed synergy auction modifiers are `0.0` (Phase 15.4 D-13 — first-ever
synergy auction rows, values to be tuned in a later phase).

## Notes

- `costSetId: 0` is the sentinel for the default cost set — seeds always use it. Non-zero values denote custom (per-tournament / per-lobby) cost sets and round-trip through `admin_bulk_upsert` using the composite tuple match `(name, gameMode, draftMode, costSetId)` / `(sourceName, targetName, gameMode, draftMode, costSetId)` introduced in Phase 15.4.
- Characters with no `cost` entry in the JSON get no HsrCharacterCost rows.
- Lightcone `positioning` is optional — omitting the block defaults `posX`/`posY`/`width` to `0`. Characters follow the same rule.
- Spine fields (`skel_url`, `atlas_url`, `atlas_img_url`) are all optional on characters; empty-string -> `null`, missing array -> `[]`. Lightcones have no Spine fields.
- Sub-block absence = "not configured for that draftMode". There is no silent classic -> auction copy at the seed layer, and no zero-padding for absent sub-blocks (Phase 15.4 D-14 replaces Phase 15.1 D-07/D-08).
- Unknown mode keys (anything other than the three snake_case modes above) are logged as warnings and skipped at the seed layer. The router's `validateEnum` is a second defensive gate.
