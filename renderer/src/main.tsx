import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './ErrorBoundary'
import { applyTheme, readStoredTheme } from './nav/themePrefs'
import './styles.css'

// Applied before the first render so the app never paints one frame in the
// wrong theme and then snaps -- it's a single attribute on <html>, so there's
// nothing to wait for React to mount.
applyTheme(readStoredTheme())

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
