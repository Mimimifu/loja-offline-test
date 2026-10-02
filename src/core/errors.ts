/**
 * @file core/errors.ts
 * @description Taxonomia de erros da aplicação.
 *
 * Centralizar os erros permite que as camadas de UI tomem decisões
 * específicas (ex: oferecer limpeza de dados em `QUOTA_EXCEEDED`) sem
 * depender de strings mágicas espalhadas pelo código.
 */

/** Códigos de erro estáveis — seguros de persistir e logar. */
export type AppErrorCode =
    | 'QUOTA_EXCEEDED'
    | 'STORAGE_UNAVAILABLE'
    | 'VALIDATION'
    | 'NOT_FOUND'
    | 'HTTP'
    | 'TIMEOUT'
    | 'SCHEMA_MISMATCH'
    | 'UNKNOWN';

/** Erro base da aplicação. Toda falha esperada carrega um `code`. */
export class AppError extends Error {
    public readonly code: AppErrorCode;
    public readonly details: Record<string, unknown>;

    constructor(code: AppErrorCode, message: string, details: Record<string, unknown> = {}) {
        super(message);
        this.name = 'AppError';
        this.code = code;
        this.details = details;
    }
}

/** Limite de armazenamento do navegador excedido. */
export class QuotaExceededError extends AppError {
    constructor(message = 'Limite de armazenamento do navegador excedido.', details: Record<string, unknown> = {}) {
        super('QUOTA_EXCEEDED', message, details);
        this.name = 'QuotaExceededError';
    }
}

/** Falha de validação de formulário ou de esquema JSON. */
export class ValidationError extends AppError {
    public readonly fieldErrors: Record<string, string>;

    constructor(message: string, fieldErrors: Record<string, string> = {}) {
        super('VALIDATION', message, { fieldErrors });
        this.name = 'ValidationError';
        this.fieldErrors = fieldErrors;
    }
}

/** Registro não encontrado no armazenamento. */
export class NotFoundError extends AppError {
    constructor(message = 'Registro não encontrado.') {
        super('NOT_FOUND', message);
        this.name = 'NotFoundError';
    }
}

/** Falha de comunicação HTTP. */
export class HttpError extends AppError {
    public readonly status: number;

    constructor(status: number, message: string, details: Record<string, unknown> = {}) {
        super('HTTP', message, { status, ...details });
        this.name = 'HttpError';
        this.status = status;
    }
}

/**
 * Normaliza qualquer valor lançado para um `AppError`.
 * @param error Valor capturado em um `catch` (que em JS pode ser qualquer coisa).
 * @returns Uma instância de `AppError` (a própria, se já for uma).
 */
export function toAppError(error: unknown): AppError {
    if (error instanceof AppError) return error;

    if (isQuotaExceeded(error)) {
        return new QuotaExceededError('Limite de armazenamento do navegador excedido.');
    }

    if (error instanceof Error) {
        return new AppError('UNKNOWN', error.message, { originalName: error.name });
    }

    return new AppError('UNKNOWN', String(error));
}

/**
 * Detecta `QuotaExceededError`, cujo nome varia entre navegadores
 * (Firefox: `NS_ERROR_DOM_QUOTA_REACHED`, Safari: código `22`).
 * @param error Valor capturado em um `catch`.
 */
export function isQuotaExceeded(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;

    const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
    const name = typeof candidate.name === 'string' ? candidate.name : '';
    const code = typeof candidate.code === 'number' ? candidate.code : 0;
    const message = typeof candidate.message === 'string' ? candidate.message : '';

    return (
        name === 'QuotaExceededError' ||
        name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
        code === 22 ||
        code === 1014 ||
        /quota/i.test(message)
    );
}

/**
 * Converte um erro em objeto serializável (para logs em UI ou export de diagnóstico).
 * @param error Valor capturado em um `catch`.
 */
export function serializeError(error: unknown): Record<string, unknown> {
    const appError = toAppError(error);
    return {
        name: appError.name,
        code: appError.code,
        message: appError.message,
        details: appError.details,
    };
}
