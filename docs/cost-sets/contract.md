# Cost Sets

**Architecture:** [architecture.md](architecture.md)

## Feature Overview

Cost sets define the per-character, per-lightcone, and synergy cost values used during draft sessions. A cost set follows a lifecycle: created as a draft (cloned from an existing published set), edited in draft tables, published to live tables, optionally locked to prevent new lobbies from selecting it, unpublished, and finally deleted. The default cost set (id=0) is protected and cannot be locked, unpublished, or deleted. Draft tables are private; live cost tables are public. TournamentHost+ can create and manage their own cost sets; Moderator+ can edit any cost set.

## Reducers

### create_cost_set

**Purpose:** Create a new draft cost set by cloning costs from an existing published set (or the default set)

**Permission:** TournamentHost, Moderator, or Admin (`ensureTournamentHost`)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | Yes | Cost set name (1–100 chars after trim) |
| sourceSetId | u32 | Yes | Source cost set to clone from (0 = default set) |
| gameModeTag | string | Yes | "MemoryOfChaos", "ApocalypticShadow", or "AnomalyArbitration" |

**Flow:**
1. `ensureTournamentHost` — require TournamentHost+ role
2. Validate name: 1–100 chars after trim
3. Validate gameModeTag is one of the 3 valid values
4. If sourceSetId !== 0: verify source exists and isPublished=true
5. Insert CostSet row (isDraft=true, isPublished=false, isLocked=false, creatorId=caller)
6. Clone HsrCharacterCost rows from source into CostSetDraftCharacter, filtered by gameModeTag. Source `draftMode` passes through unchanged — both Classic and Auction rows clone together (Phase 15.4 D-20).
7. Clone HsrLightconeCost rows from source into CostSetDraftLightcone, filtered by gameModeTag (draftMode passes through).
8. Clone HsrSynergyCost rows from source into CostSetDraftSynergy, filtered by gameModeTag (draftMode passes through).

**Expected State Changes:**
- CostSet row inserted (isDraft=true, isPublished=false)
- CostSetDraftCharacter rows inserted (cloned from source, filtered by gameMode; both Classic + Auction draftModes preserved)
- CostSetDraftLightcone rows inserted (cloned from source, filtered by gameMode; both draftModes preserved)
- CostSetDraftSynergy rows inserted (cloned from source, filtered by gameMode; both draftModes preserved)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Caller lacks TournamentHost+ | Permission error from ensureTournamentHost |
| Name too short or too long | "Cost set name must be between 1 and 100 characters." |
| Invalid gameModeTag | "Invalid gameModeTag. Must be one of: MemoryOfChaos, ApocalypticShadow, AnomalyArbitration" |
| Source set not found | "Source cost set {sourceSetId} not found." |
| Source set not published | "Source cost set {sourceSetId} must be published before cloning." |

### edit_draft_character_cost

**Purpose:** Upsert a character's cost row in the draft table for a single `(characterName, gameMode, draftMode, costSetId)` tuple (delete+insert pattern for composite PK)

**Permission:** Cost set owner or Moderator+

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| costSetId | u32 | Yes | Target draft cost set |
| characterName | string | Yes | Character to edit |
| gameModeTag | string | Yes | Game mode for this cost entry |
| draftModeTag | string | Yes | "Classic" or "Auction" — selects which draft-mode row is upserted (Phase 15.4 D-16) |
| costsJson | string | Yes | JSON object with e0–e6 numeric fields (EidolonCost) |

**Flow:**
1. Authenticate caller
2. Find CostSet by ID
3. Ownership check: caller is creator or Moderator+
4. Verify costSet.isDraft=true
5. Parse and validate costsJson: must be valid JSON with numeric e0–e6 fields _Superseded in Phase S10f execution (backend audit 2026-11-09, roster finding 9)._
6. Find existing CostSetDraftCharacter row by 4-tuple (costSetId + characterName + gameModeTag + draftModeTag) via `cost_set_id` btree filter + in-memory predicate (A2_FALLBACK_ITER; SpacetimeDB 2.1.0 enum-struct btree limitation)
7. If found: delete old row, insert updated row (composite PK upsert pattern)
8. If not found: insert new row

One call = one row. Editing both Classic and Auction for the same character requires two reducer calls.

**Expected State Changes:**
- CostSetDraftCharacter row upserted for (costSetId, characterName, gameModeTag, draftModeTag)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Cost set not found | "Cost set {costSetId} not found." |
| Not owner and not Moderator+ | "Forbidden: You do not own this cost set and are not a Moderator." |
| Cost set not in draft state | "Cannot edit a cost set that is not in draft state. Publish creates a live copy; clone to make a new draft." _Superseded in Phase S10i execution (DECISIONS.md A107)._ |
| Invalid JSON | "costsJson must be a valid JSON object." |
| Missing e0–e6 field | "costsJson must have numeric field \"{key}\"." |

### edit_draft_lightcone_cost

**Purpose:** Upsert a lightcone's cost row in the draft table for a single `(lightconeName, gameMode, draftMode, costSetId)` tuple

**Permission:** Cost set owner or Moderator+

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| costSetId | u32 | Yes | Target draft cost set |
| lightconeName | string | Yes | Lightcone to edit |
| gameModeTag | string | Yes | Game mode for this cost entry |
| draftModeTag | string | Yes | "Classic" or "Auction" — selects which draft-mode row is upserted (Phase 15.4 D-17) |
| costsJson | string | Yes | JSON object with s1–s5 numeric fields (SuperimpositionCost) |

**Flow:**
1. Authenticate caller; find CostSet; ownership check; verify isDraft
2. Parse and validate costsJson: must be valid JSON with numeric s1–s5 fields
3. 4-tuple draft lookup (costSetId + lightconeName + gameModeTag + draftModeTag); delete+insert upsert on CostSetDraftLightcone

One call = one row per draft mode.

**Expected State Changes:**
- CostSetDraftLightcone row upserted for (costSetId, lightconeName, gameModeTag, draftModeTag)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Cost set not found | "Cost set {costSetId} not found." |
| Not owner and not Moderator+ | "Forbidden: You do not own this cost set and are not a Moderator." |
| Cost set not in draft state | "Cannot edit a cost set that is not in draft state." _Superseded in Phase S10i execution (DECISIONS.md A107)._ |
| Invalid JSON | "costsJson must be a valid JSON object." |
| Missing s1–s5 field | "costsJson must have numeric field \"{key}\"." |

### edit_draft_synergy_cost

**Purpose:** Upsert a synergy cost modifier in the draft table for a single `(sourceName, targetName, gameMode, draftMode, costSetId)` tuple

**Permission:** Cost set owner or Moderator+

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| costSetId | u32 | Yes | Target draft cost set |
| sourceName | string | Yes | Source character name for synergy |
| targetName | string | Yes | Target character name for synergy |
| gameModeTag | string | Yes | Game mode for this synergy entry |
| draftModeTag | string | Yes | "Classic" or "Auction" — part of composite PK (Phase 15.4 D-18) |
| costModifier | f32 | Yes | Synergy cost modifier value |

**Flow:**
1. Authenticate caller; find CostSet; ownership check; verify isDraft
2. Find existing CostSetDraftSynergy row by 5-tuple (costSetId + sourceName + targetName + gameModeTag + draftModeTag)
3. Upsert (delete+insert for composite PK)

Phase 15.4 introduced first-ever synergy auction rows — the default seed set now contains synergy rows with `draftMode=Auction` in addition to the pre-existing Classic rows (D-13 zero-value default).

**Expected State Changes:**
- CostSetDraftSynergy row upserted for (costSetId, sourceName, targetName, gameModeTag, draftModeTag)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Cost set not found | "Cost set {costSetId} not found." |
| Not owner and not Moderator+ | "Forbidden: You do not own this cost set and are not a Moderator." |
| Cost set not in draft state | "Cannot edit a cost set that is not in draft state." _Superseded in Phase S10i execution (DECISIONS.md A107)._ |

### publish_cost_set

**Purpose:** Copy all draft rows (both Classic and Auction draftModes) to live cost tables, clean up draft tables, mark CostSet as published

**Permission:** Cost set owner or Moderator+

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| costSetId | u32 | Yes | Draft cost set to publish |

**Flow:**
1. Authenticate caller; find CostSet; ownership check
2. Verify costSet.isDraft=true
3. Phase A: For each CostSetDraftCharacter row → upsert into HsrCharacterCost. `existingLive` predicate matches on `(characterName, gameMode.tag, draftMode.tag)` (Phase 15.4 D-21, Pitfall 7 regression guard locked by `test/backend/cost-sets/cost-set-lifecycle.test.ts`). Delete existing live row if present, then insert. Both Classic and Auction rows are copied.
4. Phase B: For each CostSetDraftLightcone row → upsert into HsrLightconeCost (same 3-way predicate match: name + gameMode + draftMode). Both Classic and Auction rows are copied.
5. Phase C: For each CostSetDraftSynergy row → upsert into HsrSynergyCost. Existing live row matched by 4-tuple `(sourceName, targetName, gameMode.tag, draftMode.tag)`; `id.update()` preserves autoInc id. Both Classic and Auction rows are copied.
6. Phase D: Delete all CostSetDraft* rows for this costSetId
7. Phase E: Update CostSet: isPublished=true, isDraft=false

**Expected State Changes:**
- HsrCharacterCost rows upserted from draft, covering both draftMode variants present in the draft set
- HsrLightconeCost rows upserted from draft, covering both draftMode variants
- HsrSynergyCost rows upserted from draft, covering both draftMode variants
- All CostSetDraftCharacter, CostSetDraftLightcone, CostSetDraftSynergy rows deleted
- CostSet.isPublished=true, CostSet.isDraft=false

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Cost set not found | "Cost set {costSetId} not found." |
| Not owner and not Moderator+ | "Forbidden: You do not own this cost set and are not a Moderator." |
| Cost set not in draft state | "Cannot publish a cost set that is not in draft state." |

### lock_cost_set

**Purpose:** Set isLocked=true on a published cost set, preventing new lobbies/tournaments from selecting it

**Permission:** Cost set owner or Moderator+

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| costSetId | u32 | Yes | Published cost set to lock |

**Flow:**
1. Reject if costSetId=0 (default set protected)
2. Authenticate caller; find CostSet; ownership check
3. Verify costSet.isPublished=true
4. Verify costSet.isLocked=false
5. Update CostSet.isLocked=true

**Expected State Changes:**
- CostSet.isLocked = true

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Attempting to lock default set | "The default cost set (id=0) cannot be locked." |
| Cost set not found | "Cost set {costSetId} not found." |
| Not owner and not Moderator+ | "Forbidden: You do not own this cost set and are not a Moderator." |
| Cost set not published | "Cannot lock a cost set that is not published." |
| Already locked | "Cost set is already locked." |

### unpublish_cost_set

**Purpose:** Remove a cost set from public availability (requires locking first)

**Permission:** Cost set owner or Moderator+

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| costSetId | u32 | Yes | Locked cost set to unpublish |

**Flow:**
1. Reject if costSetId=0 (default set protected)
2. Authenticate caller; find CostSet; ownership check
3. Verify costSet.isPublished=true
4. Verify costSet.isLocked=true (must lock before unpublishing)
5. Update CostSet: isPublished=false, isLocked=false

**Expected State Changes:**
- CostSet.isPublished = false, CostSet.isLocked = false
- Live cost rows (HsrCharacterCost etc.) remain in tables but CostSet metadata signals "inactive"

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Attempting to unpublish default set | "The default cost set (id=0) cannot be unpublished." |
| Cost set not found | "Cost set {costSetId} not found." |
| Not owner and not Moderator+ | "Forbidden: You do not own this cost set and are not a Moderator." |
| Not published | "Cost set is not published." |
| Not locked first | "Cost set must be locked before it can be unpublished. Call lock_cost_set first." |

### delete_cost_set

**Purpose:** Permanently delete a cost set and all associated live and draft cost rows

**Permission:** Cost set owner or Moderator+

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| costSetId | u32 | Yes | Unpublished cost set to delete |

**Flow:**
1. Reject if costSetId=0 (default set protected)
2. Authenticate caller; find CostSet; ownership check
3. Verify costSet.isPublished=false (must unpublish first)
4. Delete all HsrCharacterCost rows with this costSetId
5. Delete all HsrLightconeCost rows with this costSetId
6. Delete all HsrSynergyCost rows with this costSetId (via id.delete)
7. Delete all remaining CostSetDraftCharacter, CostSetDraftLightcone, CostSetDraftSynergy rows
8. Delete the CostSet row

**Expected State Changes:**
- All HsrCharacterCost rows for this costSetId deleted
- All HsrLightconeCost rows for this costSetId deleted
- All HsrSynergyCost rows for this costSetId deleted
- All draft rows deleted
- CostSet row deleted

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Attempting to delete default set | "The default cost set (id=0) cannot be deleted." |
| Cost set not found | "Cost set {costSetId} not found." |
| Not owner and not Moderator+ | "Forbidden: You do not own this cost set and are not a Moderator." |
| Still published | "Cost set must be unpublished before deleting. Call unpublish_cost_set first." |

## Acceptance Scenarios

### Create Cost Set (clone from source)
**Given:** User with TournamentHost+ role, source cost set exists and is published
**When:** `create_cost_set(name, sourceSetId, gameModeTag)`
**Then:** CostSet row created (isDraft=true, isPublished=false). Draft tables populated with cloned rows from source set filtered by gameMode. Both Classic and Auction draftMode rows clone together (source `draftMode` passes through).

### Edit Draft Costs
**Given:** Unpublished cost set owned by caller
**When:** `edit_draft_character_cost(costSetId, characterName, gameModeTag, draftModeTag, costsJson)`
**Then:** Draft character cost row upserted for the specified `(characterName, gameMode, draftMode)` tuple. Editing the other draftMode for the same character requires a second call.
**When:** `edit_draft_lightcone_cost(costSetId, lightconeName, gameModeTag, draftModeTag, costsJson)`
**Then:** Draft lightcone cost row upserted for the specified `(lightconeName, gameMode, draftMode)` tuple.
**When:** `edit_draft_synergy_cost(costSetId, sourceName, targetName, gameModeTag, draftModeTag, costModifier)`
**Then:** Draft synergy cost row upserted for the specified `(sourceName, targetName, gameMode, draftMode)` tuple.

### Publish Cost Set
**Given:** Draft cost set with edits (may contain both Classic and Auction rows)
**When:** `publish_cost_set(costSetId)`
**Then:** Draft rows copied to live HsrCharacterCost/HsrLightconeCost/HsrSynergyCost tables — both Classic and Auction draftMode rows copied. Draft rows deleted. CostSet: isDraft=false, isPublished=true.

### Lock Cost Set
**Given:** Published cost set
**When:** `lock_cost_set(costSetId)`
**Then:** CostSet: isLocked=true

### Unpublish Cost Set
**Given:** Locked cost set
**When:** `unpublish_cost_set(costSetId)`
**Then:** CostSet: isPublished=false, isLocked=false

### Delete Cost Set
**Given:** Unpublished cost set
**When:** `delete_cost_set(costSetId)`
**Then:** CostSet row deleted. All associated HsrCharacterCost, HsrLightconeCost, HsrSynergyCost rows cascade-deleted. Any remaining draft rows deleted.

### Default Cost Set Protection
**Given:** costSetId=0 (the default/system cost set)
**When:** `lock_cost_set(0)`, `unpublish_cost_set(0)`, or `delete_cost_set(0)`
**Then:** All three rejected with "The default cost set (id=0) cannot be {locked/unpublished/deleted}"

### Selection Requires a Selectable, Covering Set (Phase S6 execution, backlog #2, R2, D-D6)
**Given:** Set #5 published with one Classic character row and one Classic light-cone row for MemoryOfChaos; set #6 published with no rows
**When:** A lobby, preset or tournament selects set #6, or set #5 with Auction
**Then:** Rejected: "This cost set has no costs for MemoryOfChaos × {Classic|Auction}. Pick another set or ask its owner to extend it." The default set (id 0) always passes; a missing set ("Cost set N not found."), an unpublished set ("... is not published.") and a locked set ("... is locked and cannot be selected.") are rejected. Synergy rows are never required. Sites: `create_lobby`, `update_lobby_settings` (on a change of set, game mode or draft mode), `create/update_lobby_preset`, `create/update_tournament` (tournament: the preset's draft mode).

### Delete a Set in Use (Phase S6 execution, backlog #2, R2)
**Given:** Set #5 is referenced by a lobby in Waiting; its owner locked and unpublished it
**When:** The owner calls `delete_cost_set(5)`
**Then:** Rejected: "This cost set is used by an active lobby or tournament and cannot be deleted." Once the lobby is closed (or Finished) and no non-Completed / non-Cancelled tournament references it, the delete succeeds.

## Edge Cases

| Case | Expected Behavior | Notes |
|------|-------------------|-------|
| Lock default set (id=0) | Throws "The default cost set (id=0) cannot be locked" | |
| Unpublish default set (id=0) | Throws "The default cost set (id=0) cannot be unpublished" | |
| Delete default set (id=0) | Throws "The default cost set (id=0) cannot be deleted" | |
| Unpublish without locking first | Throws "Cost set must be locked before it can be unpublished. Call lock_cost_set first." | |
| Delete while still published | Throws "Cost set must be unpublished before deleting. Call unpublish_cost_set first." | |
| Edit draft of another user's cost set (non-Moderator) | Throws "Forbidden: You do not own this cost set and are not a Moderator." | |
| Clone from unpublished source | Throws "Source cost set {id} must be published before cloning." | |
| Name too long (>100 chars) | Throws "Cost set name must be between 1 and 100 characters." | |
| Empty name after trim | Throws "Cost set name must be between 1 and 100 characters." | |
| costsJson missing e0 field for character | Throws "costsJson must have numeric field \"e0\"." | |
| costsJson missing s1 field for lightcone | Throws "costsJson must have numeric field \"s1\"." | |
| costsJson not a valid JSON object | Throws "costsJson must be a valid JSON object." | |

## Integration Points

| This Feature | Connects To | How | Direction |
|-------------|------------|-----|-----------|
| CostSet.creatorId | User.id | FK reference | Reads |
| Tournament.costSetId | CostSet.id | Tournament reads active cost set | Reads |
| HsrCharacterCost.costSetId | CostSet.id | Live cost rows keyed to set | Writes on publish |
| HsrLightconeCost.costSetId | CostSet.id | Live cost rows keyed to set | Writes on publish |
| HsrSynergyCost.costSetId | CostSet.id | Live cost rows keyed to set | Writes on publish |
| CostSetDraftCharacter/Lightcone/Synergy | CostSet.id | Draft rows private per set | Writes on edit |

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| Cost set lock→unpublish→delete lifecycle | Phase 3 CONTEXT.md | 2026-03-17 |
| costSetId=0 is protected default set | Phase 3 CONTEXT.md | 2026-03-17 |
| Draft tables are private (public: false) | Phase 3 CONTEXT.md | 2026-03-17 |
| Per-user views for draft access | Phase 3 execution | 2026-03-19 |
| Clone-from-source filters by gameMode | Phase 3 execution | 2026-03-19 |
| Publish is atomic (all 3 live tables + draft cleanup in one transaction) | Phase 3 execution | 2026-03-19 |
| Full lifecycle verified: create→edit→publish→lock→unpublish→delete | Phase 3 execution | 2026-03-19 |
| Default protection verified on all 3 lifecycle reducers | Phase 3 execution | 2026-03-19 |
| Full hydration from codebase — Reducers section added | Phase 13 normalization | 2026-04-09 |
| `edit_draft_{character,lightcone}_cost` args: replaced `classicCostsJson`+`auctionBaseBidJson` with `costsJson`+`draftModeTag`; one call = one row per `(name, gameMode, draftMode, costSetId)` (D-16, D-17, D-18, REQ-154-06) | Phase 15.4 execution | 2026-04-15 |
| `edit_draft_synergy_cost` args: added `draftModeTag`; one call = one row per `(source, target, gameMode, draftMode, costSetId)` (D-16, D-17, D-18, REQ-154-06) | Phase 15.4 execution | 2026-04-15 |
| `publish_cost_set` copies BOTH Classic and Auction draft rows to live tables (Pitfall 7 regression guard locked by `test/backend/cost-sets/cost-set-lifecycle.test.ts`) | Phase 15.4 execution | 2026-04-15 |
| `draftMode` column added to all 6 cost tables; PK tuples extended by `draftMode`; reducer tuple match uses A2_FALLBACK_ITER (SpacetimeDB 2.1.0 enum-struct btree limitation) — extends Phase 15.1 precedent | Phase 15.4 execution | 2026-04-15 |
| First-ever Auction synergy rows seeded (D-13 zero-value default on default seed set) | Phase 15.4 execution | 2026-04-15 |
| Synergy auction round-trip test coverage added: `test/backend/cost-sets/synergy-auction-round-trip.test.ts` (D-25a) | Phase 15.4 execution | 2026-04-15 |
| `ensureSelectableCostSet` (exists, published, not locked; id 0 passes) + loose `doesCostSetCover` at every selection site; `delete_cost_set` refuses while a non-Finished lobby or non-terminal tournament references the set; scenarios added | Phase S6 execution (backlog #2, R2, D-D6) | 2026-11-06 |
| Synergy rows name real characters: `admin_bulk_upsert('HsrSynergyCost')` and `edit_draft_synergy_cost` reject a `characterA` / `characterB` with no `HsrCharacter` row ("Character <name> not found."); the two misspelt Trailblazer pairs in `data/seed/synergies.json` are corrected | Phase S10c execution (backend audit 2026-11-09, cross-cutting finding 1) | 2026-11-09 |
| `edit_draft_character_cost` / `_lightcone_cost` / `_synergy_cost`: each cost field must be a finite number from 0 to 100000 and only the documented fields are stored; the synergy modifier is finite and within ±100000; the character or light cone must exist in the reference tables; `gameModeTag` must be the cost set's own game mode and `draftModeTag` Classic or Auction. A re-seed no longer overwrites archetype descriptions | Phase S10f execution (backend audit 2026-11-09, roster findings 9, 10) | 2026-11-09 |
| Prices are read from the lobby's own cost set, game mode and draft mode only: no fallback to the default set, no cross-mode default. An entry with no row there cannot be picked, nominated, bid on, edited with `set_eidolon` or equipped ("<name> has no cost in this lobby's cost set."), on the default set too; the timer's auto-pick and auto-ban pools draw only priced entries; `EMPTY` is always 0; a synergy pair with no row adds no surcharge. The coverage guard reads the same rows and no longer exempts the default set | Phase S10i execution (DECISIONS.md A107, DECISIONS.md A108) | 2026-11-10 |
| Completeness at publish: `view_cost_set_missing(costSetId)` (the set's owner and Moderator+) lists, per draft mode the draft prices, the characters and light cones of the reference tables with no draft row. `publish_cost_set(costSetId, confirmFillMissing?)`: with gaps and no confirmation it is refused ("This cost set has no cost for C characters and L light cones (…). Confirm to publish them at cost 0."); with confirmation the missing entries are written at cost 0 in the draft and the live copy; a draft mode with no rows is neither checked nor filled | Phase S10i execution (DECISIONS.md A107) | 2026-11-10 |
| Patch in place: a published, not locked set keeps an editable draft copy (`edit_draft_*_cost` accepted) and `publish_cost_set` again makes the live rows equal to the draft under the same id (new rows inserted, changed prices replaced, unchanged rows not rewritten, rows absent from the draft deleted), with the same confirmation rule. Refused while a lobby using the set is in Drafting, Equipping or Scoring ("Cannot patch this cost set while N lobbies using it are in Drafting, Equipping or Scoring."); Waiting and AwaitingResult do not block. A locked set ("This cost set is locked; its costs cannot be changed.") and an unpublished one ("This cost set is unpublished; its costs cannot be changed.") refuse edits and publish. Finished and closed games keep their stored costs | Phase S10i execution (DECISIONS.md A107) | 2026-11-10 |
| The default cost set (id 0) is seeded with Auction prices equal to the Classic prices for every character and light cone in all three game modes; synergy rows keep their explicit Auction values. A new cost set is a copy of the default or of a published set, so it starts with both modes. A database published with this module must be re-seeded before Auction lobbies on the default set are accepted | Phase S10i execution (DECISIONS.md A108) | 2026-11-10 |

---

*Last updated: 2026-11-06*
*Feature owner: Phase 3 / Phase 15.4*
