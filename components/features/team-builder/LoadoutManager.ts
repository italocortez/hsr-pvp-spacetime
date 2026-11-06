// ─── Data shapes ─────────────────────────────────────────────────────

import { Character, CharacterRank, Lightcone, LightconeRank, RuleSet } from "../types/enums";

/** Serialisable team member — stored in localStorage / SpacetimeDB. */
export interface TeamMember {
  characterName: string;       // internal key, e.g. "ruanmei"
  rank: CharacterRank;
  lightconeName?: string;      // internal key, e.g. "pastselfinmirror"
  lightconeRank?: LightconeRank;
}

/** Runtime representation with display names resolved for the UI. */
export interface ResolvedTeamMember extends TeamMember {
  characterDisplayName: string;
  lightconeDisplayName?: string;
}

export interface Loadout {
  name: string;
  team: TeamMember[];
  notes: string;
}

export const TEAM_SIZE = 4;
export const LOADOUT_SLOTS = 3;

// ─── Manager ─────────────────────────────────────────────────────────

class LoadoutManager {
  private static readonly STORAGE_KEY = "honkai_team_loadouts";
  private static readonly LOADOUT_INDEX_KEY = "honkai_current_loadout_index";
  private static readonly RULESET_VIEW_KEY = "honkai_ruleset_view";

  // ── Resolve / unresolve ───────────────────────────────────────────

  static resolveTeamMember(
    member: TeamMember,
    characters: Character[],
    lightcones: Lightcone[],
  ): ResolvedTeamMember | null {
    const character = characters.find(c => c.name === member.characterName);
    if (!character) {
      console.warn(`Character not found: ${member.characterName}`);
      return null;
    }

    let lightconeDisplayName: string | undefined;

    if (member.lightconeName) {
      const lightcone = lightcones.find(l => l.name === member.lightconeName);
      if (lightcone) {
        lightconeDisplayName = lightcone.displayName;
      } else {
        console.warn(`Lightcone not found: ${member.lightconeName}`);
      }
    }

    return {
      ...member,
      characterDisplayName: character.displayName,
      lightconeDisplayName,
    };
  }

  static resolveTeam(
    team: TeamMember[],
    characters: Character[],
    lightcones: Lightcone[],
  ): ResolvedTeamMember[] {
    return team
      .map(m => this.resolveTeamMember(m, characters, lightcones))
      .filter((m): m is ResolvedTeamMember => m !== null);
  }

  static unresolveTeamMember(
    resolved: ResolvedTeamMember,
    _characters: Character[],
    _lightcones: Lightcone[],
  ): TeamMember {
    return {
      characterName: resolved.characterName,
      rank: resolved.rank,
      lightconeName: resolved.lightconeName,
      lightconeRank: resolved.lightconeRank,
    };
  }

  // ── localStorage persistence ──────────────────────────────────────

  static saveLoadouts(loadouts: Loadout[]): void {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(loadouts));
    } catch {
      console.error("Failed to save loadouts");
    }
  }

  static loadLoadouts(): Loadout[] {
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY);
      return stored ? JSON.parse(stored) : this.getDefaultLoadouts();
    } catch {
      console.error("Failed to load loadouts");
      return this.getDefaultLoadouts();
    }
  }

  static getDefaultLoadouts(): Loadout[] {
    return Array.from({ length: LOADOUT_SLOTS }, (_, i) => ({
      name: `Team ${i + 1}`,
      team: [],
      notes: "",
    }));
  }

  static saveCurrentLoadoutIndex(index: number): void {
    if (index < 0 || index >= LOADOUT_SLOTS) return;
    try {
      localStorage.setItem(this.LOADOUT_INDEX_KEY, index.toString());
    } catch {
      console.error("Failed to save loadout index");
    }
  }

  static loadCurrentLoadoutIndex(): number {
    try {
      const stored = localStorage.getItem(this.LOADOUT_INDEX_KEY);
      const index = stored ? parseInt(stored, 10) : 0;
      return index >= 0 && index < LOADOUT_SLOTS ? index : 0;
    } catch {
      return 0;
    }
  }

  static saveRulesetView(ruleSet: RuleSet): void {
    try {
      localStorage.setItem(this.RULESET_VIEW_KEY, ruleSet);
    } catch {
      console.error("Failed to save ruleset view");
    }
  }

  static loadRulesetView(): RuleSet {
    try {
      const stored = localStorage.getItem(this.RULESET_VIEW_KEY);
      return (stored as RuleSet) || "ApocalypticShadow";
    } catch {
      return "ApocalypticShadow";
    }
  }
}

export default LoadoutManager;