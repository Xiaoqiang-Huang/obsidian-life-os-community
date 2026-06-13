import {
  getThemeStyleClasses,
  isLiquidGlassDerivedThemeStyle,
  THEME_STYLES,
  type ThemeStyle
} from "../settings";
import type { UiThemeDensity, UiThemeFamily, UiThemeGroup, UiThemeMaterial, UiThemeMeta, UiThemeTokens } from "./types";

interface ThemeMetaSeed {
  label: string;
  description: string;
  group: UiThemeGroup;
  family: UiThemeFamily;
  material: UiThemeMaterial;
  density: UiThemeDensity;
  recommended?: boolean;
  tokens: UiThemeTokens;
}

const THEME_META: Partial<Record<ThemeStyle, ThemeMetaSeed>> = {
  "minimal-warm": theme("Minimal Warm", "Quiet matte warmth for daily use.", {
    group: "classic",
    family: "warm",
    material: "matte",
    density: "airy",
    recommended: true,
    tokens: palette("#b7794f", "#e8c8a0", "#fbf6ef", "#fffaf3", "#fffdf8", "#e8dccd", "#2f261f", "#75685c", "0 10px 24px rgba(183, 121, 79, 0.08)", 16, "calm")
  }),
  "soft-saas": theme("Soft SaaS", "Calm product workspace with restrained utility.", {
    group: "classic",
    family: "focus",
    material: "solid",
    density: "normal",
    recommended: false,
    tokens: palette("#2563eb", "#8bb6ff", "#f5f8ff", "#ffffff", "#edf4ff", "#d6e4ff", "#14213d", "#5b6b85", "0 12px 24px rgba(37, 99, 235, 0.08)", 16, "utility")
  }),
  obsidian: theme("Obsidian", "Native Obsidian feeling with softer plugin chrome.", {
    group: "classic",
    family: "focus",
    material: "solid",
    density: "normal",
    recommended: false,
    tokens: palette("#8b5cf6", "#b496ff", "#f4f1ff", "#ffffff", "#f0eaff", "#ddd2ff", "#211a38", "#645c7b", "0 12px 30px rgba(111, 76, 190, 0.12)", 18, "native")
  }),
  compact: theme("Compact", "Dense layout tuned for narrow panes.", {
    group: "focus",
    family: "focus",
    material: "solid",
    density: "compact",
    recommended: false,
    tokens: palette("#0f766e", "#5fc3bb", "#eef9f8", "#f9fffd", "#ebfaf7", "#b8e4de", "#12231f", "#536561", "0 10px 20px rgba(15, 118, 110, 0.08)", 14, "dense")
  }),
  "liquid-glass": theme("LiquidGlass", "Shader-inspired liquid refraction, chromatic edge light, and layered glass depth.", {
    group: "glass",
    family: "glass",
    material: "glass",
    density: "airy",
    recommended: true,
    tokens: palette("#16a3ff", "#78f0ff", "#eef9ff", "rgba(255,255,255,0.54)", "rgba(255,255,255,0.78)", "rgba(255,255,255,0.5)", "#10233d", "#54708c", "0 24px 68px rgba(22, 163, 255, 0.22)", 28, "liquidglass")
  }),
  "refractive-glass": theme("Refractive Glass", "Sharper liquid refraction with bright edge highlights.", {
    group: "glass",
    family: "glass",
    material: "glass",
    density: "airy",
    recommended: true,
    tokens: palette("#2f7cff", "#18c8ff", "#f7fcff", "rgba(255,255,255,0.58)", "rgba(255,255,255,0.86)", "rgba(128,190,255,0.34)", "#0d2440", "#55708d", "0 24px 64px rgba(47, 124, 255, 0.16)", 26, "refraction")
  }),
  "mesh-sunset": theme("Sunset Mesh", "Warm sunset gradients with soft lift.", {
    group: "glass",
    family: "playful",
    material: "mesh",
    density: "airy",
    recommended: true,
    tokens: palette("#fb7185", "#f59e0b", "#fff5ed", "rgba(255,255,255,0.7)", "rgba(255,251,247,0.86)", "rgba(252,180,143,0.36)", "#2f1d2b", "#7b5d66", "0 18px 40px rgba(251, 113, 133, 0.18)", 20, "warm")
  }),
  "mesh-aurora": theme("Aurora Mesh", "Blue-violet aurora with clean shimmer.", {
    group: "glass",
    family: "playful",
    material: "mesh",
    density: "airy",
    recommended: false,
    tokens: palette("#7c3aed", "#89e6ff", "#f5f4ff", "rgba(255,255,255,0.72)", "rgba(252,250,255,0.88)", "rgba(167,139,250,0.3)", "#21183c", "#645c84", "0 20px 42px rgba(124, 58, 237, 0.18)", 22, "vivid")
  }),
  "mesh-mint": theme("Mint Mesh", "Cool mint glow with fresh contrast.", {
    group: "glass",
    family: "playful",
    material: "mesh",
    density: "airy",
    recommended: false,
    tokens: palette("#14b8a6", "#5fd6c8", "#effdf9", "rgba(255,255,255,0.74)", "rgba(251,255,254,0.9)", "rgba(116,224,212,0.3)", "#12312d", "#5a746f", "0 18px 40px rgba(20, 184, 166, 0.16)", 22, "fresh")
  }),
  "mesh-deep-blue": theme("Deep Blue Mesh", "Cool deep-focus canvas with broad glow.", {
    group: "glass",
    family: "focus",
    material: "mesh",
    density: "normal",
    recommended: false,
    tokens: palette("#2563eb", "#93c5fd", "#eef5ff", "rgba(255,255,255,0.74)", "rgba(252,254,255,0.9)", "rgba(96,165,250,0.26)", "#10213f", "#586b88", "0 18px 42px rgba(37, 99, 235, 0.16)", 20, "deep")
  }),
  "blue-white-gradient": theme("Blue White Gradient", "White canvas with calm blue gradient depth.", {
    group: "glass",
    family: "glass",
    material: "mesh",
    density: "airy",
    recommended: true,
    tokens: palette("#2563eb", "#38bdf8", "#f8fbff", "rgba(255,255,255,0.82)", "rgba(255,255,255,0.94)", "rgba(147,197,253,0.32)", "#10213f", "#5d708c", "0 18px 44px rgba(37, 99, 235, 0.12)", 22, "blue-white")
  }),
  "mesh-dreamy": theme("Dreamy Mesh", "Dreamy mesh glow with floating atmosphere.", {
    group: "glass",
    family: "glass",
    material: "mesh",
    density: "airy",
    recommended: false,
    tokens: palette("#7c5cff", "#7de6d1", "#f8f7ff", "rgba(255,255,255,0.72)", "rgba(255,255,255,0.9)", "rgba(160,150,220,0.28)", "#301333", "#745f80", "0 18px 48px rgba(124, 92, 255, 0.16)", 24, "dreamy")
  }),
  "mesh-sea-mist": theme("Sea Mist", "Quiet coastal green with foggy depth.", {
    group: "glass",
    family: "glass",
    material: "mesh",
    density: "normal",
    recommended: true,
    tokens: palette("#0d9488", "#c4f5ed", "#effcf8", "rgba(255,255,255,0.72)", "rgba(252,255,254,0.9)", "rgba(113,203,190,0.28)", "#0f2f2b", "#587470", "0 18px 40px rgba(13, 148, 136, 0.15)", 22, "quiet")
  }),
  "focus-ink": theme("Focus Ink", "Writing-first contrast with editorial calm.", {
    group: "focus",
    family: "focus",
    material: "ink",
    density: "normal",
    recommended: true,
    tokens: palette("#334155", "#94a3b8", "#f8fafc", "#ffffff", "#f1f5f9", "#cbd5e1", "#0f172a", "#64748b", "0 12px 28px rgba(51, 65, 85, 0.1)", 16, "ink")
  }),
  "exam-green": theme("Exam Green", "Structured study mode with clear progress cues.", {
    group: "exam",
    family: "focus",
    material: "solid",
    density: "compact",
    recommended: true,
    tokens: palette("#16a34a", "#86efac", "#f2fbf4", "#fbfffc", "#eefbf0", "#b7dfc2", "#10261a", "#557166", "0 12px 26px rgba(22, 163, 74, 0.1)", 14, "study")
  }),
  "research-cobalt": theme("Research Cobalt", "Academic blue tuned for focused analysis.", {
    group: "academic",
    family: "focus",
    material: "solid",
    density: "normal",
    recommended: true,
    tokens: palette("#2563eb", "#9aa7ff", "#f4f7ff", "#ffffff", "#eef3ff", "#cdd9ff", "#111d38", "#5f6f93", "0 14px 28px rgba(37, 99, 235, 0.1)", 16, "research")
  }),
  "creator-coral": theme("Creator Coral", "Warm creative canvas with optimistic punch.", {
    group: "personal",
    family: "playful",
    material: "solid",
    density: "normal",
    recommended: false,
    tokens: palette("#f97316", "#fb923c", "#fff7ed", "#ffffff", "#fff1e7", "#ffd5bb", "#2f1d13", "#84604b", "0 14px 28px rgba(249, 115, 22, 0.12)", 18, "creative")
  }),
  "finance-graphite": theme("Finance Graphite", "Muted dashboard clarity for metrics.", {
    group: "business",
    family: "business",
    material: "solid",
    density: "compact",
    recommended: false,
    tokens: palette("#475569", "#94a3b8", "#f8fafc", "#ffffff", "#f2f5f8", "#d5dde6", "#111827", "#5b6474", "0 12px 24px rgba(71, 85, 105, 0.1)", 14, "finance")
  }),
  "family-orchard": theme("Family Orchard", "Gentle home records with soft greens.", {
    group: "personal",
    family: "warm",
    material: "matte",
    density: "airy",
    recommended: false,
    tokens: palette("#65a30d", "#bef264", "#fbfff0", "#fffef8", "#f4fbdf", "#dbe8bf", "#1f2a12", "#69745b", "0 12px 26px rgba(101, 163, 13, 0.1)", 18, "home")
  }),
  "night-owl": theme("Night Owl", "GitHub-dark engineering contrast for night work.", {
    group: "night",
    family: "dark",
    material: "solid",
    density: "compact",
    recommended: true,
    tokens: palette("#58a6ff", "#388bfd", "#0d1117", "#161b22", "#21262d", "#30363d", "#f0f6fc", "#c9d1d9", "0 16px 38px rgba(1, 4, 9, 0.42)", 16, "night")
  }),
  "midnight-terminal": theme("Midnight Terminal", "Retro phosphor terminal for focused night sessions.", {
    group: "night",
    family: "dark",
    material: "ink",
    density: "compact",
    recommended: true,
    tokens: palette("#34d399", "#fbbf24", "#07120d", "#0e1b14", "#13261d", "#1f4738", "#e6fff2", "#8fbba1", "0 18px 42px rgba(0, 0, 0, 0.42)", 10, "terminal")
  }),
  "mood-lavender": theme("Mood Lavender", "Soft mood journaling with diffused light.", {
    group: "personal",
    family: "playful",
    material: "matte",
    density: "airy",
    recommended: false,
    tokens: palette("#a855f7", "#d8b4fe", "#faf5ff", "#fff9ff", "#f4ebff", "#e4d4fb", "#29163f", "#715f8f", "0 14px 28px rgba(168, 85, 247, 0.12)", 18, "mood")
  }),
  "field-notes": theme("Field Notes", "Paper-note capture with tactile structure.", {
    group: "classic",
    family: "notes",
    material: "paper",
    density: "normal",
    recommended: false,
    tokens: palette("#2d5f73", "#c47a3c", "#f5eddc", "#fff8e7", "#fffbef", "#d8c7a4", "#2f2a20", "#6f6654", "3px 4px 0 rgba(80, 65, 35, 0.12)", 8, "notes")
  }),
  "studio-mono": theme("Studio Mono", "High-contrast monochrome studio mode.", {
    group: "focus",
    family: "focus",
    material: "solid",
    density: "compact",
    recommended: false,
    tokens: palette("#525252", "#a3a3a3", "#fafafa", "#ffffff", "#f3f4f6", "#d4d4d8", "#171717", "#5f5f66", "0 10px 22px rgba(23, 23, 23, 0.12)", 12, "mono")
  }),
  "anime-sakura": theme("Anime Sakura", "Soft sakura palette with playful blush.", {
    group: "anime",
    family: "playful",
    material: "mesh",
    density: "airy",
    recommended: true,
    tokens: palette("#fb7185", "#93c5fd", "#fff1f5", "#fff9fb", "#fff1f7", "#f7c7d6", "#3b1720", "#846574", "0 16px 32px rgba(251, 113, 133, 0.14)", 18, "sakura")
  }),
  "anime-cyber-pop": theme("Anime Cyber Pop", "Neon action UI with bright pulse.", {
    group: "anime",
    family: "playful",
    material: "solid",
    density: "compact",
    recommended: false,
    tokens: palette("#06b6d4", "#f472b6", "#f0f9ff", "#ffffff", "#e5fcff", "#bdefff", "#082f49", "#586d81", "0 16px 32px rgba(6, 182, 212, 0.15)", 18, "pop")
  }),
  "anime-moonlit": theme("Anime Moonlit", "Moonlit blue-violet storybook night.", {
    group: "anime",
    family: "dark",
    material: "ink",
    density: "normal",
    recommended: false,
    tokens: palette("#6366f1", "#8b5cf6", "#11182d", "#182341", "#202c4f", "#53638f", "#eef2ff", "#c2caef", "0 18px 38px rgba(17, 24, 45, 0.32)", 18, "moon")
  }),
  "anime-sunrise": theme("Anime Sunrise", "Warm sunrise energy with soft paper glow.", {
    group: "anime",
    family: "glass",
    material: "paper",
    density: "compact",
    recommended: false,
    tokens: palette("#ff7a59", "#ffb86b", "#fff3e8", "#fffaf6", "#fff3ea", "#ffd0bd", "#35231c", "#84665b", "0 12px 28px rgba(255, 122, 89, 0.16)", 18, "sunrise")
  }),
  "anime-shonen-flame": theme("Anime Flame", "High-energy red-orange action theme.", {
    group: "anime",
    family: "playful",
    material: "solid",
    density: "compact",
    recommended: false,
    tokens: palette("#ef4444", "#f59e0b", "#fff1f2", "#fff9f8", "#ffe8ea", "#fecdd3", "#450a0a", "#7f4c4c", "0 16px 32px rgba(239, 68, 68, 0.16)", 16, "action")
  }),
  "business-navy": theme("Business Navy", "Corporate navy with firm hierarchy.", {
    group: "business",
    family: "business",
    material: "solid",
    density: "compact",
    recommended: true,
    tokens: palette("#d6a84f", "#b98224", "#f4f7fb", "#ffffff", "#f7fafc", "#d8e0eb", "#102033", "#62748a", "0 8px 18px rgba(7, 24, 39, 0.18)", 14, "formal")
  }),
  "business-slate": theme("Business Slate", "Neutral executive slate with quiet contrast.", {
    group: "business",
    family: "business",
    material: "solid",
    density: "compact",
    recommended: false,
    tokens: palette("#475569", "#94a3b8", "#f1f5f9", "#ffffff", "#f5f7fa", "#cbd5e1", "#0f172a", "#64748b", "0 8px 18px rgba(71, 85, 105, 0.14)", 14, "slate")
  }),
  "brutalist-signal": theme("Brutalist Signal", "Industrial slabs with alert accents and hard edges.", {
    group: "business",
    family: "business",
    material: "solid",
    density: "compact",
    recommended: false,
    tokens: palette("#f59e0b", "#111827", "#faf2df", "#fff9ed", "#f4ddba", "#1f2937", "#171717", "#5f564b", "8px 8px 0 rgba(17, 24, 39, 0.12)", 6, "signal")
  }),
  "academic-paper": theme("Academic Paper", "Calm paper reading surface.", {
    group: "academic",
    family: "notes",
    material: "paper",
    density: "airy",
    recommended: true,
    tokens: palette("#0f766e", "#c8a867", "#fffdf7", "#fffdf7", "#fffaf0", "#e6dcc7", "#1f2937", "#6b7280", "0 10px 26px rgba(15, 118, 110, 0.08)", 14, "paper")
  }),
  "academic-ink": theme("Academic Ink", "Dark paper reading with annotation cues.", {
    group: "academic",
    family: "dark",
    material: "ink",
    density: "normal",
    recommended: false,
    tokens: palette("#9aa7ff", "#d6b36a", "#111318", "#191c23", "#20242d", "#343946", "#f3efe7", "#c9c1b4", "0 14px 36px rgba(0, 0, 0, 0.32)", 14, "ink")
  }),
  "editorial-sand": theme("Editorial Sand", "Warm editorial paper with serif rhythm and airy margins.", {
    group: "academic",
    family: "notes",
    material: "paper",
    density: "airy",
    recommended: true,
    tokens: palette("#8c4a2f", "#d2a65a", "#f7f0e4", "#fff9f0", "#efe1c8", "#d4c0a1", "#2f261c", "#76624d", "0 16px 34px rgba(92, 74, 53, 0.12)", 10, "editorial")
  }),
  "apple-frosted": theme("Apple Frosted", "Frosted Apple-style translucency.", {
    group: "glass",
    family: "glass",
    material: "glass",
    density: "airy",
    recommended: true,
    tokens: palette("#38bdf8", "#99f6ff", "#f8fcff", "rgba(255,255,255,0.74)", "rgba(255,255,255,0.9)", "rgba(140,205,255,0.3)", "#172033", "#5b6b7c", "0 18px 42px rgba(56, 189, 248, 0.15)", 24, "frost")
  })
};

export const UI_THEME_REGISTRY: Record<ThemeStyle, UiThemeMeta> = THEME_STYLES.reduce((registry, id) => {
  const seed = THEME_META[id] ?? theme(toTitle(id), "Life OS theme.", {
    group: "classic",
    family: "focus",
    material: "solid",
    density: "normal",
    recommended: false,
    tokens: palette("#3b82f6", "#93c5fd", "#f8fbff", "#ffffff", "#eff6ff", "#dbe5f3", "#172033", "#5c6b7b", "0 12px 24px rgba(59, 130, 246, 0.1)", 16, "default")
  });
  registry[id] = {
    id,
    ...seed,
    liquidGlass: isLiquidGlassDerivedThemeStyle(id)
  };
  return registry;
}, {} as Record<ThemeStyle, UiThemeMeta>);

export function getUiThemeMeta(themeStyle: ThemeStyle | string | null | undefined): UiThemeMeta {
  const normalized = THEME_STYLES.includes(themeStyle as ThemeStyle) ? (themeStyle as ThemeStyle) : "minimal-warm";
  return UI_THEME_REGISTRY[normalized] ?? UI_THEME_REGISTRY["minimal-warm"];
}

export function getUiThemeClassNames(themeStyle: ThemeStyle): string[] {
  return getThemeStyleClasses(themeStyle);
}

export function getRecommendedUiThemes(): UiThemeMeta[] {
  return THEME_STYLES.map((id) => getUiThemeMeta(id)).filter((meta) => meta.recommended === true);
}

export function getMoreUiThemes(): UiThemeMeta[] {
  return THEME_STYLES.map((id) => getUiThemeMeta(id)).filter((meta) => meta.recommended !== true);
}

export function getUiThemeGroups(): UiThemeGroup[] {
  return Array.from(new Set(THEME_STYLES.map((id) => getUiThemeMeta(id).group)));
}

export function getUiThemeFamilies(): UiThemeFamily[] {
  return Array.from(new Set(THEME_STYLES.map((id) => getUiThemeMeta(id).family)));
}

export function getUiThemesByFamily(family: UiThemeFamily): UiThemeMeta[] {
  return THEME_STYLES.map((id) => getUiThemeMeta(id)).filter((meta) => meta.family === family);
}

function theme(
  label: string,
  description: string,
  seed: {
    group: UiThemeGroup;
    family: UiThemeFamily;
    material: UiThemeMaterial;
    density: UiThemeDensity;
    recommended: boolean;
    tokens: UiThemeTokens;
  }
): ThemeMetaSeed {
  return { label, description, ...seed };
}

function palette(
  accent: string,
  accent2: string,
  canvas: string,
  surface: string,
  surfaceRaised: string,
  border: string,
  text: string,
  muted: string,
  shadow: string,
  radius: number,
  mood: string
): UiThemeTokens {
  return { accent, accent2, canvas, surface, surfaceRaised, border, text, muted, shadow, radius, mood };
}

function toTitle(value: string): string {
  return value.split("-").map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(" ");
}
