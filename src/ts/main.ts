/**
 * @file main.ts
 * @description Ponto de entrada da aplicação.
 *
 * Ordem de boot (cada passo depende do anterior):
 *  1. `StorageAdapter.init()` — precisa estar resolvido antes de qualquer leitura;
 *  2. `AppState.init()` — restaura o estado persistido;
 *  3. Serviços derivados (repositório, HTTP);
 *  4. `App.init()` — monta o shell e registra as rotas;
 *  5. Suíte de testes (não bloqueante).
 *
 * A v4 executava os passos 1-2 sem aguardar corretamente, o que podia fazer a
 * primeira leitura retornar `null` e a aplicação iniciar com dados vazios.
 */

import { StorageAdapter, StorageConfig } from './core/storage';
import { AppState, createInitialState } from './core/appState';
import { Router } from './core/router';
import { AppError, toAppError } from './core/errors';
import { ProductRepository } from './data/productRepository';
import { HttpClient } from './core/http';
import { App } from './App';
import { runTestSuite, reportTestSuite } from './tests';
import { toast } from './ui/toast';

/** Configuração do banco local. */
const STORAGE_CONFIG: StorageConfig = {
    dbName: 'digital_store_pro',
    storeName: 'app_data',
    version: 1,
};

/**
 * Base da API de sincronização.
 * Vazio por padrão: a aplicação funciona 100% offline e a sincronização é
 * simulada localmente. Defina via `window.__DSP_API_BASE__` para apontar a um servidor real.
 */
const API_BASE_URL = readApiBaseUrl();

/** Lê a base da API de uma configuração global opcional. */
function readApiBaseUrl(): string {
    const configured = (window as unknown as { __DSP_API_BASE__?: unknown }).__DSP_API_BASE__;
    return typeof configured === 'string' ? configured : '';
}

/** Renderiza uma tela de erro fatal quando o boot não pode continuar. */
function renderFatalError(error: AppError): void {
    const root = document.getElementById('app-root');
    if (!root) return;

    const isStorageProblem = error.code === 'STORAGE_UNAVAILABLE';

    root.innerHTML = `
        <div style="max-width: 640px; margin: 12vh auto; padding: 2rem; font-family: system-ui, sans-serif;">
            <h1 style="font-size: 1.5rem; margin-bottom: 0.75rem;">Não foi possível iniciar a aplicação</h1>
            <p style="color: #64748b; line-height: 1.6; margin-bottom: 1rem;">${error.message}</p>
            <p style="color: #64748b; line-height: 1.6; font-size: 0.9rem;">
                ${
                    isStorageProblem
                        ? 'Este navegador está bloqueando o armazenamento local (modo privado, cookies bloqueados ou cota esgotada). Libere o armazenamento para este site e recarregue a página.'
                        : 'Recarregue a página. Se o problema persistir, verifique o console do navegador para mais detalhes.'
                }
            </p>
            <button type="button" onclick="location.reload()"
                    style="margin-top: 1rem; padding: 0.6rem 1.2rem; border-radius: 8px; border: none;
                           background: #2563eb; color: #fff; font-size: 0.9rem; font-weight: 600; cursor: pointer;">
                Recarregar
            </button>
        </div>
    `;
}

/** Sequência de inicialização. */
async function bootstrap(): Promise<void> {
    console.log('%c ◆ Digital Store Pro v5', 'font-weight: bold; color: #2563eb; font-size: 14px;');

    const storage = new StorageAdapter(STORAGE_CONFIG);
    const router = new Router();

    // 1 & 2 — Storage e estado: precisam estar prontos antes de renderizar.
    await storage.init();
    console.log(`[Boot] Armazenamento pronto. Driver ativo: ${storage.activeDriver} (${storage.activeDrivers.join(', ')}).`);

    const appState = new AppState(storage, createInitialState());
    await appState.init();
    console.log(`[Boot] Estado restaurado: ${appState.select('products').length} produto(s).`);

    // 3 — Serviços de domínio.
    const repository = new ProductRepository(appState);
    const http = new HttpClient(API_BASE_URL);

    // 4 — Shell da aplicação.
    const root = document.getElementById('app-root');
    if (!root) {
        throw new AppError('UNKNOWN', 'Elemento #app-root não encontrado no HTML.');
    }

    const app = new App({ appState, router, storage, repository, http, apiBaseUrl: API_BASE_URL });
    app.init(root);

    // Expõe os serviços no console para depuração manual.
    (window as unknown as Record<string, unknown>).app = { app, storage, state: appState, router, repository, http };

    console.log('%c ✨ Aplicação pronta.', 'font-weight: bold; color: #16a34a;');
    console.log('%c 🛠️  Dica: use "app.state.getState()" ou "app.repository.getStats()" no console.', 'color: #888;');

    // 5 — Suíte de testes em segundo plano, para não atrasar a primeira pintura.
    void runTestSuite()
        .then((summary) => {
            reportTestSuite();
            app.updateTestSummary(summary);

            if (summary.failed > 0) {
                console.warn(`[Tests] ${summary.failed} teste(s) falharam. Clique no indicador no cabeçalho para ver o detalhamento.`);
            }
        })
        .catch((error: unknown) => {
            console.error('[Tests] Falha ao executar a suíte:', toAppError(error).message);
        });
}

// `defer` no script garante que o DOM já esteja parseado; ainda assim, aguardamos
// explicitamente para cobrir o caso de o bundle ser carregado de outra forma.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void start());
} else {
    void start();
}

/** Envolve o bootstrap no tratamento de erros fatais. */
async function start(): Promise<void> {
    try {
        await bootstrap();
    } catch (error) {
        const appError = toAppError(error);
        console.error('%c 💥 Erro fatal na inicialização:', 'font-weight: bold; color: #dc2626;', appError);
        renderFatalError(appError);
        toast.error(appError.message, 'Falha ao iniciar');
    }
}
