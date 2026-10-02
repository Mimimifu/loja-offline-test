/**
 * @file core/schema.ts
 * @description Motor de formulários dinâmicos (JSON-driven).
 *
 * O esquema controla quais campos existem, seu tipo, validação e a qual
 * propriedade de `Product` cada valor corresponde. O usuário pode editar o
 * JSON na aba Configurações, e o formulário de cadastro se adapta sozinho.
 *
 * Nota de arquitetura: as funções puras (`getByPath`, `setByPath`,
 * `validateAgainstSchema`, `parseFieldValue`, `serializeFieldValue`) são
 * exportadas separadamente para serem testáveis sem DOM.
 */

import { FieldSchema, FormSchema, Product } from './types';
import { ValidationError } from './errors';
import { isSafeUrl, parsePriceToCents } from './utils';

/** Lê um valor aninhado por caminho pontuado (`a.b.c`). */
export function getByPath(source: unknown, path: string): unknown {
    return path
        .split('.')
        .reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), source);
}

/** Escreve um valor aninhado por caminho pontuado, clonando os objetos intermediários. */
export function setByPath(target: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
    const keys = path.split('.');

    const clone: Record<string, unknown> = { ...target };
    let cursor: Record<string, unknown> = clone;

    for (let i = 0; i < keys.length - 1; i += 1) {
        const key = keys[i];
        const existing = cursor[key];
        const nested: Record<string, unknown> =
            existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {};
        cursor[key] = nested;
        cursor = nested;
    }

    cursor[keys[keys.length - 1]] = value;
    return clone;
}

/**
 * Converte o texto de um `<input>` no valor tipado do domínio.
 * @param field Definição do campo.
 * @param rawValue Valor textual bruto.
 */
export function parseFieldValue(field: FieldSchema, rawValue: string): unknown {
    switch (field.type) {
        case 'number': {
            if (rawValue.trim() === '') return 0;
            const parsed = field.scale === 100 ? parsePriceToCents(rawValue) : Number(rawValue);
            return Number.isFinite(parsed) ? parsed : 0;
        }
        case 'checkbox':
            return rawValue === 'true';
        case 'tags':
            return rawValue
                .split(',')
                .map((tag) => tag.trim())
                .filter(Boolean);
        default:
            return rawValue;
    }
}

/**
 * Converte um valor do domínio no texto exibido no formulário.
 * @param field Definição do campo.
 * @param value Valor armazenado.
 */
export function serializeFieldValue(field: FieldSchema, value: unknown): string {
    if (value === null || value === undefined) return '';

    switch (field.type) {
        case 'number': {
            const numeric = typeof value === 'number' ? value : Number(value);
            return field.scale === 100 ? (numeric / 100).toFixed(2) : String(numeric);
        }
        case 'checkbox':
            return value ? 'true' : 'false';
        case 'tags':
            return Array.isArray(value) ? value.join(', ') : String(value);
        default:
            return String(value);
    }
}

/**
 * Valida um objeto contra o esquema.
 * @param schema Esquema do formulário.
 * @param data Valores por caminho (já tipados).
 * @throws {ValidationError} Com o mapa de erros por campo.
 */
export function validateAgainstSchema(schema: FormSchema, data: Record<string, unknown>): void {
    const fieldErrors: Record<string, string> = {};

    schema.fields.forEach((field) => {
        const value = getByPath(data, field.path);

        if (field.required) {
            const isMissing =
                value === undefined ||
                value === null ||
                (typeof value === 'string' && value.trim() === '') ||
                (Array.isArray(value) && value.length === 0);

            if (isMissing) {
                fieldErrors[field.id] = `"${field.label}" é obrigatório.`;
                return;
            }
        }

        if (field.type === 'url' && typeof value === 'string' && value.trim() !== '' && !isSafeUrl(value)) {
            fieldErrors[field.id] = `"${field.label}" deve ser uma URL http(s) válida.`;
        }

        if (field.type === 'number' && field.scale === 100 && typeof value === 'number' && value < 0) {
            fieldErrors[field.id] = `"${field.label}" não pode ser negativo.`;
        }
    });

    if (Object.keys(fieldErrors).length > 0) {
        throw new ValidationError('Corrija os campos destacados.', fieldErrors);
    }
}

/**
 * Valida a estrutura de um esquema JSON vindo do usuário.
 * @param candidate Valor desserializado a validar.
 * @throws {ValidationError} Se o esquema for inválido.
 */
export function validateSchemaShape(candidate: unknown): FormSchema {
    if (!candidate || typeof candidate !== 'object') {
        throw new ValidationError('O esquema deve ser um objeto JSON.');
    }

    const schema = candidate as Partial<FormSchema>;
    if (!Array.isArray(schema.fields) || schema.fields.length === 0) {
        throw new ValidationError('O esquema precisa de um array "fields" com pelo menos um campo.');
    }

    const allowedTypes: FieldSchema['type'][] = ['text', 'textarea', 'number', 'url', 'select', 'checkbox', 'tags'];

    schema.fields.forEach((field, index) => {
        if (!field || typeof field !== 'object') {
            throw new ValidationError(`Campo #${index} inválido.`);
        }
        if (!field.id || typeof field.id !== 'string') {
            throw new ValidationError(`Campo #${index}: "id" é obrigatório e deve ser texto.`);
        }
        if (!field.label || typeof field.label !== 'string') {
            throw new ValidationError(`Campo "${field.id}": "label" é obrigatório.`);
        }
        if (!field.path || typeof field.path !== 'string') {
            throw new ValidationError(`Campo "${field.id}": "path" é obrigatório (ex: "title").`);
        }
        if (!allowedTypes.includes(field.type)) {
            throw new ValidationError(`Campo "${field.id}": tipo "${field.type}" não suportado. Use: ${allowedTypes.join(', ')}.`);
        }
        if (field.type === 'select' && (!Array.isArray(field.options) || field.options.length === 0)) {
            throw new ValidationError(`Campo "${field.id}": tipo "select" exige "options" não vazio.`);
        }
    });

    return {
        version: typeof schema.version === 'number' ? schema.version : 1,
        fields: schema.fields,
    };
}

/**
 * Projeta um `Product` nos valores do formulário, segundo o esquema.
 * @param schema Esquema atual.
 * @param product Produto fonte (ou `null` para valores padrão).
 */
export function productToFormValues(schema: FormSchema, product: Product | null): Record<string, string> {
    const values: Record<string, string> = {};

    schema.fields.forEach((field) => {
        const raw = product ? getByPath(product, field.path) : undefined;

        if (raw === undefined && field.type === 'checkbox') {
            // Regra de negócio: itens novos nascem publicados.
            values[field.id] = field.path === 'published' ? 'true' : 'false';
            return;
        }

        values[field.id] = serializeFieldValue(field, raw);
    });

    return values;
}

/**
 * Constrói um `Product` a partir dos valores do formulário + esquema.
 * @param schema Esquema atual.
 * @param formValues Valores brutos por `field.id`.
 * @param base Produto existente (edição) ou `null` (criação).
 * @throws {ValidationError} Se a validação falhar.
 */
export function formValuesToProduct(schema: FormSchema, formValues: Record<string, string>, base: Product | null): Product {
    let draft: Record<string, unknown> = base ? { ...base } : {};

    schema.fields.forEach((field) => {
        const raw = formValues[field.id];
        draft = setByPath(draft, field.path, parseFieldValue(field, raw ?? ''));
    });

    validateAgainstSchema(schema, draft);

    // Campos técnicos não expostos no formulário.
    const now = Date.now();
    draft.updatedAt = now;
    if (!base) {
        draft.createdAt = now;
    }

    return normalizeProduct(draft);
}

/** Garante que um objeto tenha todos os campos de `Product` com tipos corretos. */
export function normalizeProduct(draft: Record<string, unknown>): Product {
    const asString = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
    const asNumber = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

    const category = asString(draft.category, 'outro');
    const allowedCategories: Product['category'][] = ['pdf', 'musica', 'planilha', 'curso', 'template', 'outro'];

    return {
        id: asString(draft.id),
        title: asString(draft.title).trim(),
        category: (allowedCategories as string[]).includes(category) ? (category as Product['category']) : 'outro',
        priceCents: Math.max(0, Math.round(asNumber(draft.priceCents))),
        description: asString(draft.description).trim(),
        image: asString(draft.image).trim(),
        paymentLink: asString(draft.paymentLink).trim(),
        downloadLink: asString(draft.downloadLink).trim(),
        paymentLabel: asString(draft.paymentLabel, 'Comprar').trim() || 'Comprar',
        tags: Array.isArray(draft.tags) ? draft.tags.filter((tag): tag is string => typeof tag === 'string') : [],
        published: draft.published !== false,
        createdAt: asNumber(draft.createdAt, Date.now()),
        updatedAt: asNumber(draft.updatedAt, Date.now()),
    };
}
