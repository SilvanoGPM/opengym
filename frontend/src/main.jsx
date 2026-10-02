import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { MOBILE } from './lib/mobile.js'
import { useStore } from './store/useStore.js'
import { startMediaSync } from './lib/media-sync.js'
import { startNativeKeyboard } from './lib/native-keyboard.js'
import { setLang, baseLang } from './lib/i18n.js'
import { effectiveLang } from './lib/default-lang.js'
import './index.css'

// App.jsx restores per-route scroll itself; the browser's own attempt races it.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'

// The chosen language is known synchronously — it comes out of localStorage with the rest of the
// state, before React is even created — but the strings for it are a lazily loaded chunk. Asking
// for them from an effect meant the first paint always happened in English and switched over a
// beat later. Loading the pack first costs one small chunk (~30 kB) and removes the flash; the
// bulky instruction and exercise-name packs are not waited on (see setLang), so this stays quick
// even in the languages whose content packs run to a megabyte. Worked out exactly as App.jsx does,
// so its own setLang finds the language already applied and returns at once.
const boot = useStore.getState().S
const bootLang = effectiveLang(boot, useStore.getState().config)
setLang(bootLang, boot.enParens?.[baseLang(bootLang)] ?? true, boot.enOnly?.[baseLang(bootLang)] === true).finally(() => {
  createRoot(document.getElementById('root')).render(
    <StrictMode><App /></StrictMode>
  )
})

// The photos and videos of custom exercises, in every build (the phone and the demo included):
// uploads of what the server lacks, the local clean-up, and the plan's files kept offline.
startMediaSync(useStore)

// Android 15 does not resize the page for the soft keyboard; the app says how much it covers and
// this keeps the focused field above it. Idle everywhere else.
startNativeKeyboard()

// Not in the mobile build: the native shell already serves everything from disk.
if (!MOBILE && 'serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {})
  // The plan's exercise media, kept by the worker for a workout opened without a network (#281).
  // It only fetches ahead while the page runs as the installed app; a tab keeps what it has shown.
  import('./lib/media-prefetch.js').then(m => m.startMediaPrefetch(useStore)).catch(() => {})
}
