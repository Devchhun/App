/** Has playback advanced past the end of whatever's currently being
 * recorded/reviewed (a caption segment or a manual range)? Extracted as its
 * own pure function so the auto-stop-at-boundary behavior in
 * VoiceoverRecorder.tsx's guided "Story Narration" mode is testable without
 * mounting the whole component. */
export function isPastRecordingBound(currentTime: number, boundEnd: number): boolean {
  return currentTime >= boundEnd
}
