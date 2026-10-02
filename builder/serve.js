/**
 * @file serve.js
 * @description Servidor de desenvolvimento com fallback SPA.
 *
 * Por que existe: abrir `dist/index.html` via `file://` funciona (o bundle é
 * único e autocontido), mas o roteador usa History API — recarregar a página em
 * `/config` exige que o servidor devolva o `index.html` para rotas
 * desconhecidas. `python -m http.server` responde 404 nesses casos, quebrando o
 * reload e qualquer teste E2E de persistência.
 *
 * Uso:
 *   node builder/serve.js            # porta 8080
 *   node builder/serve.js --port 3000
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const DIST_DIR = path.resolve(__dirname, '../dist');
const INDEX_FILE = path.join(DIST_DIR, 'index.html');

/** Mapa de extensão → Content-Type. */
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
};

/**
 * Lê a porta da linha de comando.
 * @returns {number}
 */
function readPort() {
    const index = process.argv.indexOf('--port');
    const raw = index >= 0 ? process.argv[index + 1] : process.env.PORT;
    const port = Number.parseInt(raw ?? '8080', 10);

    return Number.isFinite(port) && port > 0 && port < 65536 ? port : 8080;
}

const PORT = readPort();

const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://localhost:${PORT}`);

    // Sanitiza o path para impedir traversal (ex: `/../../etc/passwd`).
    const requested = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(DIST_DIR, requested);

    if (!filePath.startsWith(DIST_DIR)) {
        response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('403 Proibido');
        return;
    }

    /** @param {string} target */
    const sendFile = (target) => {
        const extension = path.extname(target).toLowerCase();
        const contentType = MIME_TYPES[extension] ?? 'application/octet-stream';

        fs.readFile(target, (error, content) => {
            if (error) {
                response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                response.end('500 Erro interno');
                return;
            }

            response.writeHead(200, {
                'Content-Type': contentType,
                // Sem cache: o dev server deve sempre refletir o último build.
                'Cache-Control': 'no-store',
            });
            response.end(content);
        });
    };

    fs.stat(filePath, (error, stats) => {
        if (!error && stats.isFile()) {
            sendFile(filePath);
            return;
        }

        // Fallback SPA: qualquer rota desconhecida devolve o index.html e o
        // roteador client-side resolve o caminho.
        if (fs.existsSync(INDEX_FILE)) {
            sendFile(INDEX_FILE);
            return;
        }

        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('404 — Execute "npm run build" antes de servir.');
    });
});

server.listen(PORT, () => {
    console.log(`\n  Digital Store Pro v5 — servidor de desenvolvimento`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  Servindo: ${DIST_DIR}`);
    console.log(`  Fallback SPA: ativo (rotas como /config funcionam no reload)\n`);
});
