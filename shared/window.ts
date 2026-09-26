export const WINDOW_IPC = {
  minimize: 'window:minimize',
  maximizeToggle: 'window:maximizeToggle',
  close: 'window:close',
  isMaximized: 'window:isMaximized',
  /** Home is a small centred window (CapCut's launcher); the editor is
   * maximised. The renderer switches as the Home screen opens/closes. */
  setMode: 'window:setMode',
  maximizedChanged: 'window:maximizedChanged'
} as const
