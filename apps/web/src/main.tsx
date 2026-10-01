// zod's CSP setting (jitless) is index.html's classic head script public/zod-jitless.js: it must run before
// the shared chunk that holds zod and the api's schemas, which an import here would not achieve.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'

const el = document.getElementById('root')
if (!el) throw new Error('#root missing')
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
