import { defineConfig } from 'vite';
import { cpSync } from 'node:fs';

export default defineConfig({
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  build: { target: 'es2022' },
  plugins: [{
    name: 'local-pdf-assets',
    closeBundle() {
      for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
        cpSync(`node_modules/pdfjs-dist/${directory}`, `dist/pdf-assets/${directory}`, { recursive: true });
      }
    },
    configureServer(server) {
      server.middlewares.use('/pdf-assets', async (req, res, next) => {
        const { createReadStream, existsSync } = await import('node:fs');
        const { resolve, sep } = await import('node:path');
        const root = resolve('node_modules/pdfjs-dist');
        const path = resolve(root, `.${decodeURIComponent(req.url.split('?')[0])}`);
        if (!path.startsWith(root + sep) || !existsSync(path)) return next();
        if (path.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
        createReadStream(path).on('error', next).pipe(res);
      });
    },
  }],
});
