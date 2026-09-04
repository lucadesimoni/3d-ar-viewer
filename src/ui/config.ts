/**
 * UI configuration — makes the app flexible: full workstation, compact, a
 * stripped-down guide, or a bare embeddable viewer.
 *
 * The same build serves all of them. A host chooses the shape three ways, in
 * increasing specificity: a preset, then individual panel toggles, then a couple
 * of look controls (density, accent). Config arrives from a React prop (Mendix
 * widget or any React host), from URL query params (an `<iframe>` embed), or the
 * defaults — so embedding never needs a separate bundle.
 */

export type UiPreset = 'full' | 'compact' | 'minimal' | 'viewer';
export type UiDensity = 'comfortable' | 'compact';

export interface UiConfig {
  preset: UiPreset;
  /** Fill the host container instead of the full viewport; trims fixed chrome. */
  embedded: boolean;
  density: UiDensity;
  /** Brand accent (CSS colour). Overrides the default cyan when set. */
  accent?: string;

  // Panel visibility — each can be forced on/off over the preset default.
  showHeader: boolean;
  showSteps: boolean;
  showDiagnostics: boolean;
  showModeBar: boolean;
  showInspector: boolean;
  showDrawers: boolean;
  showAssemblyPicker: boolean;
  showRecognition: boolean;
  showRecognitionBanner: boolean;
}

type PanelFlags = Omit<UiConfig, 'preset' | 'embedded' | 'density' | 'accent'>;

const ALL_ON: PanelFlags = {
  showHeader: true,
  showSteps: true,
  showDiagnostics: true,
  showModeBar: true,
  showInspector: true,
  showDrawers: true,
  showAssemblyPicker: true,
  showRecognition: true,
  showRecognitionBanner: true,
};

/**
 * What each preset turns on. Presets set panel *defaults*; explicit overrides
 * (prop or URL) still win, so e.g. `minimal` + `showDiagnostics=1` is valid.
 */
const PRESETS: Record<UiPreset, PanelFlags> = {
  full: { ...ALL_ON },
  // Everything, but denser and without the assembly picker / drawers clutter.
  compact: { ...ALL_ON, showDrawers: false, showAssemblyPicker: false },
  // A focused operator guide: the 3D view, the active step, recognition. No
  // side panels or mode bar.
  minimal: {
    showHeader: false,
    showSteps: true,
    showDiagnostics: false,
    showModeBar: false,
    showInspector: false,
    showDrawers: false,
    showAssemblyPicker: false,
    showRecognition: true,
    showRecognitionBanner: true,
  },
  // Bare embeddable canvas: just the viewer and the on-part recognition tint.
  viewer: {
    showHeader: false,
    showSteps: false,
    showDiagnostics: false,
    showModeBar: false,
    showInspector: false,
    showDrawers: false,
    showAssemblyPicker: false,
    showRecognition: true,
    showRecognitionBanner: false,
  },
};

export const DEFAULT_UI_CONFIG: UiConfig = {
  preset: 'full',
  embedded: false,
  density: 'comfortable',
  ...ALL_ON,
};

const isPreset = (v: string | null): v is UiPreset =>
  v === 'full' || v === 'compact' || v === 'minimal' || v === 'viewer';

/**
 * Resolve a full config from a partial one: start at the preset's panel
 * defaults, then apply any explicit fields the caller set.
 */
export function resolveUiConfig(partial: Partial<UiConfig> = {}): UiConfig {
  const preset: UiPreset = partial.preset ?? 'full';
  const base = PRESETS[preset];
  const merged: UiConfig = {
    ...DEFAULT_UI_CONFIG,
    ...base,
    preset,
  };
  // Apply only the fields explicitly provided (ignore undefined).
  for (const [k, v] of Object.entries(partial) as [keyof UiConfig, unknown][]) {
    if (v !== undefined) (merged as unknown as Record<string, unknown>)[k] = v;
  }
  return merged;
}

const parseBool = (v: string | null): boolean | undefined => {
  if (v === null) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(v.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(v.toLowerCase())) return false;
  return undefined;
};

/**
 * Build a partial config from URL query params, for iframe embedding, e.g.
 * `/?ui=minimal&embedded=1&accent=%23ff7a00&diagnostics=0&steps=1`.
 *
 * Short param aliases map to the `show*` flags; `panels=a,b,c` is an alternative
 * that turns *only* the listed panels on (over the preset).
 */
export function parseUiConfigFromParams(search: string): Partial<UiConfig> {
  const p = new URLSearchParams(search);
  const out: Partial<UiConfig> = {};

  const ui = p.get('ui') ?? p.get('preset');
  if (isPreset(ui)) out.preset = ui;
  if (parseBool(p.get('embedded')) !== undefined) out.embedded = parseBool(p.get('embedded'));
  const density = p.get('density');
  if (density === 'compact' || density === 'comfortable') out.density = density;
  const accent = p.get('accent');
  if (accent) out.accent = accent;

  const aliases: Record<string, keyof PanelFlags> = {
    header: 'showHeader',
    steps: 'showSteps',
    diagnostics: 'showDiagnostics',
    modebar: 'showModeBar',
    inspector: 'showInspector',
    drawers: 'showDrawers',
    picker: 'showAssemblyPicker',
    recognition: 'showRecognition',
    banner: 'showRecognitionBanner',
  };
  for (const [param, key] of Object.entries(aliases)) {
    const b = parseBool(p.get(param));
    if (b !== undefined) (out as Record<string, unknown>)[key] = b;
  }

  // panels=steps,diagnostics turns exactly those on and the rest off.
  const panels = p.get('panels');
  if (panels) {
    const set = new Set(panels.split(',').map((s) => s.trim().toLowerCase()));
    for (const [param, key] of Object.entries(aliases)) {
      (out as Record<string, unknown>)[key] = set.has(param);
    }
  }

  return out;
}
