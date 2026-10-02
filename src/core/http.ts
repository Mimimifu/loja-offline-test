/**
 * @file core/http.ts
 * @description Cliente HTTP mínimo sobre `fetch`, com timeout e erros tipados.
 *
 * Sem dependências externas: usa apenas `fetch` + `AbortController`.
 * Todos os erros (status HTTP, timeout, falha de rede) são normalizados para
 * `AppError`/`HttpError`, permitindo que a UI decida o que exibir.
 */

import { AppError, HttpError, toAppError } from './errors';

/** Opções aceitas por cada requisição. */
export interface RequestOptions {
    /** Timeout em milissegundos (padrão: 15000). */
    timeoutMs?: number;
    /** Cabeçalhos adicionais. */
    headers?: Record<string, string>;
    /** Sinal externo de cancelamento. */
    signal?: AbortSignal;
    /** Query string montada a partir de um objeto. */
    query?: Record<string, string | number | boolean | undefined>;
}

/** Resultado de uma requisição bem-sucedida. */
export interface HttpResponse<T> {
    status: number;
    data: T;
    headers: Headers;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Cliente HTTP com base URL configurável.
 */
export class HttpClient {
    private readonly baseUrl: string;

    /**
     * @param baseUrl Prefixo aplicado a todos os caminhos relativos.
     */
    constructor(baseUrl = '') {
        this.baseUrl = baseUrl.replace(/\/$/, '');
    }

    /** Monta a URL final com query string. */
    private buildUrl(path: string, query?: RequestOptions['query']): string {
        const url = new URL(`${this.baseUrl}${path}`, 'https://local.invalid');

        if (query) {
            Object.entries(query).forEach(([key, value]) => {
                if (value !== undefined) url.searchParams.set(key, String(value));
            });
        }

        // Caminhos relativos permanecem relativos (a base é apenas um prefixo).
        return this.baseUrl || query ? url.toString() : path;
    }

    /** Executa a requisição, aplicando timeout e normalizando erros. */
    private async request<T>(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<HttpResponse<T>> {
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        // Combina o abort externo com o timeout interno.
        const onExternalAbort = (): void => controller.abort();
        options.signal?.addEventListener('abort', onExternalAbort);

        try {
            const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
            if (body !== undefined) headers['Content-Type'] = 'application/json';

            const response = await fetch(this.buildUrl(path, options.query), {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal,
            });

            if (!response.ok) {
                throw new HttpError(response.status, `Requisição falhou com status ${response.status}.`, {
                    path,
                    method,
                });
            }

            // 204/205 e respostas vazias não têm corpo JSON.
            const text = await response.text();
            const data = (text ? JSON.parse(text) : null) as T;

            return { status: response.status, data, headers: response.headers };
        } catch (error) {
            const appError = toAppError(error);

            if (appError.code === 'HTTP') throw appError;

            // `AbortError` = timeout interno ou cancelamento pelo chamador.
            if (appError.details.originalName === 'AbortError' || appError.message.includes('abort')) {
                throw options.signal?.aborted
                    ? new AppError('TIMEOUT', 'Requisição cancelada.')
                    : new AppError('TIMEOUT', `Tempo limite de ${timeoutMs}ms excedido em ${method} ${path}.`);
            }

            throw new AppError('HTTP', `Falha de rede em ${method} ${path}: ${appError.message}`);
        } finally {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onExternalAbort);
        }
    }

    /** GET. */
    get<T>(path: string, options?: RequestOptions): Promise<HttpResponse<T>> {
        return this.request<T>('GET', path, undefined, options);
    }

    /** POST. */
    post<T>(path: string, body: unknown, options?: RequestOptions): Promise<HttpResponse<T>> {
        return this.request<T>('POST', path, body, options);
    }

    /** PUT. */
    put<T>(path: string, body: unknown, options?: RequestOptions): Promise<HttpResponse<T>> {
        return this.request<T>('PUT', path, body, options);
    }

    /** PATCH. */
    patch<T>(path: string, body: unknown, options?: RequestOptions): Promise<HttpResponse<T>> {
        return this.request<T>('PATCH', path, body, options);
    }

    /** DELETE. */
    delete<T>(path: string, options?: RequestOptions): Promise<HttpResponse<T>> {
        return this.request<T>('DELETE', path, undefined, options);
    }
}
