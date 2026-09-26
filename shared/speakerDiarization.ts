import type {
  DetectedSpeakerProfile,
  SpeakerAgeCategory,
  SpeakerDiarizationObservation,
  SpeakerGender
} from './transcription'

const DEFAULT_SIMILARITY_THRESHOLD = 0.82

export function normalizeEmbedding(values: number[]): number[] {
  const finite = values.map((value) => (Number.isFinite(value) ? value : 0))
  const norm = Math.sqrt(finite.reduce((sum, value) => sum + value * value, 0))
  return norm > 1e-9 ? finite.map((value) => value / norm) : finite.map(() => 0)
}

export function embeddingSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length)
  if (length === 0) return 0
  const na = normalizeEmbedding(a)
  const nb = normalizeEmbedding(b)
  let dot = 0
  for (let i = 0; i < length; i++) dot += na[i] * nb[i]
  return Math.max(-1, Math.min(1, dot))
}

function meanEmbedding(embeddings: number[][]): number[] {
  const dimension = Math.max(0, ...embeddings.map((embedding) => embedding.length))
  if (dimension === 0) return []
  const mean = Array.from({ length: dimension }, () => 0)
  for (const embedding of embeddings) {
    for (let i = 0; i < dimension; i++) mean[i] += embedding[i] ?? 0
  }
  return normalizeEmbedding(mean.map((value) => value / embeddings.length))
}

export function predictGender(f0Hz: number | undefined, voicedRatio: number): { gender: SpeakerGender; confidence: number } {
  if (!f0Hz || voicedRatio < 0.15) return { gender: 'unknown', confidence: 0 }
  const distance = Math.min(1, Math.abs(f0Hz - 165) / 75)
  const confidence = Math.min(0.92, voicedRatio * 0.55 + distance * 0.35)
  if (confidence < 0.35) return { gender: 'unknown', confidence }
  return { gender: f0Hz < 165 ? 'male' : 'female', confidence }
}

/** Age is intentionally conservative: acoustics overlap heavily across age
 * groups. Ambiguous input stays Unknown and every prediction carries its
 * confidence so the UI never presents this heuristic as a fact. */
export function predictAge(f0Hz: number | undefined, voicedRatio: number, spectralCentroidHz?: number): { ageCategory: SpeakerAgeCategory; confidence: number } {
  if (!f0Hz || voicedRatio < 0.2) return { ageCategory: 'unknown', confidence: 0 }
  const centroid = spectralCentroidHz ?? 0
  if (f0Hz >= 280 && centroid >= 1500) return { ageCategory: 'child', confidence: Math.min(0.78, 0.42 + voicedRatio * 0.3) }
  if (f0Hz >= 220 && centroid >= 1350) return { ageCategory: 'young', confidence: Math.min(0.62, 0.3 + voicedRatio * 0.25) }
  if (f0Hz <= 95 && centroid > 0 && centroid < 1150) return { ageCategory: 'elder', confidence: Math.min(0.58, 0.28 + voicedRatio * 0.25) }
  return { ageCategory: 'adult', confidence: Math.min(0.5, 0.22 + voicedRatio * 0.2) }
}

interface Cluster {
  observations: SpeakerDiarizationObservation[]
  centroid: number[]
}

/** Online centroid clustering followed by a centroid merge pass. Only voice
 * embeddings determine identity; pitch/gender/age are computed afterward
 * and cannot cause two people to merge. */
export function clusterSpeakerObservations(
  observations: SpeakerDiarizationObservation[],
  similarityThreshold = DEFAULT_SIMILARITY_THRESHOLD
): { speakers: DetectedSpeakerProfile[]; assignmentBySegmentId: Record<string, { speakerId: string; confidence: number }> } {
  const usable = observations.filter((observation) => observation.embedding.length > 0)
  const clusters: Cluster[] = []

  for (const observation of usable) {
    const embedding = normalizeEmbedding(observation.embedding)
    let bestIndex = -1
    let bestSimilarity = -1
    for (let index = 0; index < clusters.length; index++) {
      const similarity = embeddingSimilarity(embedding, clusters[index].centroid)
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity
        bestIndex = index
      }
    }
    if (bestIndex >= 0 && bestSimilarity >= similarityThreshold) {
      clusters[bestIndex].observations.push({ ...observation, embedding })
      clusters[bestIndex].centroid = meanEmbedding(clusters[bestIndex].observations.map((item) => item.embedding))
    } else {
      clusters.push({ observations: [{ ...observation, embedding }], centroid: embedding })
    }
  }

  // Join clusters that fragmented before their centroid had enough samples.
  for (let left = 0; left < clusters.length; left++) {
    for (let right = clusters.length - 1; right > left; right--) {
      if (embeddingSimilarity(clusters[left].centroid, clusters[right].centroid) < similarityThreshold + 0.03) continue
      clusters[left].observations.push(...clusters[right].observations)
      clusters[left].centroid = meanEmbedding(clusters[left].observations.map((item) => item.embedding))
      clusters.splice(right, 1)
    }
  }

  const assignmentBySegmentId: Record<string, { speakerId: string; confidence: number }> = {}
  const speakers = clusters.map((cluster, index): DetectedSpeakerProfile => {
    const id = `speaker-${index + 1}`
    const f0Values = cluster.observations.map((item) => item.f0Hz).filter((value): value is number => Boolean(value))
    const f0Hz = f0Values.length ? f0Values.sort((a, b) => a - b)[Math.floor(f0Values.length / 2)] : undefined
    const voicedRatio = cluster.observations.reduce((sum, item) => sum + item.voicedRatio, 0) / cluster.observations.length
    const centroids = cluster.observations.map((item) => item.spectralCentroidHz).filter((value): value is number => Boolean(value))
    const spectralCentroidHz = centroids.length ? centroids.reduce((sum, value) => sum + value, 0) / centroids.length : undefined
    const gender = predictGender(f0Hz, voicedRatio)
    const age = predictAge(f0Hz, voicedRatio, spectralCentroidHz)
    const similarities = cluster.observations.map((item) => Math.max(0, embeddingSimilarity(item.embedding, cluster.centroid)))
    const identityConfidence = similarities.reduce((sum, value) => sum + value, 0) / similarities.length
    for (let observationIndex = 0; observationIndex < cluster.observations.length; observationIndex++) {
      const observation = cluster.observations[observationIndex]
      assignmentBySegmentId[observation.segmentId] = { speakerId: id, confidence: similarities[observationIndex] }
    }
    return {
      id,
      name: `Speaker ${index + 1}`,
      gender: gender.gender,
      genderConfidence: gender.confidence,
      ageCategory: age.ageCategory,
      ageConfidence: age.confidence,
      identityConfidence,
      embedding: cluster.centroid,
      segmentIds: cluster.observations.map((item) => item.segmentId)
    }
  })

  return { speakers, assignmentBySegmentId }
}
