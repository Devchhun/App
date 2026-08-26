import { getSharedWorker } from './workerProcess'
import type { ScriptAlignmentSegment, TranscriptWord } from '@shared/transcription'

export async function alignScript(scriptText: string, words: TranscriptWord[]): Promise<ScriptAlignmentSegment[]> {
  const worker = getSharedWorker()
  await worker.ensureStarted()
  const { promise } = worker.send('align', { scriptText, words })
  return (await promise) as ScriptAlignmentSegment[]
}
