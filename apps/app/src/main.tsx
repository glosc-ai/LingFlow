import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initializeLingFlowFirebase } from '@lingflow/firebase'
import './index.css'
import App from './App.tsx'

initializeLingFlowFirebase()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
