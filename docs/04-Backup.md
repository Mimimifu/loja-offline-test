# Backup e restauração

Todos os dados ficam no navegador (IndexedDB, com espelho em LocalStorage).
Limpar o cache apaga tudo — por isso o backup é parte do fluxo, não um extra.

---

## Envelope de backup

```json
{
  "app": "digital-store-pro",
  "version": 1,
  "exportedAt": "2026-10-01T19:12:33.000Z",
  "state": {
    "products": [ /* Product[] */ ],
    "settings": { /* Settings */ },
    "formSchema": { /* FormSchema */ }
  }
}
```

| Chave | Papel |
|---|---|
| `app` | Marcador de identidade. Um JSON de outro sistema é rejeitado com mensagem clara. |
| `version` | Versão do **formato do envelope**. Arquivo mais novo que o suportado é recusado. |
| `exportedAt` | ISO 8601, exibido na confirmação da importação. |
| `state.products` | Obrigatório. |
| `state.settings` | Opcional — preferências de UI. |
| `state.formSchema` | Opcional — esquema do formulário. |

---

## Exportar

**Gerenciar → ⬇️ Exportar**, ou **Configurações → Exportar backup (JSON)**.

O arquivo é nomeado `digital-store-backup-AAAA-MM-DD-HH-MM-SS.json` e inclui
imagens em base64, caso existam.

---

## Importar

**Gerenciar → ⬆️ Importar**, ou **Configurações → Importar backup (JSON)**.

### 1. Validação antes de escrever

`parseBackup()` valida o arquivo **antes** de tocar em qualquer dado:

| Verificação | Mensagem em caso de falha |
|---|---|
| É um objeto JSON | "Arquivo inválido: esperado um objeto JSON." |
| `app` confere | 'Este arquivo não é um backup do Digital Store Pro (esperado "app": "digital-store-pro").' |
| `version` suportada | "Versão de backup incompatível (arquivo: 2, suportado até: 1). Atualize a aplicação…" |
| `state.products` é array | "Backup malformado: "state.products" ausente ou inválido." |

JSON malformado (`SyntaxError`) é capturado separadamente: *"O arquivo não é um
JSON válido."*

### 2. Substituir ou mesclar

Se já existem produtos, você escolhe:

- **Substituir** — o backup vira o estado atual.
- **Mesclar** — os produtos do arquivo são adicionados aos seus. Em conflito de
  `id`, o **item importado recebe um id novo** (`imported-…`) para não sobrescrever
  dados locais.

### 3. Normalização defensiva

Cada produto importado passa por `normalizeProduct`, que corrige tipos:

| Entrada | Resultado |
|---|---|
| `title: 42` | `""` (número não é título) |
| `priceCents: "19,90"` | `0` (string é descartada — centavos são inteiros) |
| `category: "inexistente"` | `"outro"` |
| `tags: "não-é-array"` | `[]` |
| `published: "talvez"` | `true` (só `false` despublica) |
| `createdAt` ausente | preenchido com o horário atual |

Um produto corrompido não derruba a importação inteira.

---

## Compatibilidade com versões anteriores

`parseBackup()` aceita **array nu de produtos** — o formato exportado pelas
v1–v4:

```json
[
  { "id": 1, "title": "Meu PDF", "price": 19.9, "category": "PDF" },
  { "id": 2, "title": "Playlist", "category": "Música" }
]
```

Nesse caso `settings` e `formSchema` ficam `null` (mantém os atuais) e os ids
numéricos são convertidos para string. Como `ProductRepository.findByIdLoose`
compara ids de forma tolerante a tipo, links antigos com id numérico **continuam
funcionando** após a migração.

### Migrar da v4

1. Na v4: exporte com **Exportar JSON** (ou copie o array de produtos).
2. Na v5: **Configurações → Importar backup** e escolha **Substituir**.
3. Confira a vitrine. Nomes com acento, emoji e categorias são preservados
   (UTF-8 ponta a ponta).

---

## Reset

**Configurações → 🗑️ Apagar todos os dados** — com diálogo de confirmação
destrutivo. Remove produtos, esquema, preferências e o banco local, e recarrega o
estado inicial.

> Exporte um backup **antes**. A operação não é reversível.

---

## Onde os dados ficam

| Chave (LocalStorage) | Conteúdo |
|---|---|
| `dsp5:app_state` | estado completo (espelho) |
| `dsp5:purchases` | produtos marcados como pagos pelo comprador |
| `dsp5:colorblind` | filtro de daltonismo |

IndexedDB: banco `digital_store_pro`, store `app_data`.

O painel **Configurações → Diagnóstico** mostra o driver ativo, as operações
pendentes e uma estimativa do espaço usado.

### Cota

Com imagens base64 grandes, o navegador pode estourar o limite (geralmente ~5 MB
no LocalStorage). Quando isso acontece:

- a escrita em IndexedDB pode continuar funcionando (cota separada);
- se **nenhum** driver salvar, aparece um toast: *"O navegador ficou sem espaço
  para salvar. Exporte um backup e remova imagens grandes ou itens antigos."*;
- a mudança continua visível na tela (não é revertida), mas não é persistida.

**Recomendação:** prefira URLs de imagem a base64. Um JPEG de 200 KB vira ~267 KB
em base64 e ocupa cota em dois lugares (IndexedDB e LocalStorage).
