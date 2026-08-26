import { useMemo, useState } from 'react'
import { useCorrectionDictionary } from './CorrectionDictionaryContext'
import { useTranscript } from '../transcript/TranscriptContext'
import { useMedia } from '../media/MediaContext'
import { findCorrectionMatches, applyMatchesToSegments } from './applyCorrections'
import type { CorrectionCategory, CorrectionMatch } from '@shared/transcription'

const CATEGORIES: Array<{ value: CorrectionCategory; label: string }> = [
  { value: 'person', label: 'Person' },
  { value: 'place', label: 'Place' },
  { value: 'company', label: 'Company' },
  { value: 'technical', label: 'Technical term' },
  { value: 'spelling', label: 'Khmer spelling' },
  { value: 'capitalization', label: 'Capitalization' },
  { value: 'other', label: 'Other' }
]

interface Props {
  onClose: () => void
  prefillOriginal?: string
}

export function CorrectionDictionaryModal({ onClose, prefillOriginal }: Props): JSX.Element {
  const { entries, addEntry, updateEntry, removeEntry, exportToFile, importFromFile } = useCorrectionDictionary()
  const { transcripts, updateSegmentText } = useTranscript()
  const { selectedId } = useMedia()

  const [search, setSearch] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formOriginal, setFormOriginal] = useState(prefillOriginal ?? '')
  const [formCorrection, setFormCorrection] = useState('')
  const [formCategory, setFormCategory] = useState<CorrectionCategory>('other')
  const [formLanguage, setFormLanguage] = useState<'km' | 'en' | 'mixed'>('mixed')

  const [previewMatches, setPreviewMatches] = useState<CorrectionMatch[] | null>(null)
  const [undoSnapshot, setUndoSnapshot] = useState<Map<string, string> | null>(null)
  const [importExportMessage, setImportExportMessage] = useState<string | null>(null)

  const transcript = selectedId ? transcripts[selectedId] : undefined

  const filteredEntries = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return entries
    return entries.filter(
      (e) => e.original.toLowerCase().includes(term) || e.correction.toLowerCase().includes(term)
    )
  }, [entries, search])

  const resetForm = (): void => {
    setEditingId(null)
    setFormOriginal('')
    setFormCorrection('')
    setFormCategory('other')
    setFormLanguage('mixed')
  }

  const handleSubmit = async (): Promise<void> => {
    if (!formOriginal.trim() || !formCorrection.trim()) return
    if (editingId) {
      await updateEntry(editingId, {
        original: formOriginal.trim(),
        correction: formCorrection.trim(),
        category: formCategory,
        language: formLanguage
      })
    } else {
      await addEntry(formOriginal.trim(), formCorrection.trim(), formCategory, formLanguage)
    }
    resetForm()
  }

  const handleEdit = (id: string): void => {
    const entry = entries.find((e) => e.id === id)
    if (!entry) return
    setEditingId(id)
    setFormOriginal(entry.original)
    setFormCorrection(entry.correction)
    setFormCategory(entry.category)
    setFormLanguage(entry.language)
  }

  const handlePreview = (): void => {
    if (!transcript) return
    setPreviewMatches(findCorrectionMatches(transcript.segments, entries))
  }

  const handleApply = (): void => {
    if (!transcript || !previewMatches || previewMatches.length === 0 || !selectedId) return
    const snapshot = new Map<string, string>()
    for (const seg of transcript.segments) {
      if (previewMatches.some((m) => m.segmentId === seg.id)) {
        snapshot.set(seg.id, seg.editedText ?? seg.text)
      }
    }
    const updatedTextBySegment = applyMatchesToSegments(transcript.segments, previewMatches)
    for (const [segmentId, newText] of updatedTextBySegment) {
      updateSegmentText(selectedId, segmentId, newText)
    }
    setUndoSnapshot(snapshot)
    setPreviewMatches(null)
  }

  const handleUndo = (): void => {
    if (!undoSnapshot || !selectedId) return
    for (const [segmentId, previousText] of undoSnapshot) {
      updateSegmentText(selectedId, segmentId, previousText)
    }
    setUndoSnapshot(null)
  }

  const handleExport = async (): Promise<void> => {
    const result = await exportToFile()
    if (!result.canceled) setImportExportMessage(`Exported to ${result.filePath}`)
  }

  const handleImport = async (mode: 'merge' | 'replace'): Promise<void> => {
    const result = await importFromFile(mode)
    if (!result.canceled) setImportExportMessage(`Imported ${result.count ?? 0} entries (${mode})`)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-panel dictionary-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Correction Dictionary</h2>
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="dictionary-form">
          <input placeholder="Incorrect term" value={formOriginal} onChange={(e) => setFormOriginal(e.target.value)} lang="km" />
          <input
            placeholder="Corrected term"
            value={formCorrection}
            onChange={(e) => setFormCorrection(e.target.value)}
            lang="km"
          />
          <select value={formCategory} onChange={(e) => setFormCategory(e.target.value as CorrectionCategory)}>
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <select value={formLanguage} onChange={(e) => setFormLanguage(e.target.value as 'km' | 'en' | 'mixed')}>
            <option value="km">Khmer</option>
            <option value="en">English</option>
            <option value="mixed">Mixed</option>
          </select>
          <button onClick={() => void handleSubmit()} disabled={!formOriginal.trim() || !formCorrection.trim()}>
            {editingId ? 'Save' : 'Add'}
          </button>
          {editingId && <button onClick={resetForm}>Cancel</button>}
        </div>

        <div className="dictionary-toolbar">
          <input placeholder="Search entries…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button onClick={() => void handleExport()}>Export JSON…</button>
          <button onClick={() => void handleImport('merge')}>Import (merge)…</button>
          <button onClick={() => void handleImport('replace')}>Import (replace)…</button>
        </div>
        {importExportMessage && <div className="dictionary-message">{importExportMessage}</div>}

        <ul className="dictionary-list">
          {filteredEntries.map((entry) => (
            <li key={entry.id} className={`dictionary-entry${entry.enabled ? '' : ' dictionary-entry-disabled'}`}>
              <label className="dictionary-enable-toggle">
                <input
                  type="checkbox"
                  checked={entry.enabled}
                  onChange={(e) => void updateEntry(entry.id, { enabled: e.target.checked })}
                />
              </label>
              <span className="dictionary-entry-text" lang="km">
                <span className="dictionary-original">{entry.original}</span>
                {' → '}
                <span className="dictionary-correction">{entry.correction}</span>
              </span>
              <span className="dictionary-category">{entry.category}</span>
              <span className="dictionary-applied-count">{entry.timesApplied}×</span>
              <button onClick={() => handleEdit(entry.id)}>Edit</button>
              <button onClick={() => void removeEntry(entry.id)}>Delete</button>
            </li>
          ))}
          {filteredEntries.length === 0 && <li className="dictionary-empty">No entries yet.</li>}
        </ul>

        <div className="dictionary-apply-section">
          <h3>Apply to current transcript</h3>
          {!transcript && <p className="placeholder">No transcript loaded for the selected media.</p>}
          {transcript && (
            <>
              <button onClick={handlePreview}>Preview matches</button>
              {previewMatches && (
                <div className="dictionary-preview">
                  <p>
                    {previewMatches.length} match{previewMatches.length === 1 ? '' : 'es'} found.
                  </p>
                  {previewMatches.length > 0 && (
                    <>
                      <ul className="dictionary-preview-list">
                        {previewMatches.slice(0, 20).map((m, i) => (
                          <li key={i}>
                            <span lang="km">{m.original}</span> → <span lang="km">{m.correction}</span>
                          </li>
                        ))}
                        {previewMatches.length > 20 && <li>…and {previewMatches.length - 20} more</li>}
                      </ul>
                      <button onClick={handleApply}>
                        Apply {previewMatches.length} replacement{previewMatches.length === 1 ? '' : 's'}
                      </button>
                    </>
                  )}
                </div>
              )}
              {undoSnapshot && <button onClick={handleUndo}>Undo last apply</button>}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
