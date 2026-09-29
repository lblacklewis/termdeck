import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'

import 'dockview/dist/styles/dockview.css'
import './styles/global.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
