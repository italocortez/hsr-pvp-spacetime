# 2026-11-17: suspension-s1, the account suspension backend and script commands

## Goal

An account can be suspended by hand and lifted by hand. A suspended account cannot write, cannot read its own data, and cannot sign in with Discord. Backend and command line script only; the suspended screen and the admin page controls are later steps. Nothing is published in this step.

## Decisions implemented

| Decision | Content |
|---|---|
| A195 | Its own step; a suspended account is signed out and can neither read nor write |
| A213 | Visitor browsing stays possible; in a lobby or match the person is treated as absent; Admin only; no reason shown; public traces stay; guests cannot be suspended; script as well as, later, the admin page |
| A214 | No end date, lifted by hand; no self-deletion while suspended; tournament entries untouched; reason optional and for the admins only |
| A215 | An Admin cannot suspend an Admin from the app; the server function can |
| A216 | An Admin cannot change another Admin's role from the app; only the server can |

## What was built

| Part | Content |
|---|---|
| Table | `user_suspension`, private, keyed by user id (reason, who, audit columns) |
| Reducers | `admin_suspend_user`, `admin_lift_suspension`, `server_suspend_user`, `server_lift_suspension` |
| Write check | In `getAuthenticatedUser`, in `resolveUser` of the profile reducers, in `login_as_guest`, `request_link_code`, `confirm_link`; `broadcast_cursor` drops silently |
| Read check | `callerUserId` and the new `callerMapping` in `viewAnonymity.ts` treat a suspended caller as a visitor; every view file goes through them |
| Views | `view_my_suspension` (the caller's own row, user id only), `view_admin_suspensions` (Admin only, with the reason) |
| Sign-in | `planProviderLink` refuses with "This account is suspended." |
| Lobby | The body of `leave_lobby` moved unchanged into `helpers/lobby/memberLeave.ts`; a suspension reuses it and passes host, captain and referee on at once; the lobby-side actor is the SYSTEM user |
| Clean-up | Deletion and ban remove the row; `server_nuke_test_data` clears the table |
| Connect | During maintenance a suspended Admin is refused at connect like a non-admin |
| Role guard (A216) | `admin_update_user` refuses a role change of another Admin |
| Script | `manage-user suspend <username> [--reason <text>]`, `unsuspend <username>`, `suspended`; extra arguments are refused for every command |

## Files changed

- New: `spacetimedb/src/tables/identity/userSuspension.ts`, `helpers/identity/{suspension,suspensionActions}.ts`, `helpers/lobby/memberLeave.ts`, `reducers/admin/suspensionAdmin.ts`, `docs/suspension/{architecture,contract}.md`, six generated binding files.
- Changed, module: `schema.ts`, `index.ts`, `helpers/identity/{ensurePermissions,providerLink,userDeletionHelper,viewAnonymity}.ts`, `reducers/identity/{auth,profile,server}.ts`, `reducers/lobby/{cursor,lobbyLifecycle}.ts`, `reducers/admin/admin.ts`, `views/{costSetViews,identityViews,lobbyViews,matchHistoryViews,matchResultViews,tournamentViews}.ts`.
- Changed, other: `scripts/stdb/manage-user.ts`, generated bindings, `docs/{admin,auth,lobby,views}/architecture.md`, `docs/admin/contract.md`, `docs/ERD.md`.

## Tests (T-tasks of this step)

| File | Cases | Note |
|---|---|---|
| `spacetimedb/src/__tests__/identity/suspension.test.ts` | 41 | new |
| `spacetimedb/src/__tests__/identity/suspension-structure.test.ts` | 3 | new; pins every place where the caller's identity is read in views, helpers and reducers, so a new one that bypasses the shared helpers fails |
| `spacetimedb/src/__tests__/admin/admin-role-guard.test.ts` | 5 | new (A216) |
| `spacetimedb/src/__tests__/calendar/match-events-former-staff.test.ts` | line 101 | changed: the test's set-up demoted an Admin through the app, which A216 now refuses; it demotes through the server reducer instead. What the test asserts is unchanged |

## Done-check (orchestrator's own run)

| Gate | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint:ci` | pass |
| `npm run check:patterns` | all eleven gates pass |
| Unit | 1029 passed |
| Module | 2362 passed, 1 skipped, 15 todo (was 2313) |
| Web | 1336 passed |

## Review

Fable 5.2, report in `tmp/suspension/review-s1.md` (local). No blocker; 2 should-fix and 9 minor, all fixed in the fix pass. The reviewer swept all reducers and views itself and compared the moved Leave logic line for line with the previous commit. The fix pass (the review items, the list view and command, A216) was accepted on the orchestrator's gate run and reading of the new view and guard, without a second review.

## Deviations and notes

- The builder split the helper into two files to avoid an import cycle with the lobby helpers.
- Behaviour as ruled, worth knowing: roles pass on at once and can land on an offline member; in a 1v1 the captain flag stays on the suspended player; in a live Ranked match the opponent can claim the forfeit after the usual grace.
- Not provable in memory, to check on the test database after the publish: a connected client's own data emptying at once; the egress of one suspend and one lift for other clients; the script's three commands, which have never run; the delegate reading `view_admin_suspensions`.
- Open, later T-task: add `view_my_suspension` and `view_admin_suspensions` to `test/live/outsider-isolation.test.ts`.

## Doc checklist

| Feature | Architecture | Contract |
|---|---|---|
| `docs/suspension/` | new | new |
| `docs/admin/` | updated | updated (A216) |
| `docs/auth/`, `docs/lobby/`, `docs/views/` | updated | skip: no scenario of theirs changed; the suspension contract holds the new ones |
| `docs/ERD.md` | updated | n/a |

## Usage

| Phase | Agent | Tokens | Tool calls | Time |
|---|---|---|---|---|
| Research (earlier) | Opus | 268,516 | 67 | 7 min |
| Build | Opus | 362,491 | 172 | 14 min |
| Review | Fable 5.2 | 263,348 | 51 | 10 min |
| Fix pass, review items and list view | Opus | 223,287 | 95 | 8 min |
| Fix pass resumed, A216 (cumulative figure 247,227 tokens, 118 calls) | Opus | 23,940 | 23 | 3 min |
| Total | | 1,141,582 | 408 | 42 min |
