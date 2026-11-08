import { table, t } from 'spacetimedb/server';
import { TeamSide } from '@module/types/enums';
import { DraftStep, TimerState } from '@module/types/structs';

export const matchSessionColumns = {
    lobbyId: t.u32().primaryKey(),

    // The current index into the 'draftSequence' array (0-based)
    turnIndex: t.u32(),

    // The generated script for this match (e.g. [Ban Blue, Ban Red, Pick Blue...])
    draftSequence: t.array(DraftStep),

    // Tracks turn timers, reserves, and pause state
    timerState: TimerState,

    // Auction state (per D-49, replaces teamBlueBudget/teamRedBudget):
    isAuctionPhase: t.bool(),
    nextNominatorTeam: TeamSide,
    blueCharactersWon: t.u8(),
    redCharactersWon: t.u8(),
    currentNomination: t.string().optional(),
    currentBidAmount: t.f32().optional(),
    currentBidTeam: TeamSide,  // Use Spectator as sentinel for "no bid"

    // Split budgets:
    teamBlueCharBudget: t.f32(),
    teamRedCharBudget: t.f32(),
    teamBlueLcBudget: t.f32(),
    teamRedLcBudget: t.f32(),

    // Pause tracking (per D-61):
    pausesUsedBlue: t.u8(),
    pausesUsedRed: t.u8(),

    // A67(3): the series columns are removed; one game per lobby.

    // Audit:
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const MatchSession = table({
    name: 'match_session',
    public: false, // S3 (A37): private, read through views (S9)
    // 1-to-1 relationship with Lobby: The Lobby ID is the Primary Key
}, matchSessionColumns);