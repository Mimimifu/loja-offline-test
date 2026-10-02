# Digital Store Pro — v5

SPA vanilla em TypeScript para **vender e gerenciar produtos digitais** (PDFs, músicas, planilhas, cursos, templates).
Sem frameworks, sem dependências de runtime, offline-first.

> Esta versão nasce de uma revisão da **v4**. O relatório completo do que estava
> quebrado está em [`docs/00-REVISAO-V4.md`](docs/00-REVISAO-V4.md).

---

## ⚡ Começando

```bash
npm install          # apenas typescript (devDependency)
npm run build        # gera dist/index.html — arquivo único
```

Depois, **abra `dist/index.html` no navegador**. Não precisa de servidor.

### Comandos

| Comando | O que faz |
|---|---|
| `npm run build` | Compila o TS e gera o artefato `dist/index.html` |
| `npm test` | Build + 20 verificações do artefato (autocontenção, CSS, sintaxe) |
| `npm run serve` | Servidor local com fallback SPA (porta 8080) — necessário para o reload em rotas como `/config` |
| `npm run test:e2e` | 13 testes de ponta a ponta em Chromium headless |

---

## 🏗️ Decisões de arquitetura

### 1. Artefato single-file

O build gera **um único `dist/index.html`** com CSS e JS embutidos.

O motivo é concreto: a v4 publicava `index.html` + `ts/*.js` + `css/*.css`
separados. Ao abrir por `file://`, os imports ESM são bloqueados por CORS e o
`<link rel=stylesheet>` apontava para um `style.css` **vazio** — resultado:
página em branco. Um arquivo único elimina essa classe inteira de bugs.

O `builder/compiler.js` é um mini-bundler próprio (zero dependências):

1. `tsc` compila para ESM em `.build/`;
2. o grafo de imports é resolvido e cada módulo é embrulhado em **seu próprio
   IIFE**, com um objeto de exports (`__m0`, `__m1`, …);
3. imports são reescritos para *namespace imports* (`const { x } = __m3;`);
4. CSS e bundle são embutidos no template.

Cada módulo ter escopo próprio é obrigatório: `MemoryDriver` é declarado em três
arquivos de teste diferentes. Concatenar os corpos num único escopo produzia
`Identifier 'MemoryDriver' has already been declared` e a aplicação não subia.

### 2. Camadas

```
src/ts/
├── main.ts                  # boot: storage → state → app → testes
├── App.ts                   # shell, rotas, eventos globais, backup, sync
├── core/                    # infraestrutura sem conhecimento de UI
│   ├── storage.ts           # IndexedDB + LocalStorage (write-through)
│   ├── appState.ts          # estado observável, congelado, persistência coalescida
│   ├── router.ts            # History API, rotas com parâmetros, query string
│   ├── schema.ts            # motor de formulários JSON + validação
│   ├── http.ts              # cliente fetch com timeout e erros tipados
│   ├── dom.ts               # Component, template `html` com escape automático
│   ├── errors.ts            # taxonomia (QuotaExceeded, Validation, NotFound…)
│   ├── routeParams.ts       # normalização tolerante de ids
│   ├── types.ts             # contratos de domínio
│   └── utils.ts             # funções puras (testáveis em Node)
├── data/                    # regras de coleção
│   ├── productRepository.ts # CRUD + filtros + fila de sincronização
│   └── backupService.ts     # export/import com validação de envelope
├── ui/                      # componentes reutilizáveis
│   ├── Header.ts  Sidebar.ts  ProductCard.ts
│   ├── DynamicForm.ts       # formulário gerado pelo esquema
│   ├── modal.ts  toast.ts   # diálogos e notificações acessíveis
├── views/                   # uma por rota
│   ├── StoreView.ts  ProductDetailView.ts
│   ├── AdminView.ts  ProductFormView.ts  SettingsView.ts
└── tests/                   # runner + 88 testes
```

Fluxo de dados unidirecional: **view → repositório → AppState → assinantes → view**.
Nenhuma view muta o estado diretamente.

### 3. Imutabilidade real

`AppState.getState()` devolve o estado **congelado em profundidade**.
Uma cópia rasa (`{ ...state }`) mantém as mesmas referências de arrays aninhados,
então `getState().products.push(x)` corromperia o estado interno — bug que existia
na v4. Agora a mutação lança e toda mudança passa por `setState`.

### 4. Segurança

Toda interpolação passa pela template tag `html`, que **escapa por padrão**:

```ts
const title = '<img src=x onerror=alert(1)>';
html`<h2>${title}</h2>`   // → '&lt;img src=x onerror=alert(1)&gt;'
```

A v4 interpolava títulos e descrições direto em `innerHTML`, permitindo XSS
armazenado via cadastro de produto. Há um teste E2E que verifica isso.

---

## 🎯 Funcionalidades

**Vitrine** — grade responsiva, busca com debounce (ignora acentos: "mixacao"
encontra "Mixação"), filtro por categoria, ordenação. Filtros ficam na query
string, então a busca é compartilhável por link.

**Detalhe do produto** — fluxo em três etapas: *Escolher → Pagar → Baixar*.
O download só é liberado após o comprador confirmar o pagamento.

> ⚠️ **Limitação honesta:** sem backend é impossível verificar um pagamento real.
> A v4 exibia o link de download **lado a lado** com o de pagamento, o que anula
> o propósito da vitrine. Aqui a confirmação é declarada pelo comprador e fica
> salva apenas no navegador dele. Para cobrar de verdade, aponte `paymentLink`
> para um checkout (Mercado Pago, Gumroad, Stripe, Hotmart) que entregue o
> arquivo após a confirmação — ou configure `window.__DSP_API_BASE__` para um
> endpoint de validação (o `HttpClient` já está pronto).

**Gerenciar** — estatísticas, tabela com busca/filtros, ações de
publicar/despublicar, duplicar, editar e excluir **com desfazer**.

**Formulário dinâmico** — os campos são gerados a partir de um esquema JSON
editável na própria SPA. Trocar o esquema regenera o formulário na hora.

**Configurações** — tema claro/escuro, lado e recolhimento do menu, densidade da
grade, cor de destaque, filtro de daltonismo, backup/restauração, reset,
diagnóstico do armazenamento e execução manual dos testes.

**Backup** — exportação JSON com envelope versionado (`app`, `version`,
`exportedAt`). Na importação, o arquivo é **validado antes** de tocar nos dados, e
você escolhe entre substituir ou mesclar. A importação também aceita o array nu
de produtos exportado pelas versões anteriores (v1–v4).

**Acessibilidade** — `role`/`aria-*`, focus trap em modais, `Esc` fecha, foco
retorna ao gatilho, `aria-live` para notificações, skip-link, foco visível,
`prefers-reduced-motion` respeitado, atalhos de teclado (`Alt+N/P/A/C`).

---

## 🧪 Testes

**88 testes unitários** rodam automaticamente no carregamento da página e o
resultado aparece no indicador do cabeçalho (clique para ver o detalhamento).

```
Storage     11   IndexedDB/LocalStorage, cota, fallback, write-through
AppState     9   observadores, coalescência, imutabilidade, migração
Schema      21   parse/serialize, validação, esquema JSON, normalize
Router      13   parâmetros, query string, histórico, ciclo de erro
Repository  14   CRUD, filtros, ordenação, fila de sincronização
Utils       11   busca sem acento, moeda, escape, helpers
```

**17 testes E2E** (Playwright/Chromium) em `py-tests/`, cobrindo o que só um
navegador real prova: boot sem erros, CRUD, persistência após reload, XSS
neutralizado, roundtrip de backup, fluxo de conversão, tema persistente e —
importante — que o artefato funciona aberto **direto do disco** (`file://`),
sem rede e sem servidor.

---

## 📐 Números

| | v4 | v5 |
|---|---|---|
| Artefato de deploy | 15 arquivos | **1** |
| Funciona via `file://` | ❌ | ✅ |
| Testes (passando de verdade) | 0 de 12* | **88** |
| Testes E2E | 1 | **17** |
| Tamanho final | 8,6 KB CSS + 0 B | **303 KB** (tudo incluído) |

\* Na v4, `it()` não aguardava promises: os testes `async` eram descartados e
**todos passavam sempre**. O runner da v5 é assíncrono e conta as falhas.

---

## 📚 Documentação

- [`docs/00-REVISAO-V4.md`](docs/00-REVISAO-V4.md) — auditoria da v4: 16 problemas encontrados
- [`docs/01-Arquitetura.md`](docs/01-Arquitetura.md) — camadas, fluxo de dados, build
- [`docs/02-Build.md`](docs/02-Build.md) — pipeline do mini-bundler
- [`docs/03-Esquema-JSON.md`](docs/03-Esquema-JSON.md) — formato do esquema de formulário
- [`docs/04-Backup.md`](docs/04-Backup.md) — formato do envelope e migração
- [`docs/05-Testes.md`](docs/05-Testes.md) — como rodar e escrever testes

---

## 🔌 Sincronização opcional

A aplicação funciona 100% offline. Cada mutação entra numa fila (`pendingOps`) e o
botão no cabeçalho mostra o que está pendente. Por padrão a sincronização é
**local** (consolida a fila). Para apontar a uma API real, defina antes do bundle:

```html
<script>window.__DSP_API_BASE__ = 'https://sua-api.com';</script>
```

O cliente então faz `POST /sync` com o snapshot e absorve `{ products: [...] }`
na resposta.
