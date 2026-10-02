/**
 * @file views/SettingsView.ts
 * @description Preferências, backups, diagnóstico e execução manual dos testes.
 */

import { Component, html, raw, SafeHtml } from '../core/dom';
import { AppState, createInitialState } from '../core/appState';
import { AppStateData, ThemeName, SidebarSide } from '../core/types';
import { ProductRepository } from '../data/productRepository';
import { createBackup, parseBackup } from '../data/backupService';
import { confirmDialog } from '../ui/modal';
import { toast } from '../ui/toast';
import { downloadJson, readFileAsText } from '../core/utils';
import { AppError } from '../core/errors';
import { runTestSuite, TestSummary } from '../tests';
import { StorageAdapter } from '../core/storage';

/** Paleta de cores de destaque disponíveis. */
const ACCENT_PRESETS = ['#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c', '#16a34a', '#0891b2', '#475569'];

/** Opções de filtros de daltonismo (aplicados via atributo em `<html>`). */
const COLORBLIND_MODES: { value: string; label: string }[] = [
    { value: '', label: 'Nenhum' },
    { value: 'protanopia', label: 'Protanopia' },
    { value: 'deuteranopia', label: 'Deuteranopia' },
    { value: 'tritanopia', label: 'Tritanopia' },
    { value: 'acromatopsia', label: 'Acromatopsia' },
];

/** View de configurações. */
export class SettingsView extends Component {
    private readonly appState: AppState<AppStateData>;
    private readonly repository: ProductRepository;
    private readonly storage: StorageAdapter;
    private readonly onImportFile: (file: File) => Promise<void>;

    private testSummary: TestSummary | null = null;
    private testing = false;
    private colorblindMode = readColorblindMode();

    constructor(
        appState: AppState<AppStateData>,
        repository: ProductRepository,
        storage: StorageAdapter,
        onImportFile: (file: File) => Promise<void>,
    ) {
        super('div', 'page settings-view');
        this.appState = appState;
        this.repository = repository;
        this.storage = storage;
        this.onImportFile = onImportFile;
    }

    protected render(): SafeHtml {
        return html`
            <div class="page-header">
                <div class="page-header__text">
                    <h2>Configurações</h2>
                    <p class="page-header__subtitle">
                        Aparência, backup dos dados, diagnóstico do armazenamento e testes automatizados.
                    </p>
                </div>
            </div>

            <div class="settings-grid">
                ${this.renderAppearance()}
                ${this.renderDataSection()}
            </div>

            <div style="margin-top: 1.5rem; display: grid; gap: 1.5rem;">
                ${this.renderDiagnostics()}
                ${this.renderTestsSection()}
            </div>
        `;
    }

    /** Preferências de aparência e layout. */
    private renderAppearance(): SafeHtml {
        const settings = this.appState.select('settings');

        return html`
            <section class="form-section settings-group" aria-labelledby="settings-appearance">
                <h3 id="settings-appearance">Aparência e layout</h3>

                <div class="settings-row">
                    <div>
                        <div class="settings-row__label">Tema</div>
                        <div class="settings-row__hint">Claro ou escuro, salvo automaticamente.</div>
                    </div>
                    <div class="row" style="gap: 0.4rem;">
                        ${(['light', 'dark'] as ThemeName[]).map(
                            (theme) => html`
                                <button
                                    type="button"
                                    class="chip"
                                    data-action="setTheme"
                                    data-theme="${theme}"
                                    aria-pressed="${settings.theme === theme ? 'true' : 'false'}"
                                >${theme === 'light' ? '☀️ Claro' : '🌙 Escuro'}</button>
                            `,
                        )}
                    </div>
                </div>

                <div class="settings-row">
                    <div>
                        <div class="settings-row__label">Posição do menu</div>
                        <div class="settings-row__hint">Mover a barra lateral para a esquerda ou direita.</div>
                    </div>
                    <div class="row" style="gap: 0.4rem;">
                        ${(['left', 'right'] as SidebarSide[]).map(
                            (side) => html`
                                <button
                                    type="button"
                                    class="chip"
                                    data-action="setSidebarSide"
                                    data-side="${side}"
                                    aria-pressed="${settings.sidebarSide === side ? 'true' : 'false'}"
                                >${side === 'left' ? '← Esquerda' : 'Direita →'}</button>
                            `,
                        )}
                    </div>
                </div>

                <div class="settings-row">
                    <div>
                        <div class="settings-row__label">Menu recolhido</div>
                        <div class="settings-row__hint">Mostra apenas os ícones.</div>
                    </div>
                    <button
                        type="button"
                        class="switch"
                        data-action="toggleCollapsed"
                        role="switch"
                        aria-checked="${settings.sidebarCollapsed ? 'true' : 'false'}"
                        aria-label="Menu recolhido"
                    ></button>
                </div>

                <div class="settings-row">
                    <div>
                        <div class="settings-row__label">Densidade da grade</div>
                        <div class="settings-row__hint">Cards maiores ou mais compactos.</div>
                    </div>
                    <div class="row" style="gap: 0.4rem;">
                        ${(['comfortable', 'compact'] as const).map(
                            (density) => html`
                                <button
                                    type="button"
                                    class="chip"
                                    data-action="setDensity"
                                    data-density="${density}"
                                    aria-pressed="${settings.gridDensity === density ? 'true' : 'false'}"
                                >${density === 'comfortable' ? 'Confortável' : 'Compacta'}</button>
                            `,
                        )}
                    </div>
                </div>

                <div class="settings-row">
                    <div>
                        <div class="settings-row__label">Cor de destaque</div>
                        <div class="settings-row__hint">Aplicada em botões, links e badges.</div>
                    </div>
                    <div class="color-swatches" role="group" aria-label="Cor de destaque">
                        ${ACCENT_PRESETS.map(
                            (color) => html`
                                <button
                                    type="button"
                                    class="color-swatch"
                                    style="background: ${color};"
                                    data-action="setAccent"
                                    data-color="${color}"
                                    aria-pressed="${settings.accentColor === color ? 'true' : 'false'}"
                                    aria-label="Cor de destaque ${color}"
                                    title="${color}"
                                ></button>
                            `,
                        )}
                    </div>
                </div>

                <div class="settings-row">
                    <div>
                        <div class="settings-row__label">Filtro de daltonismo</div>
                        <div class="settings-row__hint">Ajuste global de cores para acessibilidade.</div>
                    </div>
                    <label class="visually-hidden" for="colorblind-select">Filtro de daltonismo</label>
                    <select class="select-inline" id="colorblind-select" data-role="colorblind">
                        ${COLORBLIND_MODES.map(
                            (mode) => html`
                                <option value="${mode.value}" ${this.colorblindMode === mode.value ? raw('selected') : ''}>
                                    ${mode.label}
                                </option>
                            `,
                        )}
                    </select>
                </div>

                <div class="settings-row">
                    <div>
                        <div class="settings-row__label">Versão das preferências</div>
                        <div class="settings-row__hint">Usada para migrar configurações antigas.</div>
                    </div>
                    <span class="badge badge--neutral">v${settings.version}</span>
                </div>
            </section>
        `;
    }

    /** Backup, importação e reset. */
    private renderDataSection(): SafeHtml {
        const stats = this.repository.getStats();

        return html`
            <section class="form-section settings-group" aria-labelledby="settings-data">
                <h3 id="settings-data">Dados e backup</h3>

                <p class="text-muted" style="font-size: 0.88rem;">
                    Seus dados vivem apenas neste navegador. Exporte um backup regularmente para não perder nada
                    ao limpar o cache.
                </p>

                <div class="callout callout--info">
                    <span class="callout__icon" aria-hidden="true">📦</span>
                    <div>
                        <strong>${stats.total}</strong> produto(s) armazenado(s) —
                        ${stats.published} publicado(s), ${stats.drafts} rascunho(s).
                    </div>
                </div>

                <div class="stack-sm">
                    <button type="button" class="btn btn--primary btn--block" data-action="export">
                        ⬇️ Exportar backup (JSON)
                    </button>
                    <button type="button" class="btn btn--outline btn--block" data-action="import">
                        ⬆️ Importar backup (JSON)
                    </button>
                    <button type="button" class="btn btn--danger btn--block" data-action="reset">
                        🗑️ Apagar todos os dados
                    </button>
                </div>

                <input type="file" accept="application/json,.json" class="visually-hidden" data-role="import-input">
            </section>
        `;
    }

    /** Informações de diagnóstico do armazenamento. */
    private renderDiagnostics(): SafeHtml {
        const state = this.appState.getState();
        const drivers = this.storage.activeDrivers.join(', ') || 'nenhum';

        return html`
            <section class="form-section" aria-labelledby="settings-diagnostics">
                <h3 id="settings-diagnostics">Diagnóstico</h3>

                <div class="settings-grid" style="margin-top: 1rem;">
                    <div class="settings-group">
                        <div class="settings-row">
                            <span class="settings-row__label">Driver ativo</span>
                            <span class="badge badge--success">${drivers}</span>
                        </div>
                        <div class="settings-row">
                            <span class="settings-row__label">Conexão</span>
                            <span class="badge badge--neutral">${state.isOnline ? 'online' : 'offline'}</span>
                        </div>
                        <div class="settings-row">
                            <span class="settings-row__label">Operações pendentes</span>
                            <span class="badge badge--neutral">${state.pendingOps.length}</span>
                        </div>
                    </div>

                    <div class="settings-group">
                        <div class="settings-row">
                            <span class="settings-row__label">Última sincronização</span>
                            <span class="badge badge--neutral">
                                ${state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleString('pt-BR') : 'nunca'}
                            </span>
                        </div>
                        <div class="settings-row">
                            <span class="settings-row__label">Campos no esquema</span>
                            <span class="badge badge--neutral">${state.formSchema.fields.length}</span>
                        </div>
                        <div class="settings-row">
                            <span class="settings-row__label">Espaço usado (aprox.)</span>
                            <span class="badge badge--neutral">${estimateStorageSize()}</span>
                        </div>
                    </div>
                </div>
            </section>
        `;
    }

    /** Seção de testes automatizados. */
    private renderTestsSection(): SafeHtml {
        const summary = this.testSummary;

        return html`
            <section class="form-section" aria-labelledby="settings-tests">
                <div class="page-header" style="margin-bottom: 1rem;">
                    <div class="page-header__text">
                        <h3 id="settings-tests">Testes automatizados</h3>
                        <p class="page-header__subtitle" style="font-size: 0.88rem;">
                            A suíte roda no carregamento da página e valida storage, estado, roteador, esquema e repositório.
                        </p>
                    </div>
                    <button
                        type="button"
                        class="btn btn--outline"
                        data-action="runTests"
                        ${this.testing ? raw('disabled') : ''}
                    >${this.testing ? '⏳ Executando…' : '▶ Rodar novamente'}</button>
                </div>

                ${summary
                    ? html`
                          <div class="callout ${summary.failed === 0 ? 'callout--success' : 'callout--danger'}" style="margin-bottom: 1rem;">
                              <span class="callout__icon" aria-hidden="true">${summary.failed === 0 ? '✅' : '❌'}</span>
                              <div>
                                  <strong>${summary.passed}/${summary.total}</strong> testes passaram
                                  ${summary.failed > 0 ? html` — <strong>${summary.failed} falha(s)</strong>` : ''}.
                              </div>
                          </div>
                          ${this.renderTestResults(summary)}
                      `
                    : html`<p class="text-muted">Executando os testes…</p>`}
            </section>
        `;
    }

    /** Resultados agrupados por suíte. */
    private renderTestResults(summary: TestSummary): SafeHtml {
        const grouped = new Map<string, { name: string; passed: boolean; error?: string }[]>();

        summary.results.forEach((result) => {
            const list = grouped.get(result.suite) ?? [];
            list.push({ name: result.name, passed: result.passed, error: result.error });
            grouped.set(result.suite, list);
        });

        return html`
            <div class="test-results">
                ${[...grouped.entries()].map(([suite, cases]) => {
                    const failures = cases.filter((testCase) => !testCase.passed).length;

                    return html`
                        <div class="test-suite">
                            <div class="test-suite__header">
                                ${suite}
                                <span class="badge ${failures === 0 ? 'badge--success' : 'badge--danger'}" style="margin-left: 0.5rem;">
                                    ${cases.length - failures}/${cases.length}
                                </span>
                            </div>
                            ${cases.map(
                                (testCase) => html`
                                    <div class="test-case">
                                        <span aria-hidden="true">${testCase.passed ? '✅' : '❌'}</span>
                                        <div>
                                            <div>${testCase.name}</div>
                                            ${testCase.error ? html`<div class="test-case__error">${testCase.error}</div>` : ''}
                                        </div>
                                    </div>
                                `,
                            )}
                        </div>
                    `;
                })}
            </div>
        `;
    }

    protected override afterRender(): void {
        this.delegate('click');

        const colorblindSelect = this.element.querySelector<HTMLSelectElement>('[data-role="colorblind"]');
        if (colorblindSelect) {
            this.listen(colorblindSelect, 'change', () => {
                this.colorblindMode = colorblindSelect.value;
                applyColorblindMode(this.colorblindMode);
                toast.info(`Filtro de daltonismo: ${COLORBLIND_MODES.find((m) => m.value === this.colorblindMode)?.label ?? 'Nenhum'}.`);
            });
        }

        const importInput = this.element.querySelector<HTMLInputElement>('[data-role="import-input"]');
        if (importInput) {
            this.listen(importInput, 'change', () => {
                const file = importInput.files?.[0];
                if (file) void this.onImportFile(file);
                importInput.value = '';
            });
        }
    }

    /** Atualiza o resumo de testes exibido. */
    setTestSummary(summary: TestSummary): void {
        this.testSummary = summary;
        this.update();
    }

    /* -------------------------------------------------------------- ações -- */

    private updateSettings(patch: Partial<AppStateData['settings']>): void {
        const current = this.appState.select('settings');
        this.appState.setState({ settings: { ...current, ...patch } });
        this.update();
    }

    private onSetTheme(element: HTMLElement): void {
        this.updateSettings({ theme: (element.dataset.theme as ThemeName) ?? 'light' });
    }

    private onSetSidebarSide(element: HTMLElement): void {
        this.updateSettings({ sidebarSide: (element.dataset.side as SidebarSide) ?? 'left' });
    }

    private onToggleCollapsed(): void {
        const current = this.appState.select('settings');
        this.updateSettings({ sidebarCollapsed: !current.sidebarCollapsed });
    }

    private onSetDensity(element: HTMLElement): void {
        this.updateSettings({ gridDensity: (element.dataset.density as 'comfortable' | 'compact') ?? 'comfortable' });
    }

    private onSetAccent(element: HTMLElement): void {
        const color = element.dataset.color;
        if (!color) return;
        this.updateSettings({ accentColor: color });
    }

    private onExport(): void {
        const backup = createBackup(this.appState.getState());
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

        downloadJson(`digital-store-backup-${stamp}.json`, backup);
        toast.success(`Backup gerado com ${backup.state.products.length} produto(s).`, 'Exportação concluída');
    }

    private onImport(): void {
        this.element.querySelector<HTMLInputElement>('[data-role="import-input"]')?.click();
    }

    private async onReset(): Promise<void> {
        const confirmed = await confirmDialog({
            title: 'Apagar todos os dados',
            message:
                'Isso remove permanentemente todos os produtos, o esquema do formulário e as preferências deste navegador. ' +
                'Exporte um backup antes de continuar.',
            confirmLabel: 'Apagar tudo',
            danger: true,
        });

        if (!confirmed) return;

        try {
            await this.storage.clear();
            this.appState.replaceState(createInitialState());
            toast.success('Todos os dados locais foram apagados.', 'Reset concluído');
        } catch (error) {
            const message = error instanceof AppError ? error.message : 'Falha ao limpar os dados.';
            toast.error(message, 'Erro no reset');
        }
    }

    private async onRunTests(): Promise<void> {
        if (this.testing) return;

        this.testing = true;
        this.update();

        try {
            const summary = await runTestSuite(true);
            this.testSummary = summary;

            if (summary.failed === 0) {
                toast.success(`${summary.passed}/${summary.total} testes passaram.`, 'Suíte verde');
            } else {
                toast.error(`${summary.failed} de ${summary.total} testes falharam. Veja o detalhamento abaixo.`, 'Falhas detectadas');
            }
        } finally {
            this.testing = false;
            this.update();
        }
    }
}

/** Chave de persistência do filtro de daltonismo. */
const COLORBLIND_KEY = 'dsp5:colorblind';

/** Lê o modo de daltonismo salvo. */
function readColorblindMode(): string {
    try {
        return localStorage.getItem(COLORBLIND_KEY) ?? '';
    } catch {
        return '';
    }
}

/**
 * Aplica o filtro de daltonismo ao documento e o persiste.
 * @param mode Identificador do filtro (`''` remove).
 */
export function applyColorblindMode(mode: string): void {
    if (mode) {
        document.documentElement.setAttribute('data-colorblind', mode);
    } else {
        document.documentElement.removeAttribute('data-colorblind');
    }

    try {
        if (mode) {
            localStorage.setItem(COLORBLIND_KEY, mode);
        } else {
            localStorage.removeItem(COLORBLIND_KEY);
        }
    } catch {
        // Preferência não crítica: segue valendo apenas na sessão atual.
    }
}

/** Estima o espaço ocupado pelo estado salvo. */
function estimateStorageSize(): string {
    let bytes = 0;

    try {
        Object.keys(localStorage)
            .filter((key) => key.startsWith('dsp5:'))
            .forEach((key) => {
                bytes += key.length + (localStorage.getItem(key)?.length ?? 0);
            });
    } catch {
        return 'desconhecido';
    }

    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Exporta `readFileAsText` para uso do App (evita import duplicado). */
export { readFileAsText };
