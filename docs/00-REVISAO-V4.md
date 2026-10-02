# Revisão da v4 → plano da v5

Auditoria de `/home/sv/projetos/my-spa/v4`, feita lendo o código, o histórico de
conversas do projeto e **executando** o build e os testes.

Resumo: a v4 tem uma arquitetura bem intencionada (camadas separadas, tipagem,
JSDoc), mas **não funcionava ponta a ponta** e a suíte de testes dava verde
mesmo com falhas. Foram encontrados **16 problemas**, agrupados por severidade —
os dois últimos (no fim do documento) foram descobertos ao implementar o modo de
distribuição da v5.

---

## 🔴 Bloqueadores

### 1. A aplicação não renderizava (página em branco)

**Sintoma.** Ao abrir `dist/index.html`, o `<div id="app">` ficava vazio.

**Causa.** Três defeitos somados:

- `src/css/style.css` tem **0 bytes**. O `index.html` gerado aponta para ele:
  ```html
  <link rel="stylesheet" href="css/style.css">
  ```
  Os 8.582 bytes de estilo real estão em `global.css`, que nunca é referenciado.

- O build injeta `<script type="module" src="ts/main.js">`. Módulos ESM são
  bloqueados por CORS sob `file://`, então abrir o arquivo direto não executa nada.

- O `compiler.js` copia assets de `src/` recursivamente e **sobrescreve**
  `dist/css/style.css` com a versão vazia de `src/css/`.

**Correção na v5.** Build gera **um único arquivo** com CSS e JS embutidos —
funciona por `file://` e não há mais referência a arquivo inexistente.
Verificado por `npm test` (checagens de autocontenção) e pelo E2E.

---

### 2. O build usa o template errado (`compiler.js:26`)

```js
vendorTemplate: path.resolve(__dirname, 'vendor/_index.html'),   // ← lê daqui
```

Mas o template em `builder/vendor/_index.html` é o **antigo**, com
`<div id="app">` e `<title>My Vanilla SPA</title>`.

O template atualizado (`vendor/_index.html`, na raiz, com
`<div id="app-root">` e `<title>Digital Store Pro</title>`) **nunca é usado**.
Por isso o HTML final tem a marca errada.

**Correção na v5.** Um único template, no caminho que o build realmente lê, com
verificação de que os marcadores `<!-- STYLES -->`/`<!-- SCRIPTS -->` existem.

---

### 3. Os testes eram todos falsos-positivos

```ts
// testRunner.ts (v4)
public it(description: string, testFn: TestFn): void {
    try {
        testFn();               // ← não aguarda a Promise
        this.testsPassed++;
        console.log(`✅ PASS: ${description}`);
    } catch (error: any) {
        this.testsFailed++;
        ...
    }
}
```

Todos os 12 testes são `async`. A Promise é criada e **descartada**: a rejeição
vira `unhandledrejection`, nunca é capturada, e o contador marca **PASS**.

Além disso:

- `expect(actual, expected)` usa `!==`. O primeiro teste compara dois **objetos**
  (`{ name: 'Cline', role: 'AI' }`), o que sempre resulta em `false` → deveria falhar.
- A suíte nunca chama `report()`. Mesmo que algo falhasse, o resumo não aparecia.
- `core.test.ts` nunca é importado por ninguém — os testes não rodam em produção.

**Correção na v5.** `TestRunner` mantém uma fila de promises e `it()` **aguarda**
cada teste; `assert` tem `deepEqual`; `run()` devolve o relatório; e
`tests/index.ts` registra as suítes, invocado no boot. Os 88 testes passam em
navegador real (validado por E2E).

---

### 4. `src/js/` vazio e import quebrado

`README.md` documenta uma estrutura com `src/js/{appState,storage,router,...}.js`.
A pasta existe e está **vazia**. Referências ao código antigo (`main.js`,
`modules/`, `core/`) não existem.

**Correção na v5.** Documentação alinhada ao código real; a estrutura descrita no
README é a que o build usa.

---

## 🟠 Bugs de correção

### 5. Edição não carregava os dados — *relatado pelo usuário no log*

No histórico de conversas (`conversation-2026-09-20T04-10-50.md`), o usuário
relata: *"parte de edição não carregou os dados na hora de editar"*.

A causa discutida foi `id` numérico vs. string com comparação estrita. A v5
resolve isso na raiz, com `core/routeParams.ts`:

- `idFromRouteParam()` decodifica com `try/catch` (ids como `caf%C3%A9` quebravam
  com `URIError` lançado por `decodeURIComponent`);
- `findByIdLoose()` compara ids de forma **tolerante a tipo e caixa**
  (`42` casa com `"42"`), cobrindo backups antigos com ids numéricos.

Coberto por teste unitário e por E2E (`test_edit_route_loads_existing_data`, que
usa o id acentuado `café-123`).

---

### 6. Rota registrada ≠ view renderizada (dessincronização)

`main.ts` (v4) registrava rotas que só faziam `console.log`:

```ts
router.addRoute('/produtos', () => {
    console.log('[Router] Renderizando Produtos View');   // não renderiza nada
});
```

E o `App` decidia a view por conta própria, lendo `window.location.pathname`:

```ts
private handleRouteChange(path: string): void {
    if (path === '/' || path === '') { this.loadView(new HomeView()); }
    else if (path === '/produtos') { this.loadView(new ProductsView(this.appState)); }
}
```

Duas fontes de verdade. Se o router e o `App` divergirem (ex: `popstate`,
`/produtos/` com barra final, rota com parâmetro), uma view errada ou nenhuma
view é montada. Rotas como `/produto/:id` e `/admin/editar/:id` — essenciais para
o fluxo do projeto — eram **impossíveis** nesse desenho.

**Correção na v5.** Rotas registradas com handlers que montam a view, recebendo
`context.params` e `context.query`. O router é a única fonte de verdade.

---

### 7. XSS armazenado

`ProductsView.renderProductsList()` (v4):

```ts
listContainer.innerHTML = products.map(product => `
    <h3>${product.title}</h3>
    <span class="product-category">${product.category}</span>
`).join('');
```

O próprio system prompt do projeto (`prompts/PROMPT-GEMMA-4-26B-A4B.md`, §7)
exige *"Sanitização rigorosa do HTML… evitando vulnerabilidades de Injeção de
Script"*. Um produto com título `<img src=x onerror=alert(1)>` executa script.

A v4 tem `Utils.escapeHtml` implementado, mas **não o usa** aqui.

**Correção na v5.** Template tag `html` que escapa toda interpolação por padrão;
conteúdo confiável exige `raw()` explícito. Teste E2E confirma que
`window.__pwned` nunca é setado.

---

### 8. Primeira leitura podia perder a corrida

`storage.ts` (v4):

```ts
constructor(config: StorageConfig) {
    this.dbName = config.dbName;
    this.storeName = config.storeName;
    this.init();          // ← não aguardado
}
```

`init()` é `async` e não é aguardado. Um `get()` chamado logo depois encontra
`isIndexedDBAvailable === false` e cai no `LocalStorage` — que está vazio —
retornando `null`. Dados "desaparecem" de forma intermitente.

Agravante: `AppState.init()` faz `await this.storage.get(...)`, mas o
`StorageAdapter` pode não ter terminado de abrir o banco.

**Correção na v5.** `init()` é aguardado no boot antes de qualquer leitura, e
usar o storage antes disso lança `STORAGE_UNAVAILABLE` (falha explícita em vez de
silenciosa). Há teste para isso.

---

### 9. `QuotaExceededError` engolido

O system prompt exige tratamento explícito de cota (§1). A v4 captura e faz
fallback silencioso:

```ts
if (error.name === 'QuotaExceededError') {
    console.error('[Storage] Erro Crítico: Limite de armazenamento excedido!');
    // ...e segue para o fallback, que também vai falhar
}
```

O usuário nunca é avisado e o dado não é salvo.

**Correção na v5.** `QuotaExceededError` tipado, propagado quando **nenhum**
driver consegue salvar, exibido como toast com instrução acionável (exportar
backup, remover imagens grandes). Detecta as variações de navegador
(`NS_ERROR_DOM_QUOTA_REACHED`, código 22/1014).

---

### 10. Estado revertido sem avisar (perda silenciosa)

`appState.ts` (v4):

```ts
this.state = { ...this.state, ...newState };
try {
    await this.storage.set(this.storageKey, this.state);
} catch (error) {
    this.state = oldState;      // ← desfaz
    throw error;
}
this.notify();
```

Se a persistência falha, o estado em memória é revertido, mas a UI **já mostrou**
a mudança ao usuário e nada re-renderiza. A tela mostra algo que não está salvo,
sem indicação alguma.

**Correção na v5.** O estado permanece (o usuário viu a mudança) e a falha é
reportada por `onPersistError`, virando um toast de "não foi possível salvar".

---

### 11. Imutabilidade não garantida

```ts
public getState(): T {
    return { ...this.state };   // cópia RASA
}
```

O comentário diz *"Retornamos uma cópia para evitar mutações diretas"*, mas uma
cópia rasa preserva as referências de `products`, `settings`, `formSchema`.
`getState().products.push(x)` muta o array interno. O teste
`'Deve manter a imutabilidade do estado'` só testa um campo primitivo
(`currentTheme`) — que funcionaria mesmo com cópia rasa — então nunca detectou o
problema.

**Correção na v5.** `deepFreeze()` no estado inteiro. Mutação lança em strict mode.
Testes cobrem array e objeto aninhado.

---

### 12. Componentes não são reativos apesar de "reativos"

`BaseComponent.subscribeToState` guarda um único `unsubscribe`, e
`ProductsView.render()` chama `setupEventListeners()` com `setTimeout(0)`:

```ts
private setupEventListeners(): void {
    setTimeout(() => {
        const btnAdd = this.element.querySelector('#btn-add-product');
        if (btnAdd) btnAdd.addEventListener('click', () => this.toggleForm());
    }, 0);
}
```

Depois de um `update()` que recria o DOM, os listeners se perdem — o botão
"Novo Produto" para de funcionar. O `setTimeout` é um paliativo para o fato de o
elemento ainda não existir quando o handler é ligado.

**Correção na v5.** `Component.delegate()` usa delegação de eventos por
`data-action` na raiz do componente — sobrevive a qualquer re-render. Listeners e
timeouts são registrados com `listen()`/`setTimeout()` e limpos no `unmount()`.

---

### 13. Roteador: `popstate` não reavalia a rota corretamente

```ts
window.addEventListener('popstate', () => {
    this.currentPath = window.location.pathname;
    this.notify();          // ← não chama executeRoute()
});
```

O `notify()` avisa assinantes, mas `executeRoute()` — que dispara o handler da
rota — não roda. Além disso, só há `pushState`, nunca `replaceState`, então
`navigate()` para o path atual empilha entradas duplicadas no histórico.

**Correção na v5.** `dispatch()` notifica **e** executa o handler, em ambos os
caminhos (`popstate` e `navigate`); `navigate()` aceita `{ replace: true }` e
evita empilhar paths idênticos.

---

## 🟡 Manutenção e dívida técnica

### 14. Código morto, duplicado e inconsistente

- **`isObject` não existe.** `utils.ts` (v4) usa `isEmpty` que chama `isObject(...)`
  — função nunca definida nem importada. Erro de runtime em qualquer chamada real
  de `isEmpty` com objeto. (A v5 implementa `isPlainObject` e testa.)
- **`utils.ts` inteiro é código morto**: nunca é importado.
- **`ProductsView` declara `interface Product`** local, conflitando com o
  domínio. A v5 centraliza os tipos em `core/types.ts`.
- **Preço como `float`.** `price: parseFloat(...)` e `R$ ${price.toFixed(2)}`
  acumulam erro de ponto flutuante. A v5 usa **centavos inteiros** (`priceCents`)
  e converte na borda (`parsePriceToCents`, que entende `19,90` e `1.234,56`).
- **CSS duplicado.** `global.css` redefine `:root`, `.form-container`,
  `.form-group` e `.product-grid`/`.products-grid` em dois blocos.
- **`docs/*.md` (6 arquivos) vazios** (0 bytes).
- **`tsconfig` sem `lib`/`noImplicitOverride`**, e `include: ["src/**/*"]` faz o
  `tsc` processar também CSS/HTML.
- **Sem versionamento.** Sem git, sem CHANGELOG: as v1–v4 sobreviveram como
  pastas soltas e um `v4.zip` de 73 MB (contendo `node_modules` e `venv`).

---

## O que a v5 mudou em números

| | v4 | v5 |
|---|---|---|
| Artefato de deploy | 15 arquivos | **1** (`dist/index.html`) |
| Funciona via `file://` | ❌ | ✅ |
| Verificação do build | nenhuma | 20 checagens (`npm test`) |
| Testes que realmente rodam | 0 de 12 | **88** |
| Testes E2E | 1 | **17** |
| Tratamento de cota | engolido | erro tipado + toast |
| XSS no cadastro | vulnerável | escapado + teste |
| Imutabilidade | só na aparência | `deepFreeze` profundo |
| Edição de produto | quebrada | tolerante a tipo/caixa + E2E |
| Preço | `float` | centavos inteiros |

---

## Extra: descobertas ao implementar a v5

### 15. `file://` não suporta History API

Problema que **não existia na v4** (ela não tinha roteamento funcional), mas que
inviabilizaria o modo de distribuição principal da v5.

O requisito é abrir `dist/index.html` direto do disco. Testando em Chromium,
três restrições apareceram:

1. `history.pushState` lança
   `SecurityError: A history state object with URL 'file:///' cannot be created in a document with origin 'null'`;
2. `location.pathname` é o caminho do arquivo (`/home/user/dist/index.html`) —
   o `Router` logava *"Nenhuma rota registrada para
   /home/sv/projetos/my-spa/v5/dist/index.html"*;
3. `href="/produtos"` dispararia navegação real para `file:///produtos`
   (arquivo inexistente).

Sem tratamento, a vitrine não renderizava via `file://` — justamente o cenário
que a v5 existe para atender.

**Correção.** Dois modos de roteamento, detectados automaticamente: `history`
em `http(s)://`, `hash` (`#/produto/42`) em `file://`. Detalhes em
[`01-Arquitetura.md`](01-Arquitetura.md).

Coberto por `py-tests/test_file_protocol.py`, que abre o artefato via `as_uri()`
e verifica: shell montado, **CSS aplicado** (o bug da v4: `style.css` de 0
bytes), zero requisições externas e funcionamento em modo offline.

### 16. Testes de roteador sabotavam a aplicação

Enquanto o `Router` falava diretamente com `window`, os testes de rota navegavam
na URL **real da página em que a suíte executa**. `navigate('/a')`,
`navigate('/b')`, `navigate('/nao-existe')` empilhavam paths na barra de
endereços, disparavam `hashchange` e deixavam a aplicação fora de qualquer rota
registrada — a tela ficava em branco e quatro testes E2E falhavam.

Não era bug da aplicação: o **teste** estava sabotando o objeto testado.

**Correção.** O acesso a `location`/`history` passou a ser injetável
(`core/routerEnv.ts`); os testes usam `createFakeEnv()`, um ambiente em memória.
Isolado, determinístico e sem efeitos globais.

---

## Nota sobre as conversas do projeto

`conversations/conversation-2026-09-20T04-10-20.md` (95 KB) e
`…04-10-50.md` (47 KB) documentam a evolução real: o pedido inicial (vender PDFs,
músicas e planilhas numa página única com cadastro/import/export), seguido de
edições incrementais — editar, sidebar colapsável e reposicionável, tema com
versionamento, e o bug de dados de teste duplicando no IndexedDB.

Pontos dessas conversas que a v5 implementa:

- **Teste atômico** — o pedido era *"coloca unique id test pra ele não se
  replicar cada vez que a página carregar"*. A v5 resolve de forma mais limpa:
  o runner é **idempotente** (`runTestSuite` guarda a Promise) e os testes usam
  drivers em memória, sem tocar no banco real em nenhum momento.
- **Sidebar colapsável, inicia contraída, troca de lado** — implementado em
  `ui/Sidebar.ts` + CSS grid; preferências persistidas com campo `version`.
- **Editar** — `views/ProductFormView.ts`, com o mesmo formulário servindo
  criação e edição.
- **Import/export** — `data/backupService.ts`, com validação no caminho de entrada.

A v5 mantém a intenção arquitetural da v4 (camadas, tipagem estrita, JSDoc
completo, offline-first, zero dependências) e corrige a execução.
