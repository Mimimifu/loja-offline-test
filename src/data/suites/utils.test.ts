/**
 * @file tests/suites/utils.test.ts
 * @description Testes das funções utilitárias puras.
 * Invariante coberta: funções puras não dependem de DOM nem de I/O.
 */

import { assert, testRunner } from '../testRunner';
import {
    clamp,
    escapeHtml,
    formatCurrency,
    isEmpty,
    isPlainObject,
    isSafeUrl,
    matchesSearch,
    normalizeForSearch,
    parsePriceToCents,
    truncate,
} from '../../core/utils';

/** Registra a suíte de utilitários. */
export function registerUtilsSuite(): void {
    testRunner.describe('🔤 [Utils] Funções puras', () => {
        testRunner.it('normalizeForSearch remove acentos e caixa', () => {
            assert.equal(normalizeForSearch('Café À Lá'), 'cafe a la');
            assert.equal(normalizeForSearch('  PLANILHA  '), 'planilha');
        });

        testRunner.it('matchesSearch encontra termos acentuados sem acento', () => {
            assert.ok(matchesSearch('Guia de Mixação Profissional', 'mixacao'), 'deveria encontrar "mixacao"');
            assert.ok(matchesSearch('Áudio em Alta Fidelidade', 'AUDIO alta'), 'deveria casar múltiplos termos');
            assert.notOk(matchesSearch('Planilha financeira', 'guitarra'), 'não deveria encontrar termo ausente');
        });

        testRunner.it('matchesSearch com termo vazio retorna true', () => {
            assert.ok(matchesSearch('qualquer coisa', ''), 'consulta vazia não deve filtrar');
        });

        testRunner.it('parsePriceToCents interpreta formatos pt-BR e en-US', () => {
            assert.equal(parsePriceToCents('19,90'), 1990);
            assert.equal(parsePriceToCents('19.90'), 1990);
            assert.equal(parsePriceToCents('1.234,56'), 123456);
            assert.equal(parsePriceToCents('R$ 5'), 500);
            assert.equal(parsePriceToCents(''), 0);
        });

        testRunner.it('formatCurrency formata centavos como BRL', () => {
            const formatted = formatCurrency(1990);
            assert.ok(formatted.includes('19,90'), `esperado "19,90" em "${formatted}"`);
        });

        testRunner.it('truncate corta em fronteira de palavra', () => {
            assert.equal(truncate('abcdef', 10), 'abcdef');
            assert.includes(truncate('uma frase consideravelmente longa', 20), '…');
        });

        testRunner.it('escapeHtml neutraliza payload de XSS', () => {
            const escaped = escapeHtml('<img src=x onerror="alert(1)">');
            assert.notOk(escaped.includes('<'), 'não deve restar "<"');
            assert.includes(escaped, '&lt;img');
            assert.includes(escaped, '&quot;');
        });

        testRunner.it('isEmpty identifica valores vazios', () => {
            assert.ok(isEmpty(''), 'string vazia');
            assert.ok(isEmpty('   '), 'string em branco');
            assert.ok(isEmpty([]), 'array vazio');
            assert.ok(isEmpty({}), 'objeto vazio');
            assert.ok(isEmpty(null), 'null');
            assert.ok(isEmpty(undefined), 'undefined');
            assert.notOk(isEmpty([1]), 'array com item');
            assert.notOk(isEmpty({ a: 1 }), 'objeto com chave');
            assert.notOk(isEmpty(0), 'zero não é vazio');
        });

        testRunner.it('isPlainObject diferencia objetos de arrays e null', () => {
            assert.ok(isPlainObject({}), 'objeto literal');
            assert.notOk(isPlainObject([]), 'array não é objeto plano');
            assert.notOk(isPlainObject(null), 'null não é objeto plano');
            assert.notOk(isPlainObject('texto'), 'string não é objeto plano');
        });

        testRunner.it('isSafeUrl aceita http(s) e data-URL de imagem', () => {
            assert.ok(isSafeUrl('https://exemplo.com/arquivo.pdf'), 'https');
            assert.ok(isSafeUrl('http://exemplo.com'), 'http');
            assert.ok(isSafeUrl(''), 'campo vazio é válido');
            assert.ok(isSafeUrl('data:image/png;base64,iVBORw0KGgo='), 'data-URL de imagem');
            assert.notOk(isSafeUrl('javascript:alert(1)'), 'javascript: deve ser rejeitado');
        });

        testRunner.it('clamp limita valores ao intervalo', () => {
            assert.equal(clamp(5, 0, 10), 5);
            assert.equal(clamp(-3, 0, 10), 0);
            assert.equal(clamp(42, 0, 10), 10);
        });
    });
}
