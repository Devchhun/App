// Pure logic for building/editing a StoryVisualTheme (Section 6: visual
// continuity rules) -- kept separate from StoryContext.tsx/StoryVisualsPanel.tsx
// so the "how do entity colors become a shared theme" logic is directly
// testable without React.
import type { NarrativeEntity, StoryVisualTheme } from '@shared/story'

/** Seeds a default theme from a freshly-analyzed graph's entities: each
 * entity's own AI-proposed color becomes its theme color, so the very first
 * generation already has real per-entity continuity (not a placeholder to
 * fill in later). Everything else uses sensible fixed defaults matching the
 * app's existing dark cinematic look. */
export function buildDefaultStoryTheme(entities: readonly NarrativeEntity[]): StoryVisualTheme {
  const entityColors: Record<string, string> = {}
  for (const entity of entities) {
    entityColors[entity.id] = entity.color
  }
  return {
    entityColors,
    characterAssets: {},
    lineStyle: 'solid',
    lineWidth: 2,
    glowIntensity: 50,
    backgroundMode: 'transparent',
    animationIntensity: 50,
    khmerFont: 'Noto Sans Khmer',
    latinFont: 'Segoe UI'
  }
}

/** Adds default colors for any entity the theme doesn't already know about
 * (a merge-in after re-analysis), without touching colors the user already
 * customized for entities the theme already has. */
export function mergeEntitiesIntoTheme(theme: StoryVisualTheme, entities: readonly NarrativeEntity[]): StoryVisualTheme {
  const entityColors = { ...theme.entityColors }
  let changed = false
  for (const entity of entities) {
    if (!(entity.id in entityColors)) {
      entityColors[entity.id] = entity.color
      changed = true
    }
  }
  return changed ? { ...theme, entityColors } : theme
}

/** One entity's color changed in the Entity Bible or Continuity panel --
 * updates the theme so every SUBSEQUENT generation reflects it. Never
 * rewrites Scenes already generated under the old color (see
 * StoryVisualsPanel.tsx's "Regenerate" action for that). */
export function setThemeEntityColor(theme: StoryVisualTheme, entityId: string, color: string): StoryVisualTheme {
  return { ...theme, entityColors: { ...theme.entityColors, [entityId]: color } }
}
