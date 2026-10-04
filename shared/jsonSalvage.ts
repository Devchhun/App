/** Every COMPLETE object in the JSON array under `key`, even when the text
 * stops part-way through (an answer cut off by the output limit, or a
 * repetition loop that ran into it). Walks the characters tracking string
 * and nesting state; an object that never closed is simply not returned.
 * The whole answer is otherwise thrown away over its last half-written
 * scene -- measured with this model on Auto SRT, a run that ends like that
 * is what "Gemini returned invalid JSON" was. */
export function extractCompleteArrayItems(text: string, key: string): unknown[] {
  const keyMatch = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(text)
  if (!keyMatch) return []
  const items: unknown[] = []
  let depth = 0
  let inString = false
  let escaped = false
  let objectStart = -1
  for (let i = keyMatch.index + keyMatch[0].length; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') {
      if (depth === 0) objectStart = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && objectStart >= 0) {
        try {
          items.push(JSON.parse(text.slice(objectStart, i + 1)))
        } catch {
          // A malformed object ends the usable part.
          break
        }
        objectStart = -1
      }
    } else if (ch === ']' && depth === 0) break
  }
  return items
}
