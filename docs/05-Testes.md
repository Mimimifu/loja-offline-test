# Testes

Duas camadas complementares:

| Camada | Onde | Quantidade | O que prova |
|---|---|---|---|
| Unitários in-browser | `src/ts/tests/` | 88 | lógica: storage, estado, schema, rota, repositório, utils |
| E2E | `py-tests/` | 17 | comportamento real em Chromium |

---

## Unitários

Rodam **automaticamente** ao carregar a página. O indicador no cabeçalho mostra
`✅ 88/88`; clicar abre o detalhamento por suíte. Em **Configurações → Testes**
há o botão **▶ Rodar novamente**.

```
🔤 [Utils] Funções puras              11
💾 [Storage] Persistência             11
🧠 [AppState] Estado observável        9
🧾 [Schema] Formulários dinâmicos     21
🗺️ [Router] Navegação                 13
📚 [Repository] Produtos              14
```

### Sem dependências

O runner (`tests/testRunner.ts`) é próprio: `describe` / `it` com hooks
(`beforeAll`, `beforeEach`, …) e um objeto `assert`.

### ⚠️ O runner é assíncrono — de propósito

```ts
it(name: string, fn: TestFn): void {
    this.chain = this.chain.then(async () => {
        await fn();          // ← aguarda de verdade
        // registra pass/fail
    });
}
```

O runner da v4 chamava `testFn()` sem `await`: como todos os testes eram `async`,
a Promise era descartada, a rejeição virava `unhandledrejection` e o contador
marcava **PASS**. A suíte dava 100% verde com tudo quebrado.

Se você escrever um teste `async`, ele é aguardado de fato.

### Escrevendo um teste

Adicione uma suíte em `src/ts/tests/suites/` e registre-a em `tests/index.ts`:

```ts
import { assert, testRunner } from '../testRunner';
import { formatCurrency } from '../../core/utils';

export function registerMinhaSuite(): void {
    testRunner.describe('🎯 [Minha] Coisa nova', () => {
        testRunner.it('formata valores com duas casas', () => {
            assert.equal(formatCurrency(100), 'R$ 1,00');
        });

        testRunner.it('lança com entrada inválida', async () => {
            const erro = await assert.throws(() => minhaFuncao(''));
            assert.equal((erro as AppError).code, 'VALIDATION');
        });
    });
}
```

```ts
// tests/index.ts
import { registerMinhaSuite } from './suites/minha.test';
export function registerAllSuites(): void {
    registerUtilsSuite();
    /* … */
    registerMinhaSuite();          // ← adicione aqui
}
```

Depois ajuste `MIN_EXPECTED_TESTS` em `py-tests/test_v5_e2e.py` — ele é uma trava
de regressão: se alguém remover um arquivo de suíte, o E2E acusa.

### Asserções

| Método | Uso |
|---|---|
| `assert.equal(a, b)` | igualdade estrita |
| `assert.deepEqual(a, b)` | estrutural (a v4 não tinha: comparava objetos com `!==`) |
| `assert.ok(v)` / `notOk(v)` | veracidade |
| `assert.throws(fn)` | espera exceção, devolve o erro |
| `assert.resolves(fn, ms)` | espera resolução dentro do tempo |
| `assert.includes(str, sub)` | substring |
| `assert.notEqual(a, b)` | diferença |

### Testes sem tocar no banco real

Testes de storage/estado usam drivers em memória:

```ts
class MemoryDriver implements IStorageDriver {
    private readonly map = new Map<string, string>();
    async isAvailable() { return true; }
    async get<T>(k: string) { /* … */ }
    // …
}

const storage = new StorageAdapter({ dbName: 'x', storeName: 'y' }, [new MemoryDriver()]);
await storage.init();
```

**Nenhum teste escreve no banco do usuário.** Na v4, o teste inseria um produto
real no IndexedDB a cada carregamento — o usuário relatou isso no log do projeto
("ele tá duplicando o test"), e a correção foi deletar o item depois. Aqui o
problema não existe por construção.

Drivers com falha injetável simulam cota excedida e erro de escrita
(`driver.failOnSet = 'quota'`).

---

## E2E (Playwright)

```bash
npm run test:e2e
```

Requer a venv da v4 (`/home/sv/projetos/my-spa/v4/py-tests/venv`). O fixture
`server` sobe `builder/serve.js` — com fallback SPA, sem o qual o reload em
`/config` retornaria 404.

| Teste | Verifica |
|---|---|
| `test_app_shell_renders` | header, sidebar e main presentes |
| `test_no_javascript_errors` | boot sem erros não capturados |
| `test_empty_state_visible_initially` | estado vazio, não grade em branco |
| `test_test_suite_passes_in_browser` | **os 88 testes passam no navegador** |
| `test_create_product_flow` | cadastro ponta a ponta + centavos exatos |
| `test_edit_route_loads_existing_data` | **regressão**: edição carrega dados (id acentuado) |
| `test_xss_payload_is_escaped` | injeção de HTML é neutralizada |
| `test_persistence_across_reload` | dados sobrevivem a reload em `/admin` |
| `test_backup_roundtrip` | export/import preserva produtos e esquema |
| `test_settings_panel_renders` | painel de configurações funcional |
| `test_theme_toggle_persists` | tema aplicado e persistido |
| `test_product_detail_flow` | download só após confirmar pagamento |
| `test_sidebar_navigation` | navegação client-side, sem reload |

Cada teste roda numa página nova (IndexedDB isolado por contexto).

### `file://` — `py-tests/test_file_protocol.py`

Prova o requisito central de distribuição: o artefato funciona aberto do disco.

| Teste | Verifica |
|---|---|
| `test_artifact_exists` | `dist/index.html` foi gerado |
| `test_opens_via_file_protocol` | shell monta, **CSS aplicado** (`getComputedStyle`), tokens ativos, sem erros |
| `test_no_network_requests` | zero requisições `http(s)://` — totalmente autocontido |
| `test_works_in_offline_mode` | funciona com `offline=True` no contexto do navegador |

Sob `file://` o roteador opera em **modo hash** (`#/rota`): `history.pushState`
lança `SecurityError` com origem `null`. Ver
[`01-Arquitetura.md`](01-Arquitetura.md#roteamento-em-dois-modos).

### Por que E2E

Os bugs mais graves da v4 não apareciam em teste unitário: página em branco por
`style.css` vazio, imports ESM bloqueados por CORS, `__m4 is not defined` no
bundle. Só um navegador real pega isso. O E2E também é a rede de segurança do
mini-bundler.

---

## Verificação do build

```bash
npm test        # build + 20 checagens do artefato
```

Inclui um **boot de fumaça**: o bundle é executado num `vm` com DOM simulado,
provando que a sintaxe é válida e não há referência de topo quebrada.

---

## Pipeline completo

```bash
npm test && npm run test:e2e
```

| Etapa | Cobre |
|---|---|
| `npm run build` | compilação estrita + empacotamento |
| `check-dist.js` | artefato autocontido, CSS presente, bundle válido |
| unitários | lógica de domínio e infraestrutura |
| E2E | integração real no navegador |

---

## Depuração

Console do navegador:

```js
app.state.getState()              // estado atual (congelado)
app.state.select('settings')      // fatia específica
app.repository.getStats()         // total, publicados, rascunhos
app.repository.list({ query: 'pdf', sortBy: 'price-asc' })
app.router.navigate('/admin')     // navegar programaticamente
app.storage.activeDrivers         // drivers ativos
```

O bundle é *não-minificado* e inclui os JSDoc: dá para depurar direto no
`dist/index.html`. O nome do arquivo-fonte original aparece em banner antes de
cada módulo:

```js
// ==== src/ts/core/schema.ts ====
```
