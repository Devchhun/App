// Windows refuses to start a process whose command line is longer than
// 32,767 characters ("spawn ENAMETOOLONG"). An hour of AI Manga pictures
// exported in one run made a filter graph longer than that. ffmpeg can read a
// filter graph from a file instead (6.1, the bundled build: the
// "-filter_complex_script" / "-filter_script:v|a" options), so the longest
// graphs move into files until the line fits.

/** Comfortably under Windows' 32,767, leaving room for ffmpeg's own path. */
export const MAX_COMMAND_CHARS = 30_000

/** Each option whose value is a filter graph, and the option that reads the
 * same graph from a file. */
const SCRIPT_OPTION: Record<string, string> = {
  '-filter_complex': '-filter_complex_script',
  '-lavfi': '-filter_complex_script',
  '-vf': '-filter_script:v',
  '-filter:v': '-filter_script:v',
  '-af': '-filter_script:a',
  '-filter:a': '-filter_script:a'
}

/** About how long the Windows command line for `args` is (each argument
 * quoted and separated by a space). */
export function commandLength(program: string, args: string[]): number {
  return [program, ...args].reduce((sum, arg) => sum + arg.length + 3, 0)
}

/** `args` as it fits on a command line: the longest filter graphs written
 * out with `writeScript` (which returns the file's path) and read from
 * there. Unchanged when it already fits. */
export function fitCommandLine(program: string, args: string[], writeScript: (graph: string) => string, limit = MAX_COMMAND_CHARS): string[] {
  const out = [...args]
  if (commandLength(program, out) <= limit) return out
  const graphs = out
    .map((arg, i) => ({ i, option: arg, value: out[i + 1] }))
    .filter((g) => SCRIPT_OPTION[g.option] && typeof g.value === 'string')
    .sort((a, b) => b.value.length - a.value.length)
  for (const g of graphs) {
    if (commandLength(program, out) <= limit) break
    out[g.i] = SCRIPT_OPTION[g.option]
    out[g.i + 1] = writeScript(g.value)
  }
  return out
}
