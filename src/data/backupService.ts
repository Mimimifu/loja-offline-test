/**
 * @file data/backupService.ts
 * @description Exportação/importação de backup e reset de estado.
 *
 * O envelope carrega um marcador `app` e `version`, permitindo validar o
 * arquivo antes de sobrescrever dados locais (a v4 importava cegamente).
 */

import { BackupEnvelope, AppStateData, Product, Settings, FormSchema } from '../core/types';
import { ValidationError } from '../core/errors';
import { isPlainObject } from '../core/utils';
import { normalizeProduct, validateSchemaShape } from '../core/schema';
import { defaultSettings } from '../core/appState';

/** Versão do formato de backup — incrementar ao mudar o envelope. */
export const BACKUP_VERSION = 1;

/** Marcador que identifica um arquivo como backup desta aplicação. */
export const BACKUP_MARKER = 'digital-store-pro';

/**
 * Monta o envelope de backup a partir do estado.
 * @param state Estado atual.
 */
export function createBackup(state: AppStateData): BackupEnvelope {
    return {
        app: BACKUP_MARKER,
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        state: {
            products: state.products,
            settings: state.settings,
            formSchema: state.formSchema,
        },
    };
}

/** Resultado da validação de um backup. */
export interface ParsedBackup {
    products: Product[];
    settings: Settings | null;
    formSchema: FormSchema | null;
    exportedAt: string | null;
}

/**
 * Valida e normaliza um backup recebido.
 *
 * Aceita tanto o envelope atual quanto um array simples de produtos (formato
 * exportado pela v1-v4), facilitando a migração de dados do usuário.
 *
 * @param raw Conteúdo JSON já desserializado.
 * @throws {ValidationError} Se o arquivo não for um backup utilizável.
 */
export function parseBackup(raw: unknown): ParsedBackup {
    // Compatibilidade: array nu de produtos (formato das versões anteriores).
    if (Array.isArray(raw)) {
        if (raw.length === 0) {
            throw new ValidationError('O arquivo contém uma lista vazia de produtos.');
        }
        return {
            products: raw.map((item) => normalizeProduct(isPlainObject(item) ? item : {})),
            settings: null,
            formSchema: null,
            exportedAt: null,
        };
    }

    if (!isPlainObject(raw)) {
        throw new ValidationError('Arquivo inválido: esperado um objeto JSON.');
    }

    const envelope = raw as Partial<BackupEnvelope>;

    if (envelope.app !== BACKUP_MARKER) {
        throw new ValidationError(
            `Este arquivo não é um backup do Digital Store Pro (esperado "app": "${BACKUP_MARKER}").`,
        );
    }

    if (typeof envelope.version !== 'number' || envelope.version > BACKUP_VERSION) {
        throw new ValidationError(
            `Versão de backup incompatível (arquivo: ${String(envelope.version)}, suportado até: ${BACKUP_VERSION}). ` +
                'Atualize a aplicação para importar este arquivo.',
        );
    }

    if (!isPlainObject(envelope.state) || !Array.isArray(envelope.state.products)) {
        throw new ValidationError('Backup malformado: "state.products" ausente ou inválido.');
    }

    let formSchema: FormSchema | null = null;
    if (envelope.state.formSchema) {
        // Um esquema inválido não deve impedir a restauração dos produtos.
        try {
            formSchema = validateSchemaShape(envelope.state.formSchema);
        } catch {
            formSchema = null;
        }
    }

    return {
        products: envelope.state.products
            .filter(isPlainObject)
            .map((item) => normalizeProduct(item as unknown as Record<string, unknown>)),
        settings: mergeSettings(envelope.state.settings),
        formSchema,
        exportedAt: typeof envelope.exportedAt === 'string' ? envelope.exportedAt : null,
    };
}

/** Mescla preferências importadas sobre os padrões, ignorando valores inválidos. */
function mergeSettings(candidate: unknown): Settings | null {
    if (!isPlainObject(candidate)) return null;

    const defaults = defaultSettings();
    const theme = candidate.theme === 'dark' || candidate.theme === 'light' ? candidate.theme : defaults.theme;
    const sidebarSide = candidate.sidebarSide === 'right' || candidate.sidebarSide === 'left' ? candidate.sidebarSide : defaults.sidebarSide;

    return {
        ...defaults,
        theme,
        sidebarSide,
        sidebarCollapsed: typeof candidate.sidebarCollapsed === 'boolean' ? candidate.sidebarCollapsed : defaults.sidebarCollapsed,
        accentColor: typeof candidate.accentColor === 'string' ? candidate.accentColor : defaults.accentColor,
        gridDensity: candidate.gridDensity === 'compact' || candidate.gridDensity === 'comfortable' ? candidate.gridDensity : defaults.gridDensity,
    };
}
