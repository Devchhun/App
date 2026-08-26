import { useMemo, useState } from 'react'
import type { TemplateIconId, TemplateIconCategory } from '@shared/templates'
import { TEMPLATE_ICON_IDS, TEMPLATE_ICON_CATEGORY, TEMPLATE_ICON_CATEGORY_LABELS } from '@shared/templates'
import { TemplateIcon, TEMPLATE_ICON_LABELS } from './templateIcons'
import { loadRecentIcons, pushRecentIcon } from './recentIcons'

interface Props {
  value?: TemplateIconId
  onSelect: (id: TemplateIconId) => void
  onRemove: () => void
}

const CATEGORY_OPTIONS: TemplateIconCategory[] = Array.from(new Set(Object.values(TEMPLATE_ICON_CATEGORY)))

/** Searchable icon grid for Properties > Design > Icon. Search, category
 * filter, recently-used, and a clear empty state -- all local UI state
 * (never undoable, never part of the project file). */
export function IconPicker({ value, onSelect, onRemove }: Props): JSX.Element {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<TemplateIconCategory | 'all'>('all')
  const [recent, setRecent] = useState<TemplateIconId[]>(() => loadRecentIcons())

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return TEMPLATE_ICON_IDS.filter((id) => {
      if (category !== 'all' && TEMPLATE_ICON_CATEGORY[id] !== category) return false
      if (term && !TEMPLATE_ICON_LABELS[id].toLowerCase().includes(term) && !id.includes(term)) return false
      return true
    })
  }, [search, category])

  const handlePick = (id: TemplateIconId): void => {
    onSelect(id)
    setRecent(pushRecentIcon(id))
  }

  const showRecent = recent.length > 0 && !search.trim() && category === 'all'

  return (
    <div className="icon-picker">
      <div className="icon-picker-controls">
        <input
          className="icon-picker-search"
          placeholder="Search icons…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && (
          <button className="inline-link-button" onClick={() => setSearch('')}>
            Clear
          </button>
        )}
      </div>

      <select
        className="icon-picker-category"
        value={category}
        onChange={(e) => setCategory(e.target.value as TemplateIconCategory | 'all')}
      >
        <option value="all">All categories</option>
        {CATEGORY_OPTIONS.map((c) => (
          <option key={c} value={c}>
            {TEMPLATE_ICON_CATEGORY_LABELS[c]}
          </option>
        ))}
      </select>

      {showRecent && (
        <div className="icon-picker-recent">
          <div className="icon-picker-section-title">Recently used</div>
          <div className="icon-picker-grid">
            {recent.map((id) => (
              <button
                key={`recent-${id}`}
                className={id === value ? 'icon-picker-cell icon-picker-cell-selected' : 'icon-picker-cell'}
                title={TEMPLATE_ICON_LABELS[id]}
                onClick={() => handlePick(id)}
              >
                <TemplateIcon id={id} size={18} />
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="icon-picker-grid">
        {filtered.map((id) => (
          <button
            key={id}
            className={id === value ? 'icon-picker-cell icon-picker-cell-selected' : 'icon-picker-cell'}
            title={TEMPLATE_ICON_LABELS[id]}
            onClick={() => handlePick(id)}
          >
            <TemplateIcon id={id} size={18} />
          </button>
        ))}
        {filtered.length === 0 && <p className="placeholder icon-picker-empty">No icons match "{search}".</p>}
      </div>

      {value && (
        <button className="inline-link-button icon-picker-remove" onClick={onRemove}>
          Remove icon
        </button>
      )}
    </div>
  )
}
