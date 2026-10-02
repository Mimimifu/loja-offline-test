/**
 * @file tests/suites/repository.test.ts
 * @description Testes do repositório de produtos e da fila de sincronização.
 */

import { assert, testRunner } from '../testRunner';
import { AppState, createInitialState } from '../../core/appState';
import { StorageAdapter, IStorageDriver } from '../../core/storage';
import { ProductRepository } from '../../data/productRepository';
import { AppStateData, Product } from '../../core/types';

/** Driver em memória simples. */
class MemoryDriver implements IStorageDriver {
    public readonly name = 'Memory';
    private readonly map = new Map<string, string>();
    async isAvailable(): Promise<boolean> {
        return true;
    }
    async get<T>(key: string): Promise<T | null> {
        const raw = this.map.get(key);
        return raw === undefined ? null : (JSON.parse(raw) as T);
    }
    async set<T>(key: string, value: T): Promise<void> {
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

/** Cria estado + repositório isolados. */
async function createRepo(): Promise<{ repo: ProductRepository; state: AppState<AppStateData> }> {
    const storage = new StorageAdapter({ dbName: 'x', storeName: 'y' }, [new MemoryDriver()]);
    await storage.init();

    const state = new AppState<AppStateData>(storage, createInitialState());
    await state.init();

    return { repo: new ProductRepository(state), state };
}

/** Fábrica de produto de teste. */
function makeProduct(overrides: Partial<Product> = {}): Product {
    return {
        id: overrides.id ?? `id-${Math.random().toString(36).slice(2, 8)}`,
        title: 'Produto',
        category: 'pdf',
        priceCents: 1000,
        description: 'Descrição',
        image: '',
        paymentLink: '',
        downloadLink: '',
        paymentLabel: 'Comprar',
        tags: [],
        published: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...overrides,
    };
}

/** Registra a suíte de repositório. */
export function registerRepositorySuite(): void {
    testRunner.describe('📚 [Repository] Produtos', () => {
        testRunner.it('create adiciona produto e enfileira operação', async () => {
            const { repo, state } = await createRepo();

            repo.create(makeProduct({ id: 'p1', title: 'Primeiro' }));

            assert.equal(repo.getAll().length, 1, 'produto deve ser adicionado');
            assert.equal(state.select('pendingOps').length, 1, 'operação deve entrar na fila');
            assert.equal(state.select('pendingOps')[0].kind, 'create', 'tipo correto na fila');
        });

        testRunner.it('update substitui o produto pelo id', async () => {
            const { repo } = await createRepo();
            repo.create(makeProduct({ id: 'p1', title: 'Antes' }));

            repo.update(makeProduct({ id: 'p1', title: 'Depois' }));

            assert.equal(repo.getAll().length, 1, 'não deve duplicar');
            assert.equal(repo.requireById('p1').title, 'Depois', 'título atualizado');
        });

        testRunner.it('update de id inexistente lança NOT_FOUND', async () => {
            const { repo } = await createRepo();

            const error = await assert.throws(() => repo.update(makeProduct({ id: 'fantasma' })));
            assert.equal((error as { code: string }).code, 'NOT_FOUND');
        });

        testRunner.it('remove exclui o produto', async () => {
            const { repo } = await createRepo();
            repo.create(makeProduct({ id: 'p1' }));

            repo.remove('p1');

            assert.equal(repo.getAll().length, 0);
            assert.equal(repo.getById('p1'), null);
        });

        testRunner.it('remove de id inexistente lança NOT_FOUND', async () => {
            const { repo } = await createRepo();
            const error = await assert.throws(() => repo.remove('nada'));
            assert.equal((error as { code: string }).code, 'NOT_FOUND');
        });

        testRunner.it('duplicate cria cópia despublicada com novo id', async () => {
            const { repo } = await createRepo();
            repo.create(makeProduct({ id: 'orig', title: 'Original', published: true }));

            const copy = repo.duplicate('orig');

            assert.notEqual(copy.id, 'orig', 'id deve ser diferente');
            assert.equal(copy.published, false, 'cópia nasce como rascunho');
            assert.includes(copy.title, '(cópia)');
            assert.equal(repo.getAll().length, 2, 'original deve permanecer');
        });

        testRunner.it('getStats resume o inventário', async () => {
            const { repo } = await createRepo();
            repo.create(makeProduct({ id: 'a', priceCents: 1000, published: true }));
            repo.create(makeProduct({ id: 'b', priceCents: 3000, published: false }));

            const stats = repo.getStats();

            assert.equal(stats.total, 2);
            assert.equal(stats.published, 1);
            assert.equal(stats.drafts, 1);
            assert.equal(stats.avgPriceCents, 2000);
            assert.equal(stats.inventoryCents, 4000);
        });

        testRunner.it('list oculta rascunhos na vitrine', async () => {
            const { repo } = await createRepo();
            repo.create(makeProduct({ id: 'a', published: true }));
            repo.create(makeProduct({ id: 'b', published: false }));

            assert.equal(repo.list().length, 1, 'vitrine mostra só publicados');
            assert.equal(repo.list({ includeUnpublished: true }).length, 2, 'admin vê tudo');
        });

        testRunner.it('list filtra por categoria', async () => {
            const { repo } = await createRepo();
            repo.create(makeProduct({ id: 'a', category: 'pdf' }));
            repo.create(makeProduct({ id: 'b', category: 'musica' }));

            assert.equal(repo.list({ category: 'pdf' }).length, 1);
            assert.equal(repo.list({ category: 'musica' })[0].id, 'b');
            assert.equal(repo.list({ category: 'todas' }).length, 2);
        });

        testRunner.it('list busca por texto ignorando acentos', async () => {
            const { repo } = await createRepo();
            repo.create(makeProduct({ id: 'a', title: 'Guia de Mixação' }));
            repo.create(makeProduct({ id: 'b', title: 'Planilha Financeira' }));

            assert.equal(repo.list({ query: 'mixacao' })[0].id, 'a', 'busca sem acento deve encontrar');
            assert.equal(repo.list({ query: 'FINANCEIRA' })[0].id, 'b', 'busca insensível a caixa');
            assert.equal(repo.list({ query: 'guitarra' }).length, 0, 'termo ausente não retorna nada');
        });

        testRunner.it('list ordena por preço, título e recência', async () => {
            const { repo } = await createRepo();
            repo.create(makeProduct({ id: 'caro', priceCents: 5000, title: 'Zebra', updatedAt: 100 }));
            repo.create(makeProduct({ id: 'barato', priceCents: 100, title: 'Abacaxi', updatedAt: 300 }));

            assert.equal(repo.list({ sortBy: 'price-asc' })[0].id, 'barato');
            assert.equal(repo.list({ sortBy: 'price-desc' })[0].id, 'caro');
            assert.equal(repo.list({ sortBy: 'title' })[0].id, 'barato', '"Abacaxi" vem antes de "Zebra"');
            assert.equal(repo.list({ sortBy: 'recent' })[0].id, 'barato', 'mais recente primeiro');
        });

        testRunner.it('countByCategory agrupa corretamente', async () => {
            const { repo } = await createRepo();
            repo.create(makeProduct({ category: 'pdf' }));
            repo.create(makeProduct({ category: 'pdf' }));
            repo.create(makeProduct({ category: 'musica' }));

            const counts = repo.countByCategory();
            assert.equal(counts.pdf, 2);
            assert.equal(counts.musica, 1);
        });

        testRunner.it('replaceAll troca a coleção inteira (importação)', async () => {
            const { repo } = await createRepo();
            repo.create(makeProduct({ id: 'antigo' }));

            repo.replaceAll([makeProduct({ id: 'novo-1' }), makeProduct({ id: 'novo-2' })]);

            assert.equal(repo.getAll().length, 2);
            assert.equal(repo.getById('antigo'), null, 'coleção anterior deve ser substituída');
        });

        testRunner.it('cada mutação registra uma operação pendente distinta', async () => {
            const { repo, state } = await createRepo();

            repo.create(makeProduct({ id: 'p1' }));
            repo.update(makeProduct({ id: 'p1', title: 'editado' }));
            repo.remove('p1');

            const ops = state.select('pendingOps');
            assert.equal(ops.length, 3, 'três operações registradas');
            assert.deepEqual(
                ops.map((op) => op.kind),
                ['create', 'update', 'delete'],
                'ordem e tipos devem ser preservados',
            );
        });
    });
}
