# Arquitetura

## Princípios

1. **Fluxo de dados unidirecional.** view → repositório → `AppState` → assinantes → view.
2. **Infraestrutura não conhece UI.** Nada em `core/` importa de `views/` ou `ui/`.
3. **Puro por padrão.** A lógica testável (`core/utils`, `core/schema`,
   `core/routeParams`) não depende de DOM e roda em Node.
4. **Zero dependências de runtime.** TypeScript é a única `devDependency`.
5. **Falha explícita.** Usar `StorageAdapter` antes de `init()` lança; cota
   excedida propaga; esquema inválido é rejeitado com a linha do problema.

---

## Camadas

```
┌──────────────────────────────────────────────────────────┐
│  views/            uma por rota, sem estado global       │
│    StoreView  ProductDetailView  AdminView               │
│    ProductFormView  SettingsView                         │
├──────────────────────────────────────────────────────────┤
│  ui/               componentes reutilizáveis             │
│    Header  Sidebar  ProductCard  DynamicForm             │
│    modal  toast                                          │
├──────────────────────────────────────────────────────────┤
│  data/             regras de coleção                     │
│    ProductRepository        CRUD, filtros, outbox        │
│    backupService            export/import validado       │
├──────────────────────────────────────────────────────────┤
│  core/             infraestrutura                        │
│    storage   appState   router   schema   http   dom     │
│    errors    routeParams   types   utils                 │
└──────────────────────────────────────────────────────────┘
```

### `core/`

| Módulo | Responsabilidade |
|---|---|
| `storage.ts` | `StorageAdapter` com drivers IndexedDB + LocalStorage em **write-through**. `init()` obrigatório. `update()` faz read-modify-write. |
| `appState.ts` | Estado observável, congelado em profundidade, persistência coalescida por tick, `onPersistError` para falhas. |
| `router.ts` | History API, padrões `/produto/:id`, `context.query`, `navigate({ replace })`, delegação de cliques em `<a>` internos. |
| `schema.ts` | Motor de formulários JSON: `getByPath`/`setByPath`, `parseFieldValue`/`serializeFieldValue`, `validateAgainstSchema`, `validateSchemaShape`. |
| `http.ts` | `HttpClient` sobre `fetch` com timeout via `AbortController` e erros tipados. |
| `dom.ts` | `Component` base (ciclo de vida, delegação, limpeza) e a template tag `html` que escapa por padrão. |
| `errors.ts` | `AppError` com `code` estável + subclasses. `toAppError` normaliza qualquer valor lançado. |
| `routeParams.ts` | Decodificação tolerante de parâmetros e comparação de ids independente de tipo/caixa. |
| `utils.ts` | Funções puras: busca sem acento, moeda, `deepFreeze`, `debounce`, escape, I/O de arquivo. |

### `data/`

`ProductRepository` é a **única** porta de entrada para mutações de produto.
Nenhuma view chama `appState.setState({ products: ... })` diretamente. Toda
mutação também registra uma `PendingOperation` na fila de sincronização (padrão
*outbox*), permitindo saber exatamente o que falta enviar à API.

### `views/`

Cada view é um `Component`. Recebe suas dependências por construtor (injeção),
busca dados no repositório, renderiza e **não guarda estado de domínio**.

---

## Fluxo de dados

```
usuário clica "Salvar"
        │
        ▼
DynamicForm.onSubmit(values)              valores brutos (strings)
        │
        ▼
formValuesToProduct(schema, values, base)  ← core/schema.ts
   ├─ parseFieldValue       ("19,90" → 1990 centavos)
   ├─ validateAgainstSchema (lança ValidationError com erros por campo)
   └─ normalizeProduct      (garante todos os campos do tipo Product)
        │
        ▼
ProductRepository.create(product)
   ├─ appState.setState({ products: [...] })
   └─ enqueue('create', id)                → pendingOps
        │
        ▼
AppState.setState(patch)
   ├─ deepFreeze(novo estado)
   ├─ notify(subscribers, changedKeys)
   └─ schedulePersist()  (coalescido, 1 escrita por tick)
        │
        ▼
assinantes re-renderizam (Sidebar, views ativas, Header)
```

---

## Ciclo de vida de um componente

```ts
export class MinhaView extends Component {
    constructor(deps) { super('div', 'page minha-view'); }

    protected render(): SafeHtml {          // 1. HTML (interpolação escapada)
        return html`<h2>${this.titulo}</h2>`;
    }

    protected afterRender(): void {          // 2. após cada render
        this.delegate('click');              //    delegação por data-action
    }

    private onSalvar(el: HTMLElement): void { /* ação */ }
}
```

`delegate()`, `listen()` e `setTimeout()` registram recursos que são liberados
automaticamente no `unmount()` ou antes do próximo `update()`.

**Delegação por `data-action`.** Em vez de ligar listeners em cada botão (que se
perdem a cada re-render), um único listener na raiz do componente resolve
`data-action="nome"` para o método `onNome`. Um handler sobrevive a qualquer
re-render.

---

## Imutabilidade

`AppState.getState()` devolve o estado **congelado em profundidade**. Isso
converte uma classe inteira de bugs silenciosos (mutação acidental do estado por
referência) em erros imediatos:

```ts
const state = appState.getState();
state.products.push(x);        // TypeError: object is not extensible
state.settings.theme = 'dark'; // TypeError em strict mode
```

Alterações legítimas passam por `setState({ products: [...state.products, x] })`.

---

## Roteamento em dois modos

A aplicação precisa funcionar **tanto** servida por HTTP **quanto** aberta
diretamente do disco (`file://`) — este último é o cenário de distribuição
principal (um arquivo único, sem servidor). Os dois ambientes têm capacidades
diferentes, então o roteador opera em dois modos e os detecta automaticamente:

| Ambiente | Modo | URL |
|---|---|---|
| `http(s)://` | `history` | `/produto/42` |
| `file://` | `hash` | `#/produto/42` |

### Por que `file://` não pode usar History API

Três restrições, todas verificadas em Chromium:

1. **Origem `null`.** `history.pushState` lança
   `SecurityError: A history state object with URL 'file:///' cannot be created in a document with origin 'null'`.
2. **Pathname é o arquivo.** `location.pathname` é
   `/home/user/dist/index.html`, não uma rota — qualquer matching falharia.
3. **Recarregar rota não existe.** Não há servidor para responder `/produto/42`.

O modo hash resolve os três: o fragmento não exige origem, não é afetado pelo
pathname e sobrevive a reload sem servidor.

### Como isso é invisível para as views

As views escrevem sempre `href="/produtos"` e chamam `router.navigate('/x')`.
Duas camadas traduzem:

- `Router.hrefFor()` converte para `#/produtos`;
- um `MutationObserver` no `App` reescreve os links existentes e os criados em
  re-renders, sem que cada view precise conhecer o modo.

### Degradação automática

Se `pushState` falhar em runtime (iframe sandboxed, por exemplo), `navigate()`
captura o erro, troca para o modo hash e repete a navegação — em vez de quebrar
a UI.

### Ambiente de navegação injetável

O acesso a `location`/`history` passa por `RouterEnv` (`core/routerEnv.ts`):

```ts
// produção
new Router();                                   // createBrowserEnv()

// testes
const env = createFakeEnv('file:', '/index.html');
new Router('', { env });
```

Isso não é só estilo. Antes dessa abstração, os testes de roteador navegavam na
**URL real da página em que a suíte roda**: `navigate('/a')`, `navigate('/b')`,
`navigate('/nao-existe')` empilhavam paths na barra de endereços, disparavam
`hashchange` e deixavam a aplicação fora de qualquer rota registrada — a tela
ficava em branco. O teste sabotava a aplicação que estava testando.

---

## Acessibilidade

- `role="dialog"` + `aria-modal` + `aria-labelledby` nos modais, com **focus trap**;
- `Esc` fecha o modal do topo; o foco **retorna ao elemento que abriu**;
- notificações em região `aria-live="polite"`;
- `aria-current="page"` no item de navegação ativo;
- erros de formulário ligados ao campo via `aria-describedby` + `aria-invalid`,
  e o foco vai para o primeiro campo inválido;
- skip-link para `#main-content`; `:focus-visible` sempre visível;
- `prefers-reduced-motion` desativa transições;
- filtros de daltonismo (protanopia, deuteranopia, tritanopia, acromatopsia);
- atalhos `Alt+N/P/A/C` e `Esc`, ignorados enquanto o usuário digita.

---

## Estrutura de arquivos

```
v5/
├── builder/
│   ├── compiler.js          compila TS + empacota + emite single-file
│   ├── check-dist.js        20 verificações pós-build
│   ├── serve.js             dev server com fallback SPA
│   └── vendor/_index.html   template do HTML final
├── docs/
├── py-tests/test_v5_e2e.py  13 testes Playwright
├── src/
│   ├── css/global.css       design system (embutido no build)
│   └── ts/                  (ver árvore no README)
├── dist/index.html          artefato final
├── package.json
└── tsconfig.json
```
