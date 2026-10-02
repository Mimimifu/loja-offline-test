/**
 * @file core/routeParams.ts
 * @description Normalização de parâmetros de rota.
 *
 * Existe como módulo próprio porque o router já decodifica os parâmetros, mas
 * views que recebem ids externos precisam de uma sanitização defensiva contra
 * entradas malformadas (ex: `%E0%A4%A`), que fariam `decodeURIComponent`
 * lançar `URIError` e quebrar a renderização.
 */

/**
 * Decodifica um parâmetro de rota de forma tolerante.
 *
 * @param value Valor bruto extraído da rota (possivelmente percent-encoded).
 * @returns O valor decodificado; o próprio valor original se estiver malformado.
 * @example idFromRouteParam('caf%C3%A9') // 'café'
 * @example idFromRouteParam('%E0%A4%A')  // '%E0%A4%A' (não lança)
 */
export function idFromRouteParam(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return '';

    try {
        return decodeURIComponent(trimmed);
    } catch {
        return trimmed;
    }
}

/**
 * Normaliza um id para comparação, tolerando diferenças de caixa e espaços.
 *
 * Necessário porque ids podem ter vindo de backups antigos (numéricos) ou de
 * gerações de UUID, e a comparação estrita entre tipos diferentes é uma fonte
 * clássica de "o registro não carregou no formulário".
 *
 * @param value Id a normalizar.
 * @example normalizeId(42)   // '42'
 * @example normalizeId('42') // '42'
 */
export function normalizeId(value: unknown): string {
    if (value === null || value === undefined) return '';
    return String(value).trim().toLowerCase();
}

/**
 * Compara dois ids de forma tolerante a tipo e caixa.
 * @param a Primeiro id.
 * @param b Segundo id.
 */
export function idsMatch(a: unknown, b: unknown): boolean {
    const left = normalizeId(a);
    const right = normalizeId(b);
    return left !== '' && left === right;
}

/**
 * Encontra um item cujo id equivale ao informado, tolerando tipo/caixa.
 * @param items Coleção a varrer.
 * @param id Id procurado.
 */
export function findByIdLoose<T extends { id: unknown }>(items: T[], id: unknown): T | null {
    const target = normalizeId(id);
    if (!target) return null;

    return items.find((item) => normalizeId(item.id) === target) ?? null;
}
