declare module 'ffmpeg-static' {
  const ffmpegPath: string
  export default ffmpegPath
}

declare module 'ffprobe-static' {
  interface FfprobeStatic {
    path: string
  }
  const ffprobeStatic: FfprobeStatic
  export default ffprobeStatic
}
