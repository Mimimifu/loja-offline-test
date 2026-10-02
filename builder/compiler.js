/**
 * @file compiler.js
 * @description Orquestrador de build da SPA v5.
 *
 * Pipeline:
 *   1. Limpa `dist/` e `.build/`;
 *   2. Compila o TypeScript para ESM em `.build/` (via `npx tsc`);
 *   3. Resolve o grafo de imports e empacota tudo num bundle único, com
 *      **um escopo por módulo** (ver `bundle()`);
 *   4. Injeta CSS inline + bundle num único `dist/index.html`, executável
 *      offline, inclusive via `file://`.
 *
 * Por que single-file? A v4 publicava `dist/index.html` + `dist/ts/*.js` +
 * `dist/css/*.css`. Ao abrir via `file://`, imports ESM são bloqueados por CORS
 * e o `link rel=stylesheet` apontava para um `style.css` vazio — resultado:
 * página em branco. Um artefato único elimina essa classe inteira de bugs.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const CSS_DIR = path.join(SRC_DIR, 'css');
const BUILD_DIR = path.join(ROOT, '.build');
const DIST_DIR = path.join(ROOT, 'dist');
const TEMPLATE = path.join(__dirname, 'vendor', '_index.html');
const ENTRY = 'main.js';

const STYLES_MARKER = '<!-- STYLES -->';
const SCRIPTS_MARKER = '<!-- SCRIPTS -->';

const log = {
    step: (msg) => console.log(`   -> ${msg}`),
    ok: (msg) => console.log(`%c ${msg}`, 'font-weight: bold; color: #4CAF50;'),
    warn: (msg) => console.warn(`   !! ${msg}`),
};

/* ------------------------------------------------------------------ regex -- */

/** `import { A, B as C } from './x';` — pode ocupar mais de uma linha. */
const IMPORT_FROM_RE = /^[ \t]*import\s+([\s\S]*?)\bfrom\s*(['"])([^'"]+)\2[ \t]*;?[ \t]*$/gm;

/** `import './x';` (efeito colateral, sem bindings). */
const IMPORT_SIDE_EFFECT_RE = /^[ \t]*import\s*(['"])([^'"]+)\1[ \t]*;?[ \t]*$/gm;

/** `export { A, B as C };` */
const EXPORT_NAMED_RE = /^[ \t]*export\s*\{([\s\S]*?)\}[ \t]*;?[ \t]*$/gm;

/** `export (async) (abstract) function|class|const|let|var NAME` */
const EXPORT_DECL_RE = /^([ \t]*)export\s+(async\s+)?(abstract\s+)?(function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;

/** `export default ...` — não usado no projeto; falha explícita se aparecer. */
const EXPORT_DEFAULT_RE = /^[ \t]*export\s+default\b/m;

/* ---------------------------------------------------------------- helpers -- */

/**
 * Remove um diretório de forma recursiva.
 * @param {string} dir
 */
function rmrf(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Cria o diretório (recursivo) caso não exista.
 * @param {string} dir
 */
function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

/** Remove diretórios de artefatos anteriores. */
function clean() {
    rmrf(DIST_DIR);
    rmrf(BUILD_DIR);
    ensureDir(BUILD_DIR);
    ensureDir(DIST_DIR);
}

/** Compila o TypeScript. Lança com a saída do `tsc` em caso de erro. */
function compileTypeScript() {
    try {
        execSync('npx tsc --project tsconfig.json', { cwd: ROOT, stdio: 'pipe' });
    } catch (error) {
        const output = [error.stdout, error.stderr]
            .filter(Boolean)
            .map((buf) => buf.toString())
            .join('\n');
        throw new Error(`Falha na compilação TypeScript:\n${output}`);
    }
}

/**
 * Resolve o caminho real de um import relativo já emitido pelo tsc.
 * @param {string} fromFile Arquivo que contém o import.
 * @param {string} specifier Especificador como escrito (ex: './core/utils').
 * @returns {string} Caminho absoluto do módulo resolvido.
 */
function resolveSpecifier(fromFile, specifier) {
    const base = path.resolve(path.dirname(fromFile), specifier);
    const candidates = [base, `${base}.js`, path.join(base, 'index.js')];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    throw new Error(`Import não resolvido: "${specifier}" (a partir de ${path.relative(ROOT, fromFile)})`);
}

/**
 * Extrai os nomes exportados por um módulo e remove as marcações de `export`.
 *
 * @param {string} code Código JS pós-`tsc`.
 * @returns {{ code: string; exports: string[] }} Código limpo e lista de pares
 *   `"local:exportado"`.
 */
function stripExports(code) {
    if (EXPORT_DEFAULT_RE.test(code)) {
        throw new Error(
            '`export default` não é suportado pelo mini-bundler. ' +
                'Use exportações nomeadas para evitar ambiguidade de nomes no bundle.',
        );
    }

    /** @type {string[]} */
    const exports = [];

    // `export { A, B as C };`
    let cleaned = code.replace(EXPORT_NAMED_RE, (_match, inner) => {
        inner
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
            .forEach((part) => {
                const alias = part.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
                if (alias) {
                    exports.push(`${alias[1]}:${alias[2]}`);
                } else if (/^[A-Za-z_$][\w$]*$/.test(part)) {
                    exports.push(`${part}:${part}`);
                }
            });
        return '';
    });

    // `export function foo`, `export const x`, `export class Bar`, ...
    cleaned = cleaned.replace(EXPORT_DECL_RE, (_match, indent, asyncKw, abstractKw, kind, name) => {
        exports.push(`${name}:${name}`);
        return `${indent}${asyncKw ?? ''}${abstractKw ?? ''}${kind} ${name}`;
    });

    return { code: cleaned, exports: [...new Set(exports)] };
}

/**
 * Reescreve os `import` de um módulo em referências ao namespace do módulo de
 * origem, mantendo os nomes locais intactos.
 *
 * `import { A, B as C } from './x';`  →  `const { A, B: C } = __mN;`
 * `import * as NS from './x';`        →  `const NS = __mN;`
 *
 * Importar o namespace em vez de renomear cada binding é deliberado: renomear
 * exigiria reescrever todas as ocorrências no corpo do módulo, o que quebraria
 * propriedades de objeto homônimas (ex: `{ title }` dentro de `schema.ts`).
 *
 * @param {string} code Código do módulo.
 * @param {string} file Caminho absoluto do módulo.
 * @param {(specifier: string, file: string) => string[]} registerDependency
 *   Callback que registra a dependência e devolve `[varName]` do namespace.
 * @returns {string}
 */
function rewriteImports(code, file, registerDependency) {
    let output = code.replace(IMPORT_FROM_RE, (match, clause, _quote, specifier) => {
        if (!specifier.startsWith('.')) {
            log.warn(`Import externo ignorado em ${path.relative(ROOT, file)}: "${specifier}"`);
            return '';
        }

        const [namespaceVar] = registerDependency(specifier, file);
        const trimmed = clause.trim();

        // `import * as NS from './x';`
        const namespaceImport = trimmed.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
        if (namespaceImport) return `const ${namespaceImport[1]} = ${namespaceVar};`;

        // `import { A, B as C } from './x';`
        const named = trimmed.match(/^\{([\s\S]*)\}$/);
        if (named) {
            const bindings = named[1]
                .split(',')
                .map((part) => part.trim())
                .filter(Boolean)
                .map((part) => {
                    const alias = part.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
                    return alias ? `${alias[1]}: ${alias[2]}` : part;
                })
                .join(', ');

            return `const { ${bindings} } = ${namespaceVar};`;
        }

        // `import Default from './x';` — sintaxe não usada no projeto.
        const defaultImport = trimmed.match(/^([A-Za-z_$][\w$]*)$/);
        if (defaultImport) {
            log.warn(`Import default ignorado em ${path.relative(ROOT, file)}: "${specifier}"`);
            return `const ${defaultImport[1]} = ${namespaceVar}.default;`;
        }

        log.warn(`Import não reconhecido em ${path.relative(ROOT, file)}: "${match.trim()}"`);
        return '';
    });

    output = output.replace(IMPORT_SIDE_EFFECT_RE, (_match, _quote, specifier) => {
        if (!specifier.startsWith('.')) {
            log.warn(`Import externo ignorado em ${path.relative(ROOT, file)}: "${specifier}"`);
            return '';
        }
        const [namespaceVar] = registerDependency(specifier, file);
        // Um import de efeito colateral ainda precisa executar o módulo; como o
        // módulo já roda no bundle, basta referenciar o namespace para não
        // deixar a variável sem uso declarada.
        return `void ${namespaceVar};`;
    });

    return output;
}

/**
 * Empacota o grafo de módulos a partir do entry point.
 *
 * Cada módulo recebe: um objeto de exports próprio e um IIFE exclusivo. Isso
 * evita colisões de nomes de topo entre módulos — por exemplo `MemoryDriver`
 * declarado em três arquivos de teste diferentes, que quebrava o bundle se os
 * corpos fossem concatenados num único escopo.
 *
 * @param {string} entry Caminho absoluto do arquivo de entrada.
 * @returns {{ code: string; modules: number }}
 */
function bundle(entry) {
    const moduleIds = new Map();
    const ordered = [];
    const inProgress = new Set();
    const visited = new Set();

    /** @returns {string} Nome da variável de namespace do módulo. */
    function idFor(file) {
        if (!moduleIds.has(file)) moduleIds.set(file, moduleIds.size);
        return `__m${moduleIds.get(file)}`;
    }

    /**
     * Registra a dependência resolvida e devolve o namespace dela.
     * @param {string} specifier
     * @param {string} file
     */
    function registerDependency(specifier, file) {
        const resolved = resolveSpecifier(file, specifier);
        return [idFor(resolved)];
    }

    /**
     * Percorre o grafo em pós-ordem (dependências antes do consumidor).
     * @param {string} file
     */
    function visit(file) {
        if (visited.has(file)) return;

        if (inProgress.has(file)) {
            const cycle = [...inProgress, file].map((f) => path.relative(ROOT, f)).join(' → ');
            throw new Error(
                `Dependência circular detectada:\n   ${cycle}\n` +
                    '   Quebre o ciclo movendo o tipo/função compartilhada para um módulo próprio.',
            );
        }

        inProgress.add(file);

        const source = fs.readFileSync(file, 'utf8');
        const namespaceVar = idFor(file);
        /** @type {string[]} Dependências resolvidas deste módulo, na ordem de aparição. */
        const dependencies = [];

        // 1. Reescreve imports, coletando as dependências resolvidas.
        const withImports = rewriteImports(source, file, (specifier, fromFile) => {
            const resolved = resolveSpecifier(fromFile, specifier);
            const namespace = idFor(resolved);
            if (!dependencies.includes(resolved)) dependencies.push(resolved);
            return [namespace];
        });

        // 2. Remove marcações de export e coleta os nomes exportados.
        const { code, exports } = stripExports(withImports);

        // 3. Visita cada dependência antes de emitir este módulo.
        dependencies.forEach(visit);

        inProgress.delete(file);
        visited.add(file);
        ordered.push({ file, namespaceVar, body: code.trim(), exports });
    }

    visit(entry);

    const parts = ordered.map((module) => {
        const relative = path.relative(ROOT, module.file).split(path.sep).join('/');
        const banner = `// ${'='.repeat(4)} ${relative} ${'='.repeat(Math.max(4, 62 - relative.length))}`;

        const exportAssignments = module.exports
            .map((pair) => {
                const [local, exported] = pair.split(':');
                return exported === local
                    ? `    ${module.namespaceVar}.${exported} = ${local};`
                    : `    ${module.namespaceVar}['${exported}'] = ${local};`;
            })
            .join('\n');

        return [
            banner,
            `${module.namespaceVar} = {};`,
            '(function () {',
            module.body,
            exportAssignments,
            '})();',
        ]
            .filter((line) => line !== '')
            .join('\n');
    });

    // Os namespaces precisam ser declarados: em strict mode, atribuir a uma
    // variável não declarada lança `ReferenceError`.
    const declarations = [...moduleIds.values()]
        .sort((a, b) => a - b)
        .map((id) => `__m${id}`)
        .join(', ');

    return {
        modules: ordered.length,
        code: [
            '(function () {',
            "'use strict';",
            '',
            `var ${declarations};`,
            '',
            ...parts,
            '',
            '})();',
            '',
        ].join('\n'),
    };
}

/**
 * Concatena os CSS em ordem determinística.
 * @returns {string}
 */
function collectCss() {
    if (!fs.existsSync(CSS_DIR)) return '';

    const files = fs
        .readdirSync(CSS_DIR)
        .filter((file) => file.endsWith('.css'))
        .sort((a, b) => {
            // `global.css` primeiro: tokens antes de componentes.
            if (a === 'global.css') return -1;
            if (b === 'global.css') return 1;
            return a.localeCompare(b);
        });

    return files
        .map((file) => {
            const css = fs.readFileSync(path.join(CSS_DIR, file), 'utf8');
            return `/* ${'='.repeat(4)} ${file} ${'='.repeat(4)} */\n${css.trim()}`;
        })
        .join('\n\n');
}

/**
 * Gera o `dist/index.html` único.
 * @param {string} bundleCode
 * @param {string} css
 */
function emitHtml(bundleCode, css) {
    let html = fs.readFileSync(TEMPLATE, 'utf8');

    if (!html.includes(STYLES_MARKER) || !html.includes(SCRIPTS_MARKER)) {
        throw new Error('Template inválido: marcadores <!-- STYLES --> / <!-- SCRIPTS --> ausentes.');
    }

    // `</script>` dentro de uma string literal encerraria o bloco no parser HTML.
    const safeJs = bundleCode.replace(/<\/script>/gi, '<\\/script>');

    html = html.replace(STYLES_MARKER, `<style>\n${css}\n</style>`);
    html = html.replace(SCRIPTS_MARKER, `<script>\n${safeJs}</script>`);

    fs.writeFileSync(path.join(DIST_DIR, 'index.html'), html, 'utf8');
}

/** Executa o build completo. */
function build() {
    console.log('%c 🛠️  Digital Store Pro v5 — Build', 'font-weight: bold; color: #FF9800;');
    const started = Date.now();

    clean();

    log.step('Compilando TypeScript (tsc, strict)...');
    compileTypeScript();

    log.step('Empacotando módulos (1 escopo por módulo)...');
    const bundled = bundle(path.join(BUILD_DIR, 'ts', ENTRY));

    log.step('Coletando design system (CSS)...');
    const css = collectCss();

    log.step('Emitindo artefato single-file...');
    emitHtml(bundled.code, css);

    const target = path.join(DIST_DIR, 'index.html');
    const sizeKb = (fs.statSync(target).size / 1024).toFixed(1);

    log.ok(' ✨ BUILD COMPLETADO ✨');
    console.log(`   Módulos empacotados : ${bundled.modules}`);
    console.log(`   CSS                 : ${(css.length / 1024).toFixed(1)} KB`);
    console.log(`   Artefato            : dist/index.html (${sizeKb} KB)`);
    console.log(`   Tempo               : ${Date.now() - started} ms`);
    console.log('   Abra dist/index.html diretamente no navegador — não precisa de servidor.');
}

try {
    build();
} catch (error) {
    console.error('%c ❌ Erro durante o build:', 'font-weight: bold; color: #F44336;');
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
}
