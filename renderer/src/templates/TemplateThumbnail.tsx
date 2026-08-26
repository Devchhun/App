import type { BrandPreset, Scene } from '@shared/project'
import type { TemplateId } from '@shared/templates'
import type { SceneMotion } from './animation'
import type { TemplateDefinition } from './registry'
import { defaultContentForTemplate } from './defaultContent'

const HELD_MOTION: SceneMotion = { visible: true, opacity: 1, enterProgress: 1, exitProgress: 0 }
// Sample scenes run 0-3s; 1.5s sits safely inside every motion preset's hold
// phase (max default enter+exit is 1.3s), so thumbnails show a settled frame
// rather than mid-entrance for any of the internal-motion templates.
const THUMBNAIL_CURRENT_TIME = 1.5

/** Deterministic sample content per template, used only for Library
 * thumbnails/previews -- never persisted, never randomized, so the grid
 * looks identical on every render. */
const SAMPLE_SCENE_OVERRIDES: Partial<Record<TemplateId, Partial<Scene>>> = {
  'lower-third': { visualText: 'Sokha Chan', reason: 'Product Lead' },
  'statistic-callout': { visualText: '3.2M users' },
  'numbered-steps': { visualText: 'Import your video' },
  comparison: { visualText: 'Before vs After' },
  'warning-alert': { visualText: 'Security risk detected' },
  'title-card': { content: { title: 'Getting Started', subtitle: 'A quick overview' } },
  'keyword-highlight': { visualText: 'Ship faster' },
  'percentage-card': { visualText: '72%', content: { title: 'Task completion', value: '72%' } },
  'person-card': { content: { title: 'Dara Pich', subtitle: 'Founder & CEO' } },
  checklist: { content: { items: [{ id: 'a', label: 'Plan' }, { id: 'b', label: 'Build' }, { id: 'c', label: 'Ship' }] } },
  // The heist story runs across the whole scene duration (storyProgress =
  // localTime/duration) rather than a short "enter" window -- shortening
  // just this template's sample duration puts THUMBNAIL_CURRENT_TIME (1.5s)
  // at ~83% of the way through instead of the 50% every other template's
  // 3s sample gets, landing the thumbnail mid-vault-unlock (wheel turning,
  // colors shifting) instead of mid-laser-bypass -- a more representative
  // "hold state" frame for a Library thumbnail than an earlier story beat.
  'vault-break-in-animation': { endTime: 1.8 }
}

function buildSampleScene(templateId: TemplateId): Scene {
  const defaults = defaultContentForTemplate(templateId, `sample-${templateId}`)
  const overrides: Partial<Scene> = {
    ...(defaults ? { visualText: defaults.visualText, content: defaults.content, icon: defaults.icon, background: defaults.background } : {}),
    ...(SAMPLE_SCENE_OVERRIDES[templateId] ?? {})
  }
  return {
    id: `sample-${templateId}`,
    mediaId: 'sample',
    segmentId: 'sample',
    suggestionId: 'sample',
    track: 'V2',
    templateId,
    startTime: 0,
    endTime: 3,
    purpose: 'main_claim',
    originalText: 'Sample text',
    visualText: 'Sample text',
    reason: 'Sample reason',
    confidence: 1,
    locked: false,
    edited: false,
    status: 'accepted',
    createdAt: new Date(0).toISOString(),
    ...overrides
  }
}

interface Props {
  definition: TemplateDefinition
  brand: BrandPreset
}

// The Library grid card is always a fixed 16:9-shaped box (see
// .template-thumb-stage), independent of the project's actual aspect ratio --
// so the cinematic templates' DesignCanvas is always given a matching 16:9
// design canvas here, and a stageSize matching .template-thumb-canvas's
// actual CSS pixel size so their scale math lines up with what's on screen.
const THUMB_STAGE_SIZE = { width: 960, height: 540 }

/** Renders a template's real component (not a static image) at a fixed
 * scale with deterministic sample data -- used by the Template Library grid
 * and hover preview, so thumbnails never drift out of sync with the actual
 * templates. */
export function TemplateThumbnail({ definition, brand }: Props): JSX.Element {
  const scene = buildSampleScene(definition.id)
  const Component = definition.component
  const thumbnailBrand: BrandPreset = { ...brand, defaultAspectRatio: '16:9' }

  return (
    <div className="template-thumb-stage">
      <div className="template-thumb-canvas">
        <Component
          scene={scene}
          brand={thumbnailBrand}
          motion={HELD_MOTION}
          currentTime={THUMBNAIL_CURRENT_TIME}
          stepNumber={2}
          stageSize={THUMB_STAGE_SIZE}
        />
      </div>
    </div>
  )
}
