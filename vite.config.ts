import { defineConfig } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const projectRoot = process.cwd();

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(projectRoot, 'index.html'),
        planet: resolve(projectRoot, 'planet.html'),
        dive: resolve(projectRoot, 'dive.html'),
      },
    },
  },
  plugins: [{
    name: 'region-scan-progress',
    configureServer(server) {
      server.middlewares.use('/__region-progress', (request, response, next) => {
        if (request.method !== 'POST') {
          next();
          return;
        }
        const address = request.socket.remoteAddress ?? '';
        if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') {
          response.statusCode = 403;
          response.end('Local region progress writes only.');
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        request.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) {
            response.statusCode = 413;
            response.end('Progress snapshot too large.');
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        request.on('end', async () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              final?: boolean;
              regions?: unknown[];
            };
            const root = resolve(server.config.root);
            await mkdir(resolve(root, 'src'), { recursive: true });
            const serialized = `${JSON.stringify(payload.report ?? payload, null, 2)}\n`;
            await writeFile(resolve(root, 'src', 'regions.progress.json'), serialized, 'utf8');
            if (payload.final && Array.isArray(payload.regions)) {
              await writeFile(resolve(root, 'src', 'regions.json'), `${JSON.stringify(payload.regions, null, 2)}\n`, 'utf8');
            }
            response.statusCode = 200;
            response.end('saved');
          } catch (error) {
            response.statusCode = 400;
            response.end(error instanceof Error ? error.message : String(error));
          }
        });
      });
      server.middlewares.use('/__catalogue-evidence', (request, response, next) => {
        if (request.method !== 'POST') {
          next();
          return;
        }
        const address = request.socket.remoteAddress ?? '';
        if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') {
          response.statusCode = 403;
          response.end('Local catalogue evidence writes only.');
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        request.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) {
            response.statusCode = 413;
            response.end('Evidence payload too large.');
            request.destroy();
            return;
          }
          chunks.push(chunk);
        });
        request.on('end', async () => {
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              kind?: string;
              content?: string;
            };
            const root = resolve(server.config.root);
            if (payload.kind === 'tiers' || payload.kind === 'interior') {
              if (typeof payload.content !== 'string') throw new Error('Evidence JSON content is missing.');
              const filename = payload.kind === 'tiers' ? 'regions.tiers.json' : 'regions.interior.json';
              await writeFile(resolve(root, 'src', filename), `${JSON.stringify(JSON.parse(payload.content), null, 2)}\n`, 'utf8');
            } else if (payload.kind === 'contact' || payload.kind === 'tier4') {
              if (typeof payload.content !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/u.test(payload.content)) {
                throw new Error('Evidence PNG payload is invalid.');
              }
              const filename = payload.kind === 'contact' ? 'contact-sheet.png' : 'tier-4-contact-sheet.png';
              const screens = resolve(root, 'screens');
              await mkdir(screens, { recursive: true });
              await writeFile(resolve(screens, filename), Buffer.from(payload.content, 'base64'));
            } else {
              throw new Error('Unknown catalogue evidence kind.');
            }
            response.statusCode = 200;
            response.end('saved');
          } catch (error) {
            response.statusCode = 400;
            response.end(error instanceof Error ? error.message : String(error));
          }
        });
      });
    },
  }],
});
