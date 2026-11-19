import { defineConfig, loadEnv, type Plugin } from 'vite';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

/**
 * Published example sites keep their Mapbox token out of git as "__MAPBOX_TOKEN__";
 * the build writes in VITE_MAPBOX_TOKEN (from .env.local, or the repo variable on GitHub).
 */
function exampleToken(token: string): Plugin {
  const files = ['examples/thompsons-yard.html'];
  return {
    name: 'allto-example-token',
    // Built site
    closeBundle() {
      for (const f of files) {
        const p = resolve(__dirname, 'dist', f);
        if (existsSync(p) && token) writeFileSync(p, readFileSync(p, 'utf8').replaceAll('__MAPBOX_TOKEN__', token));
      }
    },
    // Dev server
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const f = files.find((x) => req.url?.split('?')[0].endsWith('/' + x));
        if (!f || !token) return next();
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(readFileSync(resolve(__dirname, 'public', f), 'utf8').replaceAll('__MAPBOX_TOKEN__', token));
      });
    },
  };
}

// One site, several pages. The consultation editor lives in public/ and is served as-is.
// Relative base so the build works at any path (e.g. GitHub Pages /allto/).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, 'VITE_');
  return {
    base: './',
    plugins: [exampleToken(env.VITE_MAPBOX_TOKEN ?? '')],
    build: {
      rollupOptions: {
        input: {
          home: resolve(__dirname, 'index.html'),
          present: resolve(__dirname, 'present/index.html'),
          ultrahand: resolve(__dirname, 'ultrahand/index.html'),
        },
      },
    },
  };
});
