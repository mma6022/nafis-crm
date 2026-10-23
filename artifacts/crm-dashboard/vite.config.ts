import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';
import { shouldShowRuntimeError } from './dev/runtime-error-filter';

// The browser emits benign ResizeObserver notifications with error=null.
// Preserve their message before the overlay serializes them as "unknown".
// The filter also excludes the specifically identified injected MetaMask rejection.
// Real CRM errors and unknown runtime failures remain visible.
function crmRuntimeErrorOverlay() {
  const overlay = runtimeErrorOverlay({
    filter: shouldShowRuntimeError,
  });
  const original = overlay.transformIndexHtml;
  if (typeof original !== 'function') throw new Error('Unsupported runtime overlay HTML hook');
  return {
    ...overlay,
    async transformIndexHtml(html: string, context: Parameters<typeof original>[1]) {
      const result = await original.call(this, html, context);
      if (!Array.isArray(result)) return result;
      return result.map((tag) => tag.tag === 'script' && typeof tag.children === 'string'
        ? { ...tag, children: tag.children.replace(
          'sendError(evt.error);',
          'sendError(evt.error ?? new Error(evt.message || "(unknown runtime error)"));',
        ) }
        : tag);
    },
  };
}

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    'PORT environment variable is required but was not provided.',
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    'BASE_PATH environment variable is required but was not provided.',
  );
}

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss({ optimize: false }),
    crmRuntimeErrorOverlay(),
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
