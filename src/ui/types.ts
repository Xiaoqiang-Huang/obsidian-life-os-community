import type { ThemeStyle, UiPageKey } from "../settings";

export type UiBreakpoint = "phone" | "compact" | "tablet" | "desktop" | "wide";
export type UiTone = "neutral" | "primary" | "success" | "warning" | "danger";
export type UiSize = "sm" | "md" | "lg";
export type UiDisposer = () => void;

export interface UiResponsiveSnapshot {
  width: number;
  breakpoint: UiBreakpoint;
  isPhone: boolean;
  isCompact: boolean;
  isWide: boolean;
}

export interface UiAction {
  label: string;
  icon?: string;
  ariaLabel?: string;
  primary?: boolean;
  ghost?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  loadingLabel?: string;
  tone?: UiTone;
  size?: UiSize;
  onClick?: (event: MouseEvent) => void | Promise<void>;
}

export type LifeOSAction = UiAction;
export type LifeOSButtonTone = UiTone;
export type LifeOSSizeTier = UiBreakpoint;
export type LifeOSDisposer = UiDisposer;

export type UiThemeGroup =
  | "classic"
  | "glass"
  | "focus"
  | "exam"
  | "anime"
  | "business"
  | "academic"
  | "personal"
  | "night";

export type UiThemeFamily =
  | "glass"
  | "warm"
  | "dark"
  | "business"
  | "notes"
  | "playful"
  | "focus";

export type UiThemeMaterial = "glass" | "mesh" | "matte" | "paper" | "solid" | "ink";
export type UiThemeDensity = "compact" | "normal" | "airy";

export interface UiThemeTokens {
  accent: string;
  accent2: string;
  canvas: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  text: string;
  muted: string;
  shadow: string;
  radius: number;
  mood: string;
}

export interface UiThemeMeta {
  id: ThemeStyle;
  label: string;
  description: string;
  group: UiThemeGroup;
  family: UiThemeFamily;
  material: UiThemeMaterial;
  density: UiThemeDensity;
  recommended?: boolean;
  liquidGlass?: boolean;
  tokens: UiThemeTokens;
}

export interface UiPageShellOptions {
  page: UiPageKey;
  className?: string;
  title?: string;
  subtitle?: string;
}

export interface UiSectionOptions {
  title?: string;
  subtitle?: string;
  icon?: string;
  className?: string;
}
