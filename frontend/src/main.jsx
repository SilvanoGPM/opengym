import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { MOBILE } from './lib/mobile.js'
import { setLang } from './lib/i18n.js'
import { useStore } from './store/useStore.js'
import './index.css'

// The chosen language is known synchronously — it comes out of localStorage with the rest of the
// state, before React is even created — but the strings for it are a lazily loaded chunk. Asking
// for them from an effect meant the first paint always happened in English and switched over a
// beat later. Loading the pack first costs one small chunk (~30 kB) and removes the flash; the
// bulky instruction and exercise-name packs are not waited on (see setLang), so this stays quick
// even in the languages whose content packs run to a megabyte.
setLang(useStore.getState().S.lang || 'en').finally(() => {
  createRoot(document.getElementById('root')).render(
    <StrictMode><App /></StrictMode>
  )
})

// Not in the mobile build: the native shell already serves everything from disk.
if (!MOBILE && 'serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {})
}
