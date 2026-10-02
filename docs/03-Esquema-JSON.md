# Esquema do formulário (JSON)

O formulário de cadastro/edição **não é fixo no código**: ele é gerado a partir de
um esquema JSON armazenado no estado (`formSchema`) e editável dentro da própria
SPA, em **Novo produto → ⚙️ Esquema do formulário**.

Essa é uma exigência do projeto: *"o próprio usuário deve ser capaz de alterar a
configuração JSON do formulário dentro da própria SPA"*.

---

## Formato

```json
{
  "version": 1,
  "fields": [
    {
      "id": "title",
      "label": "Título",
      "type": "text",
      "required": true,
      "path": "title",
      "placeholder": "Ex: Guia de Mixagem"
    },
    {
      "id": "priceCents",
      "label": "Preço (R$)",
      "type": "number",
      "required": true,
      "path": "priceCents",
      "scale": 100,
      "help": "Use 0 para item gratuito."
    }
  ]
}
```

### Campos

| Chave | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `id` | string | ✅ | Identificador único do campo no formulário. Usado como `name`, `id` do input e chave dos erros. |
| `label` | string | ✅ | Rótulo exibido. |
| `type` | enum | ✅ | `text` · `textarea` · `number` · `url` · `select` · `checkbox` · `tags` |
| `path` | string | ✅ | Onde o valor é lido/escrito em `Product`. Aceita caminho pontuado (`meta.autor`). |
| `required` | boolean | — | Bloqueia o envio se vazio. |
| `placeholder` | string | — | Texto de exemplo. |
| `help` | string | — | Texto auxiliar sob o campo, ligado por `aria-describedby`. |
| `options` | array | só `select` | `[{ "value": "pdf", "label": "PDF / E-book" }]` |
| `scale` | number | — | Divisor/multiplicador. `100` converte reais ↔ centavos. |

---

## Tipos de campo

| `type` | Input gerado | Conversão (`parseFieldValue`) |
|---|---|---|
| `text` | `<input type="text">` | string |
| `textarea` | `<textarea>` | string |
| `number` | `scale: 100` → `<input type="text" inputmode="decimal">`<br>senão → `<input type="number" step="any">` | `scale: 100` → centavos inteiros<br>senão → `number` |
| `url` | `<input type="url">` | string + validação de URL |
| `select` | `<select>` com `options` | string |
| `checkbox` | `<input type="checkbox">` | boolean |
| `tags` | `<input type="text">` | array de strings (split por vírgula) |

### 🔎 Por que `number` com `scale: 100` não usa `input[type=number]`

Um `<input type="number">` **rejeita a vírgula** — o separador decimal do pt-BR.
Digitar `19,90` faria o navegador descartar o valor e `value` ficaria `""`,
salvando `0` silenciosamente.

Por isso campos monetários usam `type="text"` + `inputmode="decimal"` (teclado
numérico no mobile), e a conversão fica com `parsePriceToCents`, que entende
`19,90`, `19.90` e `1.234,56`.

---

## Preço: centavos inteiros

`priceCents` guarda **inteiros**. A conversão acontece só na borda:

```
formulário "19,90"  ──parsePriceToCents──▶  1990  ──▶  Product.priceCents
formulário "19.90"  ─────────────────────▶  1990
formulário "1.234,56" ───────────────────▶  123456
```

Exibição: `formatCurrency(1990)` → `R$ 19,90` (via `Intl.NumberFormat`).

Isso evita erro de ponto flutuante (`19.90 * 100 === 1989.9999…`) que a v4 tinha
ao usar `parseFloat`.

---

## Validação

Acontece em `validateAgainstSchema`, e é executada **antes** de tocar no estado:

- `required` rejeita `undefined`, `null`, string vazia e array vazio;
- `url` rejeita esquemas perigosos via `isSafeUrl` — `javascript:alert(1)` é
  bloqueado, `https://`, `http://`, `mailto:` e `data:image/…;base64,` passam;
- `number` com `scale: 100` rejeita valores negativos.

Falhas lançam `ValidationError`, que carrega `fieldErrors` (`{ idDoCampo: mensagem }`):

```ts
try {
    const product = formValuesToProduct(schema, values, base);
    repository.create(product);
} catch (error) {
    if (error instanceof ValidationError) {
        form.setFieldErrors(error.fieldErrors);   // destaca os campos e foca o primeiro
    }
}
```

---

## Validando o esquema em si

Antes de aplicar um esquema editado, `validateSchemaShape` verifica:

- `fields` é um array com pelo menos um item;
- todo campo tem `id`, `label` e `path` como strings não vazias;
- `type` está na lista suportada (rejeita `"hologram"` com mensagem clara);
- `select` tem `options` não vazio.

Um esquema inválido **não é aplicado** — o erro aparece na tela e o anterior
continua valendo. Isso impede que um JSON malformado deixe o formulário inutilizável.

---

## Receitas

### Adicionar um campo "Autor"

```json
{
  "id": "autor",
  "label": "Autor",
  "type": "text",
  "path": "autor",
  "placeholder": "Nome do autor"
}
```

O valor entra em `Product.autor`. `normalizeProduct` preserva chaves extras, então
o dado persiste mesmo sem estar declarado em `types.ts`.

### Mover o preço para dentro de um objeto

```json
{ "id": "priceCents", "label": "Preço", "type": "number", "path": "venda.preco", "scale": 100 }
```

`setByPath` cria `venda: { preco: 1990 }` automaticamente, clonando os objetos
intermediários (sem mutar o produto original).

### Esconder um campo sem removê-lo

```json
{ "id": "paymentLabel", "label": "Botão", "type": "text", "path": "paymentLabel",
  "required": false, "help": "" }
```

Deixe `required: false`. Para remover da UI, apague a entrada do array — o valor
já salvo nos produtos permanece intacto.

### Relacionar categoria a um select

```json
{
  "id": "category",
  "label": "Categoria",
  "type": "select",
  "required": true,
  "path": "category",
  "options": [
    { "value": "pdf", "label": "PDF / E-book" },
    { "value": "musica", "label": "Música / Áudio" },
    { "value": "planilha", "label": "Planilha" }
  ]
}
```

> `value` precisa ser uma das categorias conhecidas (`pdf`, `musica`, `planilha`,
> `curso`, `template`, `outro`). Valores fora da lista são normalizados para
> `outro` por `normalizeProduct`, e os rótulos exibidos vêm de `CATEGORY_LABELS`.

---

## Restaurar o padrão

Em **Novo produto → ⚙️ Esquema do formulário → Restaurar padrão**. Pede
confirmação e substitui o esquema atual pelo de fábrica; **produtos cadastrados não
são alterados** — apenas a aparência do formulário muda.
