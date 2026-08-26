import { getSupportedPresentationModes } from '@shared/templates'
import type { TemplateId, PresentationMode } from '@shared/templates'

export interface TemplateSwitchPatch {
  templateId: TemplateId
  presentationMode: PresentationMode | undefined
  contentTransform: undefined
}

/** Computes what to change when a scene's template is replaced. The bug this
 * fixes: replacing a full-frame Device Compatibility Lineup with Three-Step
 * Presenter Plan kept `presentationMode: 'full-frame'` -- a mode Three-Step
 * doesn't support and never renders correctly in.
 *
 * Rule: an EXPLICIT presentation-mode override survives the switch only if
 * the destination template actually supports that exact mode; otherwise it's
 * cleared so the scene falls back to the destination template's own default
 * (via getEffectivePresentationMode). A mode that was merely inherited from
 * the OLD template's default (i.e. `explicitPresentationMode` is undefined)
 * is never "preserved" -- there was nothing intentional to preserve.
 *
 * contentTransform is always reset: a foreground position/scale tuned for
 * one composition isn't meaningful for a different one. */
export function buildTemplateSwitchPatch(toTemplateId: TemplateId, explicitPresentationMode: PresentationMode | undefined): TemplateSwitchPatch {
  const supported = getSupportedPresentationModes(toTemplateId)
  const keepExplicit = explicitPresentationMode !== undefined && supported.includes(explicitPresentationMode)
  return {
    templateId: toTemplateId,
    presentationMode: keepExplicit ? explicitPresentationMode : undefined,
    contentTransform: undefined
  }
}
