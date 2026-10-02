/**
 * @file tests/suites/schema.test.ts
 * @description Testes do motor de formulários dinâmicos e validação.
 *
 * Regressões cobertas (bugs da v4):
 *  - a v4 importava JSON de configuração sem validar a forma, permitindo
 *    esquemas que quebravam a renderização (`field.type` inexistente);
 *  - preços eram tratados como `float`, acumulando erro de ponto flutuante.
 */

import { assert, testRunner } from '../testRunner';
import {
    formValuesToProduct,
    getByPath,
    normalizeProduct,
    parseFieldValue,
    productToFormValues,
    serializeFieldValue,
    setByPath,
    validateAgainstSchema,
    validateSchemaShape,
} from '../../core/schema';
import { AppError } from '../../core/errors';
import { defaultSettings } from '../../core/appState';
import { FormSchema, Product } from '../../core/types';

/** Esquema mínimo reutilizado nos testes. */
const schema: FormSchema = {
    version: 1,
    fields: [
        { id: 'title', label: 'Título', type: 'text', required: true, path: 'title' },
        { id: 'priceCents', label: 'Preço', type: 'number', required: true, path: 'priceCents', scale: 100 },
        { id: 'image', label: 'Imagem', type: 'url', path: 'image' },
        { id: 'tags', label: 'Tags', type: 'tags', path: 'tags' },
        { id: 'published', label: 'Publicado', type: 'checkbox', path: 'published' },
        {
            id: 'category',
            label: 'Categoria',
            type: 'select',
            required: true,
            path: 'category',
            options: [{ value: 'pdf', label: 'PDF' }],
        },
    ],
};

/** Produto de referência. */
const product: Product = {
    id: 'p1',
    title: 'Guia de Mixação',
    category: 'pdf',
    priceCents: 1990,
    description: 'Um guia completo',
    image: 'https://exemplo.com/img.png',
    paymentLink: 'https://pagar.exemplo.com/1',
    downloadLink: 'https://baixar.exemplo.com/1',
    paymentLabel: 'Comprar',
    tags: ['musica', 'pdf'],
    published: true,
    createdAt: 1000,
    updatedAt: 2000,
};

/** Registra a suíte de esquema. */
export function registerSchemaSuite(): void {
    testRunner.describe('🧾 [Schema] Formulários dinâmicos', () => {
        testRunner.it('getByPath lê valores aninhados e tolera caminho inválido', () => {
            assert.equal(getByPath({ a: { b: { c: 7 } } }, 'a.b.c'), 7);
            assert.equal(getByPath({ a: 1 }, 'a.b.c'), undefined);
            assert.equal(getByPath(null, 'a'), undefined);
        });

        testRunner.it('setByPath escreve aninhado sem mutar o original', () => {
            const original = { a: { b: 1 }, keep: true };
            const updated = setByPath(original, 'a.b', 99);

            assert.equal(getByPath(updated, 'a.b'), 99, 'valor deve ser atualizado');
            assert.equal(getByPath(original, 'a.b'), 1, 'original não deve ser mutado');
            assert.equal(updated.keep, true, 'outras chaves devem ser preservadas');
        });

        testRunner.it('parseFieldValue converte tipo number com escala de centavos', () => {
            assert.equal(parseFieldValue(schema.fields[1], '19,90'), 1990, 'deve converter pt-BR para centavos');
            assert.equal(parseFieldValue(schema.fields[1], ''), 0, 'vazio vira zero');
            assert.equal(parseFieldValue(schema.fields[1], 'abc'), 0, 'inválido vira zero');
        });

        testRunner.it('parseFieldValue converte tags e checkbox', () => {
            assert.deepEqual(parseFieldValue(schema.fields[3], 'a, b, c'), ['a', 'b', 'c']);
            assert.deepEqual(parseFieldValue(schema.fields[3], ''), [], 'tags vazias viram array vazio');
            assert.equal(parseFieldValue(schema.fields[4], 'true'), true);
            assert.equal(parseFieldValue(schema.fields[4], 'false'), false);
        });

        testRunner.it('serializeFieldValue reconstrói o texto de edição', () => {
            assert.equal(serializeFieldValue(schema.fields[1], 1990), '19.90', 'centavos voltam para reais');
            assert.equal(serializeFieldValue(schema.fields[3], ['a', 'b']), 'a, b');
            assert.equal(serializeFieldValue(schema.fields[2], ''), '', 'vazio permanece vazio');
        });

        testRunner.it('validateAgainstSchema acusa campos obrigatórios ausentes', async () => {
            const error = await assert.throws(() => validateAgainstSchema(schema, { category: 'pdf', priceCents: 0 }));

            assert.equal((error as AppError).code, 'VALIDATION');
            assert.ok((error as { fieldErrors: Record<string, string> }).fieldErrors.title, 'deve apontar "title"');
        });

        testRunner.it('validateAgainstSchema rejeita URL insegura', async () => {
            const error = await assert.throws(() =>
                validateAgainstSchema(schema, { title: 'x', category: 'pdf', priceCents: 0, image: 'javascript:alert(1)' }),
            );

            assert.ok((error as { fieldErrors: Record<string, string> }).fieldErrors.image, 'deve apontar "image"');
        });

        testRunner.it('validateAgainstSchema rejeita preço negativo', async () => {
            const error = await assert.throws(() =>
                validateAgainstSchema(schema, { title: 'x', category: 'pdf', priceCents: -100 }),
            );

            assert.ok((error as { fieldErrors: Record<string, string> }).fieldErrors.priceCents);
        });

        testRunner.it('validateAgainstSchema aprova dados completos', async () => {
            validateAgainstSchema(schema, { title: 'ok', category: 'pdf', priceCents: 100 });
            assert.ok(true, 'não deve lançar para dados válidos');
        });

        testRunner.it('validateSchemaShape aceita esquema bem formado', () => {
            const parsed = validateSchemaShape(schema);
            assert.equal(parsed.fields.length, schema.fields.length);
        });

        testRunner.it('validateSchemaShape rejeita tipo de campo desconhecido', async () => {
            const error = await assert.throws(() =>
                validateSchemaShape({ version: 1, fields: [{ id: 'x', label: 'X', path: 'x', type: 'hologram' }] }),
            );

            assert.equal((error as AppError).code, 'VALIDATION');
            assert.includes((error as Error).message, 'não suportado');
        });

        testRunner.it('validateSchemaShape rejeita select sem options', async () => {
            const error = await assert.throws(() =>
                validateSchemaShape({ version: 1, fields: [{ id: 'x', label: 'X', path: 'x', type: 'select' }] }),
            );
            assert.includes((error as Error).message, 'options');
        });

        testRunner.it('validateSchemaShape rejeita estrutura sem fields', async () => {
            await assert.throws(() => validateSchemaShape({ version: 1 }));
            await assert.throws(() => validateSchemaShape(null));
            await assert.throws(() => validateSchemaShape({ version: 1, fields: [] }));
        });

        testRunner.it('productToFormValues preenche o formulário a partir do produto', () => {
            const values = productToFormValues(schema, product);

            assert.equal(values.title, 'Guia de Mixação');
            assert.equal(values.priceCents, '19.90', 'preço deve voltar como reais');
            assert.equal(values.category, 'pdf');
            assert.equal(values.tags, 'musica, pdf');
            assert.equal(values.published, 'true');
        });

        testRunner.it('productToFormValues marca item novo como publicado por padrão', () => {
            const values = productToFormValues(schema, null);

            assert.equal(values.published, 'true', 'novos itens nascem publicados');
            assert.equal(values.title, '', 'texto inicia vazio');
        });

        testRunner.it('formValuesToProduct cria produto com centavos exatos', () => {
            const created = formValuesToProduct(
                schema,
                { title: 'Novo', priceCents: '19,90', category: 'pdf', tags: 'a,b', published: 'true' },
                null,
            );

            assert.equal(created.priceCents, 1990, 'sem erro de ponto flutuante');
            assert.deepEqual(created.tags, ['a', 'b']);
            assert.equal(created.published, true);
            assert.ok(created.id === '' || typeof created.id === 'string', 'id deve ser string');
        });

        testRunner.it('formValuesToProduct em edição preserva createdAt e id', () => {
            const updated = formValuesToProduct(
                schema,
                { title: 'Alterado', priceCents: '29,90', category: 'pdf', tags: '', published: 'false' },
                product,
            );

            assert.equal(updated.id, product.id, 'id preservado');
            assert.equal(updated.createdAt, product.createdAt, 'createdAt preservado');
            assert.ok(updated.updatedAt >= product.updatedAt, 'updatedAt avançou');
            assert.equal(updated.priceCents, 2990);
            assert.equal(updated.published, false, 'despublicar deve funcionar');
        });

        testRunner.it('formValuesToProduct lança ValidationError em dados inválidos', async () => {
            const error = await assert.throws(() =>
                formValuesToProduct(schema, { title: '', priceCents: '10', category: 'pdf' }, null),
            );

            assert.equal((error as AppError).code, 'VALIDATION');
        });

        testRunner.it('normalizeProduct preenche os campos técnicos ausentes', () => {
            const normalized = normalizeProduct({ title: 'Só título' });

            assert.equal(normalized.title, 'Só título');
            assert.equal(normalized.category, 'outro', 'categoria inválida vira "outro"');
            assert.equal(normalized.priceCents, 0);
            assert.equal(normalized.published, true, 'assume publicado');
            assert.deepEqual(normalized.tags, []);
            assert.ok(normalized.createdAt > 0, 'createdAt deve ser preenchido');
        });

        testRunner.it('normalizeProduct corrige tipos errados vindos de JSON', () => {
            const normalized = normalizeProduct({
                title: 42,
                priceCents: '19,90',
                tags: 'não-é-array',
                published: 'talvez',
            });

            assert.equal(normalized.title, '', 'número não é título');
            assert.equal(normalized.priceCents, 0, 'string de preço é descartada');
            assert.deepEqual(normalized.tags, [], 'string não é array de tags');
            assert.equal(normalized.published, true, 'apenas false despublica');
        });

        testRunner.it('defaultSettings expõe padrões coerentes', () => {
            const settings = defaultSettings();
            assert.equal(settings.theme, 'light');
            assert.equal(settings.sidebarSide, 'left');
            assert.notOk(settings.sidebarCollapsed, 'a v4 iniciava colapsada; aqui o padrão é expandida');
            assert.equal(settings.version, 1, 'versão presente para migrações');
        });
    });
}
