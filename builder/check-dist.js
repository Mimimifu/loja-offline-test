/**
 * @file check-dist.js
 * @description Verificação pós-build do artefato.
 *
 * Um build que "passa" mas gera um `index.html` vazio, sem CSS ou com imports
 * ESM pendentes ainda é um build quebrado — foi exatamente esse o ponto cego da
 * v4. Este script valida invariantes objetivas do artefato, incluindo um boot
 * de fumaça em Node (via `vm`) para detectar erros de sintaxe no bundle.
 *
 * Uso: `npm test`
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const DIST_INDEX = path.join(ROOT, 'dist', 'index.html');
const SRC_DIR = path.join(ROOT, 'src');

/** Falhas acumuladas durante a verificação. */
const failures = [];

/**
 * Registra o resultado de uma verificação.
 * @param {boolean} ok Condição.
 * @param {string} label Descrição.
 * @param {string} [detail] Detalhe em caso de falha.
 */
function check(ok, label, detail = '') {
    if (ok) {
        console.log(`   ✅ ${label}`);
    } else {
        console.log(`   ❌ ${label}${detail ? ` — ${detail}` : ''}`);
        failures.push(label);
    }
}

/** Ponto de entrada da verificação. */
function main() {
    console.log('%c 🔎 Verificando o artefato de build...', 'font-weight: bold; color: #FF9800;');

    if (!fs.existsSync(DIST_INDEX)) {
        console.error('❌ dist/index.html não existe. Execute "npm run build".');
        process.exit(1);
    }

    const html = fs.readFileSync(DIST_INDEX, 'utf8');
    const sizeKb = fs.statSync(DIST_INDEX).size / 1024;

    console.log('\n   Artefato');
    check(sizeKb > 80, `tamanho plausível (${sizeKb.toFixed(1)} KB)`, 'artefato suspeitamente pequeno');

    // --- Single-file: sem recursos externos ---------------------------------
    console.log('\n   Autocontenção (offline / file://)');
    const externalScripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
    const externalStyles = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*/gi)].map((m) => m[0]);

    check(externalScripts.length === 0, 'nenhum <script src> externo', externalScripts.join(', '));
    check(externalStyles.length === 0, 'nenhuma folha de estilo externa', externalStyles.join(', '));

    // Imports ESM relativos quebrariam sob `file://` (bloqueio por CORS).
    const relativeImports = [...html.matchAll(/^\s*import\s[^\n]*from\s*['"]\./gm)].map((m) => m[0].trim());
    check(relativeImports.length === 0, 'nenhum import ESM relativo pendente', relativeImports.slice(0, 3).join(' | '));

    // --- CSS embutido e não vazio -------------------------------------------
    console.log('\n   Estilos');
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    const cssSize = styleMatch ? styleMatch[1].length : 0;
    check(cssSize > 5000, `CSS embutido (${(cssSize / 1024).toFixed(1)} KB)`, 'CSS ausente ou trivialmente pequeno');
    check(html.includes('--accent-color'), 'tokens do design system presentes');
    check(html.includes('data-sidebar-side'), 'regras de layout da sidebar presentes');

    // --- Marcadores de template não resolvidos ------------------------------
    console.log('\n   Template');
    check(!html.includes('<!-- STYLES -->'), 'marcador de estilos foi substituído');
    check(!html.includes('<!-- SCRIPTS -->'), 'marcador de scripts foi substituído');
    check(html.includes('id="app-root"'), 'elemento #app-root presente');
    check(!/<\/script>\s*<\/script>/.test(html), 'sem blocos de script duplicados');

    // --- Robustez ------------------------------------------------------------
    console.log('\n   Robustez');
    check(/<html[^>]+lang="pt-BR"/.test(html), 'atributo lang="pt-BR"');

    // Invariante real: só pode existir UM `</script>` de fechamento. Se houvesse
    // outro dentro de uma string, o parser HTML encerraria o bloco antes do fim
    // do bundle. O bundler escapa essas ocorrências como `<\/script>`; aqui
    // confirmamos que o artefato não ficou truncado.
    const closingTags = (html.match(/<\/script>/gi) ?? []).length;
    check(
        closingTags === 1,
        `exatamente um </script> de fechamento (encontrados: ${closingTags})`,
        'um `</script>` no meio do bundle truncaria o script',
    );
    // --- Boot de fumaça em Node ---------------------------------------------
    console.log('\n   Boot de fumaça (sintaxe do bundle)');
    const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
    check(Boolean(scriptMatch), 'bloco de script encontrado');

    if (scriptMatch) {
        const code = scriptMatch[1].replace(/<\\\/script>/g, '</script>');

        // Ambiente mínimo: o bundle registra listeners e manipula o DOM no boot,
        // então fornecemos stubs para que a execução chegue até o fim.
        const noop = () => undefined;
        const fakeElement = () => ({
            style: {},
            dataset: {},
            classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
            setAttribute: noop,
            getAttribute: () => null,
            removeAttribute: noop,
            appendChild: noop,
            removeChild: noop,
            remove: noop,
            insertBefore: noop,
            addEventListener: noop,
            removeEventListener: noop,
            querySelector: () => null,
            querySelectorAll: () => [],
            contains: () => false,
            focus: noop,
            click: noop,
            matches: () => false,
            dispatchEvent: noop,
        });

        const sandbox = {
            console: { log: noop, warn: noop, error: noop, info: noop, group: noop, groupEnd: noop },
            document: {
                readyState: 'complete',
                documentElement: fakeElement(),
                body: fakeElement(),
                head: fakeElement(),
                getElementById: () => null,
                querySelector: () => null,
                querySelectorAll: () => [],
                createElement: fakeElement,
                addEventListener: noop,
                removeEventListener: noop,
            },
            window: {
                location: { pathname: '/', search: '', href: 'http://localhost/', origin: 'http://localhost' },
                history: { pushState: noop, replaceState: noop, length: 1 },
                addEventListener: noop,
                removeEventListener: noop,
                setTimeout: () => 0,
                clearTimeout: noop,
                requestAnimationFrame: () => 0,
                scrollTo: noop,
                navigator: { onLine: true },
                localStorage: { getItem: () => null, setItem: noop, removeItem: noop, key: () => null, length: 0 },
            },
            navigator: { onLine: true, userAgent: 'node' },
            localStorage: { getItem: () => null, setItem: noop, removeItem: noop, key: () => null, length: 0 },
            setTimeout: () => 0,
            clearTimeout: noop,
            performance: { now: () => Date.now() },
            crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
            URL,
            URLSearchParams,
            structuredClone,
            MutationObserver: class {
                observe() {}
                disconnect() {}
            },
            CustomEvent: class {
                constructor(type) {
                    this.type = type;
                }
            },
            indexedDB: undefined,
        };

        sandbox.globalThis = sandbox;
        sandbox.self = sandbox;

        try {
            vm.createContext(sandbox);
            // Apenas avaliação do bundle: comprova que a sintaxe é válida e que
            // nenhuma referência de topo está quebrada.
            vm.runInContext(code, sandbox, { timeout: 10_000 });
            check(true, 'bundle avalia sem erro de sintaxe/referência');
        } catch (error) {
            check(false, 'bundle avalia sem erro de sintaxe/referência', error.message);
        }
    }

    // --- Paridade com o código-fonte ----------------------------------------
    console.log('\n   Paridade com o código-fonte');
    check(/v5/.test(html), 'marcador de versão "v5" presente no bundle');
    check(fs.existsSync(path.join(SRC_DIR, 'ts', 'main.ts')), 'entry point do TypeScript existe');

    // --- Resultado ----------------------------------------------------------
    console.log('\n' + '─'.repeat(52));

    if (failures.length === 0) {
        console.log('%c ✨ ARTEFATO VERIFICADO — pronto para uso offline ✨', 'font-weight: bold; color: #4CAF50;');
        console.log(`   dist/index.html — ${sizeKb.toFixed(1)} KB, single-file.`);
        process.exit(0);
    }

    console.error(`%c ❌ ${failures.length} verificação(ões) falharam.`, 'font-weight: bold; color: #F44336;');
    process.exit(1);
}

main();
