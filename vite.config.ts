import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // relative base so the build works at any URL, including GitHub Pages project sites
  base: './',
})
