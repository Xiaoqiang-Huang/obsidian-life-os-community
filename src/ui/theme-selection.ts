import { normalizeThemeStyle, type PersonalLifeSystemSettings, type ThemeStyle } from "../settings";

type ThemeChoice = Pick<PersonalLifeSystemSettings, "themeStyle" | "uiAppearance">;
interface ThemeHost {
  settings: PersonalLifeSystemSettings;
  applyTheme(): void;
  saveSettings(themeRevision?: number): Promise<void>;
  saveData(data: PersonalLifeSystemSettings): Promise<void>;
}
interface SelectionState {
  revision: number; pending: number; confirmed: ThemeChoice; tail: Promise<void>;
  rejected?: { revision: number; attempted: ThemeChoice; restored: ThemeChoice };
}
const selections = new WeakMap<ThemeHost, SelectionState>();
const choice = (host: ThemeHost): ThemeChoice => ({ themeStyle: host.settings.themeStyle, uiAppearance: host.settings.uiAppearance });
function stateFor(host: ThemeHost): SelectionState {
  let state = selections.get(host);
  if (!state) {
    state = { revision: 0, pending: 0, confirmed: choice(host), tail: Promise.resolve() };
    selections.set(host, state);
  }
  return state;
}

/** Non-theme controls must not accidentally persist an optimistic theme that failed. */
export function persistSettingsSnapshot(host: ThemeHost, themeRevision?: number): Promise<void> {
  const state = stateFor(host), snapshot = structuredClone(host.settings), revision = state.revision;
  const save = state.tail.then(async () => {
    const failed = state.rejected;
    if (themeRevision === undefined && failed?.revision === revision) {
      if (snapshot.themeStyle === failed.attempted.themeStyle) snapshot.themeStyle = failed.restored.themeStyle;
      if (snapshot.uiAppearance === failed.attempted.uiAppearance) snapshot.uiAppearance = failed.restored.uiAppearance;
    }
    try {
      await host.saveData(snapshot);
      // The confirmed baseline is the last successful disk snapshot, including
      // appearance changes made by ordinary settings controls between selections.
      state.confirmed = { themeStyle: snapshot.themeStyle, uiAppearance: snapshot.uiAppearance };
    } catch (error) {
      if (themeRevision !== undefined) state.rejected = { revision: themeRevision,
        attempted: { themeStyle: snapshot.themeStyle, uiAppearance: snapshot.uiAppearance }, restored: { ...state.confirmed } };
      throw error;
    }
  });
  state.tail = save.catch(() => undefined);
  return save;
}

/** Paint synchronously; persistence is ordered by the host, never by render completion. */
export async function persistThemeSelection(host: ThemeHost, value: ThemeStyle): Promise<{ current: boolean; error?: unknown }> {
  const state = stateFor(host);
  if (!state.pending) state.confirmed = choice(host);
  const revision = ++state.revision;
  state.pending++;
  host.settings.themeStyle = normalizeThemeStyle(value);
  host.settings.uiAppearance = "theme";
  const selected = choice(host);
  host.applyTheme();
  try {
    // saveSettings captures a snapshot at invocation, including unrelated settings.
    await host.saveSettings(revision);
    return { current: state.revision === revision };
  } catch (error) {
    if (state.revision === revision) {
      // Preserve a separate appearance control changed while the save was pending.
      if (host.settings.themeStyle === selected.themeStyle) host.settings.themeStyle = state.confirmed.themeStyle;
      if (host.settings.uiAppearance === selected.uiAppearance) host.settings.uiAppearance = state.confirmed.uiAppearance;
      host.applyTheme();
    }
    return { current: state.revision === revision, error };
  } finally {
    state.pending--;
  }
}
