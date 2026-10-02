/**
 * @file tests/suites/storage.test.ts
 * @description Testes da camada de persistência.
 *
 * Inclui testes de regressão para bugs observados na v4:
 *  - a primeira leitura após o construtor retornava `null` porque `init()`
 *    não era aguardado (corrida entre abertura do IndexedDB e o primeiro `get`);
 *  - `QuotaExceededError` era engolido e virava fallback silencioso.
 */

import { assert, testRunner } from '../testRunner';
import { LocalStorageDriver, StorageAdapter, IStorageDriver } from '../../core/storage';
import { AppError, QuotaExceededError } from '../../core/errors';

/** Driver em memória, usado para testar o adaptador sem tocar em I/O real. */
class MemoryDriver implements IStorageDriver {
    public readonly name = 'Memory';
    private readonly map = new Map<string, string>();
    public failOnSet: 'quota' | 'generic' | null = null;

    async isAvailable(): Promise<boolean> {
        return true;
    }

    async get<T>(key: string): Promise<T | null> {
        const raw = this.map.get(key);
        return raw === undefined ? null : (JSON.parse(raw) as T);
    }

    async set<T>(key: string, value: T): Promise<void> {
        if (this.failOnSet === 'quota') throw new QuotaExceededError();
        if (this.failOnSet === 'generic') throw new Error('falha simulada');
        this.map.set(key, JSON.stringify(value));
    }

    async remove(key: string): Promise<void> {
        this.map.delete(key);
    }

    async clear(): Promise<void> {
        this.map.clear();
    }

    async keys(): Promise<string[]> {
        return [...this.map.keys()];
    }
}

/** Driver indisponível, para testar a seleção de drivers. */
class UnavailableDriver implements IStorageDriver {
    public readonly name = 'Indisponível';
    async isAvailable(): Promise<boolean> {
        return false;
    }
    async get<T>(): Promise<T | null> {
        throw new Error('não deveria ser chamado');
    }
    async set(): Promise<void> {
        throw new Error('não deveria ser chamado');
    }
    async remove(): Promise<void> {}
    async clear(): Promise<void> {}
    async keys(): Promise<string[]> {
        return [];
    }
}

/** Registra a suíte de armazenamento. */
export function registerStorageSuite(): void {
    testRunner.describe('💾 [Storage] Persistência', () => {
        testRunner.it('init() seleciona apenas drivers disponíveis', async () => {
            const memory = new MemoryDriver();
            const storage = new StorageAdapter({ dbName: 'x', storeName: 'y' }, [new UnavailableDriver(), memory]);

            await storage.init();

            assert.equal(storage.activeDriver, 'Memory', 'deve pular o driver indisponível');
            assert.equal(storage.activeDrivers.length, 1, 'apenas um driver ativo');
        });

        testRunner.it('get/set persistem e recuperam valores complexos', async () => {
            const storage = new StorageAdapter({ dbName: 'x', storeName: 'y' }, [new MemoryDriver()]);
            await storage.init();

            const payload = { nome: 'Café ☕', itens: [1, 2, 3], aninhado: { ok: true } };
            await storage.set('chave', payload);

            assert.deepEqual(await storage.get('chave'), payload, 'round-trip deve preservar o dado');
        });

        testRunner.it('get devolve null para chave inexistente', async () => {
            const storage = new StorageAdapter({ dbName: 'x', storeName: 'y' }, [new MemoryDriver()]);
            await storage.init();

            assert.equal(await storage.get('nao-existe'), null);
        });

        testRunner.it('remove apaga a chave e clear esvazia tudo', async () => {
            const storage = new StorageAdapter({ dbName: 'x', storeName: 'y' }, [new MemoryDriver()]);
            await storage.init();

            await storage.set('a', 1);
            await storage.set('b', 2);
            await storage.remove('a');

            assert.equal(await storage.get('a'), null, 'chave removida deve sumir');
            assert.deepEqual(await storage.keys(), ['b'], 'apenas "b" deve restar');

            await storage.clear();
            assert.equal((await storage.keys()).length, 0, 'clear deve esvaziar o storage');
        });

        testRunner.it('update aplica read-modify-write', async () => {
            const storage = new StorageAdapter({ dbName: 'x', storeName: 'y' }, [new MemoryDriver()]);
            await storage.init();
            await storage.set('contador', { valor: 1 });

            const updated = await storage.update<{ valor: number }>('contador', (current) => ({
                valor: (current?.valor ?? 0) + 41,
            }));

            assert.equal(updated.valor, 42, 'updater deve receber o valor atual');
            assert.equal((await storage.get<{ valor: number }>('contador'))?.valor, 42, 'mudança deve persistir');
        });

        testRunner.it('update em chave inexistente lança NotFoundError', async () => {
            const storage = new StorageAdapter({ dbName: 'x', storeName: 'y' }, [new MemoryDriver()]);
            await storage.init();

            const error = await assert.throws(() => storage.update('fantasma', () => 1));
            assert.equal((error as AppError).code, 'NOT_FOUND');
        });

        testRunner.it('uso antes de init() falha explicitamente', async () => {
            const storage = new StorageAdapter({ dbName: 'x', storeName: 'y' }, [new MemoryDriver()]);

            const error = await assert.throws(() => storage.get('qualquer'));
            assert.equal((error as AppError).code, 'STORAGE_UNAVAILABLE', 'deve exigir init() aguardado');
        });

        testRunner.it('cota excedida propaga QuotaExceededError quando todos os drivers falham', async () => {
            const first = new MemoryDriver();
            const second = new MemoryDriver();
            first.failOnSet = 'quota';
            second.failOnSet = 'quota';

            const storage = new StorageAdapter({ dbName: 'x', storeName: 'y' }, [first, second]);
            await storage.init();

            const error = await assert.throws(() => storage.set('grande', 'x'.repeat(10)));
            assert.equal((error as AppError).code, 'QUOTA_EXCEEDED', 'cota deve ser reportada, não engolida');
        });

        testRunner.it('write-through tolera falha parcial (ao menos um driver persiste)', async () => {
            const failing = new MemoryDriver();
            failing.failOnSet = 'quota';
            const healthy = new MemoryDriver();

            const storage = new StorageAdapter({ dbName: 'x', storeName: 'y' }, [failing, healthy]);
            await storage.init();

            // Não deve lançar: escrever em um driver já garante durabilidade.
            await storage.set('resistente', { ok: true });
            assert.deepEqual(await storage.get('resistente'), { ok: true });
        });

        testRunner.it('LocalStorageDriver isola chaves por prefixo', async () => {
            const driver = new LocalStorageDriver('teste:');
            assert.ok(await driver.isAvailable(), 'localStorage deve estar disponível');

            // Sujeira fora do prefixo não deve ser afetada por clear().
            localStorage.setItem('ruido-externo', 'preservar');

            await driver.set('produto', { id: 1 });
            assert.deepEqual(await driver.get('produto'), { id: 1 }, 'round-trip no localStorage');
            assert.deepEqual(await driver.keys(), ['produto'], 'keys deve listar sem o prefixo');

            await driver.clear();
            assert.equal(await driver.get('produto'), null, 'clear deve remover apenas o prefixo');
            assert.equal(localStorage.getItem('ruido-externo'), 'preservar', 'chaves externas devem sobreviver');
            localStorage.removeItem('ruido-externo');
        });

        testRunner.it('LocalStorageDriver descarta JSON corrompido em vez de quebrar', async () => {
            const driver = new LocalStorageDriver('corrompido:');
            localStorage.setItem('corrompido:quebrado', '{isso não é json');

            assert.equal(await driver.get('quebrado'), null, 'deve devolver null');
            assert.equal(localStorage.getItem('corrompido:quebrado'), null, 'deve limpar a entrada inválida');
        });
    });
}
