/**
 * @file core/utils.ts
 * @description Funções utilitárias puras (sem estado, sem efeitos colaterais).
 *
 * Todas são deterministicamente testáveis em Node — nenhuma depende do DOM,
 * exceto as marcadas explicitamente como utilitários de I/O de arquivo.
 */

/**
 * Clona profundamente um valor. Usa `structuredClone` quando disponível
 * (preserva `Date`, `Map`, `Set`) com fallback para o truque do JSON.
 * @param value Valor a clonar.
 * @template T Tipo do valor.
 */
export function deepClone<T>(value: T): T {
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value);
        } catch {
            // Estruturas não clonáveis (funções, proxies) caem no fallback.
        }
    }
    return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Gera um identificador único.
 * @returns UUID v4 quando suportado, ou um id baseado em tempo+aleatório.
 */
export function uid(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    const random = Math.random().toString(36).slice(2, 10);
    return `${Date.now().toString(36)}-${random}`;
}

/**
 * Remove acentos e normaliza caixa para busca insensível a diacríticos.
 * @param value Texto de entrada.
 * @example normalizeForSearch('Café À Lá') // 'cafe a la'
 */
export function normalizeForSearch(value: string): string {
    return value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
}

/**
 * Verifica se `haystack` contém todas as palavras de `needle`,
 * ignorando acentos e caixa.
 * @param haystack Texto onde buscar.
 * @param needle Termo digitado pelo usuário.
 */
export function matchesSearch(haystack: string, needle: string): boolean {
    const normalizedNeedle = normalizeForSearch(needle);
    if (!normalizedNeedle) return true;

    const normalizedHaystack = normalizeForSearch(haystack);
    return normalizedNeedle
        .split(/\s+/)
        .filter(Boolean)
        .every((term) => normalizedHaystack.includes(term));
}

/**
 * Formata centavos como moeda localizada.
 * @param cents Valor inteiro em centavos (ex: 1999).
 * @param currency Código ISO 4217.
 * @param locale Locale BCP 47.
 * @example formatCurrency(1999) // 'R$ 19,99'
 */
export function formatCurrency(cents: number, currency = 'BRL', locale = 'pt-BR'): string {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}

/**
 * Formata um timestamp em data legível.
 * @param timestamp Epoch em milissegundos.
 * @param locale Locale BCP 47.
 */
export function formatDate(timestamp: number, locale = 'pt-BR'): string {
    return new Intl.DateTimeFormat(locale, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
    }).format(new Date(timestamp));
}

/**
 * Formata um timestamp como data e hora.
 * @param timestamp Epoch em milissegundos.
 * @param locale Locale BCP 47.
 */
export function formatDateTime(timestamp: number, locale = 'pt-BR'): string {
    return new Intl.DateTimeFormat(locale, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    }).format(new Date(timestamp));
}

/**
 * Trunca um texto preservando palavras inteiras.
 * @param value Texto de entrada.
 * @param maxLength Comprimento máximo desejado.
 */
export function truncate(value: string, maxLength: number): string {
    const clean = value.trim();
    if (clean.length <= maxLength) return clean;

    const cut = clean.slice(0, maxLength);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Cria uma versão "atrasada" de uma função — evita recomputar a cada tecla.
 * @param fn Função a executar.
 * @param waitMs Atraso em milissegundos.
 */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs = 250): (...args: A) => void {
    let timer: ReturnType<typeof setTimeout> | undefined;

    return (...args: A) => {
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => fn(...args), waitMs);
    };
}

/**
 * Congela profundamente um objeto/array, tornando mutações impossíveis.
 *
 * Usado pelo `AppState` para garantir imutabilidade real: uma cópia rasa
 * (`{ ...state }`) ainda expõe as mesmas referências de arrays e objetos
 * aninhados, então `getState().products.push(...)` corromperia o estado interno.
 *
 * @param value Valor a congelar (primitivos passam direto).
 * @template T Tipo do valor.
 */
export function deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== 'object') return value;
    if (Object.isFrozen(value)) return value;

    Object.freeze(value);
    Object.values(value as Record<string, unknown>).forEach((nested) => deepFreeze(nested));

    return value;
}

/**
 * Verifica se um valor é um objeto não-nulo e não-array.
 * @param value Valor a testar.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Verifica se um valor é "vazio" (string em branco, array/objeto sem itens).
 * @param value Valor a testar.
 */
export function isEmpty(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === 'string') return value.trim().length === 0;
    if (value instanceof Map || value instanceof Set) return value.size === 0;
    if (isPlainObject(value)) return Object.keys(value).length === 0;
    return false;
}

/**
 * Limita um número a um intervalo.
 * @param value Valor de entrada.
 * @param min Limite inferior.
 * @param max Limite superior.
 */
export function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

/**
 * Converte um preço digitado pelo usuário ("19,90" ou "19.90") em centavos.
 * @param input Valor textual.
 * @returns Inteiro em centavos, ou `NaN` se inválido.
 * @example parsePriceToCents('19,90') // 1990
 */
export function parsePriceToCents(input: string): number {
    const cleaned = input.replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
    if (!cleaned) return 0;
    return Math.round(Number.parseFloat(cleaned) * 100);
}

/** Caracteres escapados na sanitização de HTML. */
const HTML_ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

/**
 * Escapa HTML — use sempre que interpolar dados do usuário.
 * @param value Texto potencialmente inseguro.
 */
export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/**
 * Valida se uma string é uma URL http(s) ou data-URL utilizável.
 * @param value Valor candidato.
 */
export function isSafeUrl(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed) return true; // Campo opcional vazio é válido.
    if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/i.test(trimmed)) return true;

    try {
        const url = new URL(trimmed, 'https://local.invalid');
        return ['http:', 'https:', 'mailto:'].includes(url.protocol);
    } catch {
        return false;
    }
}

/** Aciona o download de um arquivo gerado em memória. */
export function downloadJson(filename: string, data: unknown): void {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
}

/**
 * Lê um `File` como texto UTF-8.
 * @param file Arquivo selecionado pelo usuário.
 */
export function readFileAsText(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(reader.error ?? new Error('Falha ao ler o arquivo.'));
        reader.readAsText(file, 'utf-8');
    });
}

/**
 * Lê um `File` de imagem como data-URL base64.
 * @param file Arquivo de imagem.
 */
export function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(reader.error ?? new Error('Falha ao ler a imagem.'));
        reader.readAsDataURL(file);
    });
}

/**
 * Agrupa itens por uma chave derivada.
 * @param items Lista de entrada.
 * @param keyFn Extrator da chave.
 */
export function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
    return items.reduce<Record<string, T[]>>((acc, item) => {
        const key = keyFn(item);
        (acc[key] ??= []).push(item);
        return acc;
    }, {});
}
