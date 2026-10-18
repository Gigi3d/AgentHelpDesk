import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'VITE_');
  return {
    plugins: [react()],
    // GitHub Pages serves the site under /AgentHelpDesk/; the desk serves it at /.
    base: env.VITE_BASE ?? '/',
    server: { port: 5180 },
  };
});
