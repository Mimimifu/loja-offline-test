# Pipeline de build

## Visão geral

```
src/ts/**/*.ts  ──tsc──▶  .build/ts/**/*.js  ──bundler──▶  bundle
                                                              │
src/css/*.css  ───────────── collectCss ──────────────────────┤
                                                              ▼
                              builder/vendor/_index.html  ──▶  dist/index.html
```

`node builder/compiler.js` (ou `npm run build`) executa os 5 passos. Todo o
processo leva ~2,5 s.

---

## Por que mini-bundler próprio

A v4 publicava 15 arquivos e a aplicação não abria por `file://`: imports ESM são
bloqueados por CORS sob o protocolo `file://`, e o `link rel=stylesheet`
apontava para um `style.css` de 0 bytes. O artefato single-file elimina a classe
inteira de problemas.

Escrever o bundler (em vez de usar esbuild/rollup) mantém o projeto com **zero
dependências de runtime e de build** além do `typescript` — coerente com o
requisito do projeto. O código é curto o bastante para ser auditável (~380 linhas).

---

## Passo 1 — Limpeza

Remove `dist/` e `.build/`. Build limpo evita que artefatos antigos mascarem
falhas (ex: um arquivo que deixou de ser gerado mas continua no diretório).

## Passo 2 — Compilação

```bash
npx tsc --project tsconfig.json
```

`strict: true`, `noImplicitOverride: true`, `noFallthroughCasesInSwitch: true`.
Erros são reportados com a saída completa do `tsc` e o build **falha** — nunca
gera artefato a partir de código que não compila.

## Passo 3 — Empacotamento

### O problema do escopo único

Concatenar os corpos dos módulos num só escopo quebra: `MemoryDriver` é declarado
em três arquivos de teste diferentes, gerando
`Identifier 'MemoryDriver' has already been declared` — e a aplicação não subia.

### A solução: um escopo por módulo

```js
var __m0, __m1, __m2;              // declarados: strict mode proíbe implícitos

__m0 = {};                          // core/utils.js
(function () {
    function escapeHtml(v) { /* … */ }
    __m0.escapeHtml = escapeHtml;
})();

__m1 = {};                          // core/schema.js
(function () {
    const { escapeHtml } = __m0;    // ← import reescrito
    function validate(x) { /* … */ }
    __m1.validate = validate;
})();
```

### Reescrita de imports

| Original (após `tsc`) | Reescrito |
|---|---|
| `import { A, B as C } from './x';` | `const { A, B: C } = __mN;` |
| `import * as NS from './x';` | `const NS = __mN;` |
| `import './x';` | `void __mN;` |

Usar *namespace import* em vez de renomear cada binding é deliberado: renomear
exigiria reescrever todas as ocorrências no corpo, o que quebraria propriedades
de objeto homônimas — `{ title }` dentro de `schema.ts` viraria `{ title: title__x }`.

### Remoção de exports

| Original | Ação | Export registrado |
|---|---|---|
| `export function foo` | remove `export` | `foo:foo` |
| `export const x = …` | remove `export` | `x:x` |
| `export class Bar` | remove `export` | `Bar:Bar` |
| `export { A, B as C };` | remove a linha | `A:A`, `B:C` |
| `export default …` | **erro de build** | — |

`export {};` (emitido por arquivos só de tipos, como `core/types.ts`) é removido
corretamente, e módulos que viram `export {}` são incluídos no bundle apenas se
alguém os importar.

### Ordem e ciclos

Percorrimento em **pós-ordem** (dependências antes do consumidor). Um ciclo real
falha o build com o caminho completo:

```
❌ Dependência circular detectada:
   src/ts/a.js → src/ts/b.js → src/ts/a.js
   Quebre o ciclo movendo o tipo/função compartilhada para um módulo próprio.
```

> Por isso `defaultFormSchema()` está em `core/appState.ts` e não em
> `core/schema.ts`: manteria um ciclo `appState → schema → appState`.

### Verificação de import não resolvido

Qualquer `import` relativo que não resolva para um arquivo real falha o build —
impede o "funcionou na minha máquina" por arquivo ausente.

## Passo 4 — CSS

Todos os `.css` de `src/css/` são concatenados em ordem determinística
(`global.css` primeiro, garantindo que os tokens venham antes das regras), com
um cabeçalho identificando cada arquivo.

## Passo 5 — Emissão

O template `builder/vendor/_index.html` recebe `<style>` e `<script>`. Duas
salvaguardas:

- os marcadores `<!-- STYLES -->` / `<!-- SCRIPTS -->` precisam existir, senão o
  build falha (evita gerar HTML sem CSS silenciosamente);
- `</script>` dentro de strings é escapado para `<\/script>`, senão o parser HTML
  encerraria o bloco no meio do bundle.

---

## Verificação pós-build (`npm test`)

Um build que "passa" mas gera página em branco ainda é um build quebrado — foi
exatamente o ponto cego da v4. `builder/check-dist.js` valida 20 invariantes:

**Artefato** — tamanho plausível (> 80 KB).

**Autocontenção** (garante funcionamento por `file://`):
- nenhum `<script src>` externo;
- nenhuma folha de estilo externa;
- nenhum `import` ESM relativo pendente.

**Estilos** — CSS embutido > 5 KB, tokens `--accent-color` presentes, regras de
layout da sidebar presentes.

**Template** — marcadores substituídos, `#app-root` presente, sem `<script>`
duplicado.

**Robustez** — `lang="pt-BR"`, exatamente **um** `</script>` de fechamento
(mais de um significa bundle truncado).

**Boot de fumaça** — o bundle é executado num `vm` com DOM simulado. Prova que a
sintaxe é válida e que não há referência de topo quebrada (`__m4 is not defined`,
por exemplo) — um erro que só apareceria no navegador.

---

## Dev server (`npm run serve`)

`builder/serve.js` serve `dist/` **com fallback SPA**: rotas desconhecidas
devolvem `index.html`, para que recarregar `/config` funcione.

Isso importa porque o app usa History API: com `python -m http.server` (que
responde 404), um F5 em `/config` quebra a página. O dev server também bloqueia
path traversal e envia `Cache-Control: no-store`.

```bash
node builder/serve.js --port 3000
```

---

## Solução de problemas

| Sintoma | Causa provável |
|---|---|
| `Falha na compilação TypeScript` | erro de tipo; a saída do `tsc` indica arquivo e linha |
| `Import não resolvido: "./x"` | caminho de import errado ou arquivo ausente |
| `Dependência circular detectada` | ciclo real; extraia o código compartilhado |
| `Template inválido: marcadores ausentes` | `builder/vendor/_index.html` foi editado sem manter os comentários |
| Página em branco no navegador | rode `npm test`; o boot de fumaça e as checagens apontam a causa |
| Reload em `/produtos` dá 404 | está servindo com `python -m http.server`; use `npm run serve` |
