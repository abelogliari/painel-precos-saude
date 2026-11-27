# Painel de Preços da Saúde

Versão rápida do [Painel de Preços da Saúde](https://infoms.saude.gov.br/extensions/SEIDIGI_DEMAS_BPS/SEIDIGI_DEMAS_BPS.html)
que reúne, para um mesmo item do CATMAT, os preços praticados em duas fontes:

| Fonte | Origem | Como chega ao painel |
| --- | --- | --- |
| **BPS** — Banco de Preços em Saúde | [API de Dados Abertos do Ministério da Saúde](https://apidadosabertos.saude.gov.br/v1/#/Economia%20da%20Sa%C3%BAde/get_economia_da_saude_bps) | consulta ao vivo, por item, via `api/bps.js` (com cache na CDN) |
| **Compras.gov.br** | extração em CSV (16 classes de material de saúde) | pré-processada em arquivos estáticos (`public/data/`) |

Sem framework e sem etapa de build: HTML, CSS e JavaScript puros servidos pela CDN da Vercel.

## Por que é rápido

- A página abre sem esperar nenhum dado; o catálogo de itens só é baixado quando a busca é usada.
- Os ~1,9 milhão de registros do Compras.gov.br foram repartidos em arquivos pequenos e compactados
  (`public/data/cg/<código % N>.json.gz`). Selecionar um item baixa **um** arquivo de poucos KB.
- O BPS é consultado em páginas paralelas e a tela é atualizada conforme elas chegam; cada página
  fica em cache na CDN, então consultas repetidas são instantâneas.
- Filtros, indicadores, tabela e gráficos são calculados no navegador, sem novas requisições.

## Estrutura

```
api/bps.js                 proxy da API do BPS (função Edge da Vercel, região gru1)
public/index.html          página única
public/assets/app.js       estado, carga de dados, filtros, indicadores e tabela
public/assets/charts.js    aba de gráficos (Chart.js, cópia local em assets/vendor/)
public/data/               dados do Compras.gov.br gerados pelo ETL
scripts/etl_comprasgov.py  gera public/data/ a partir dos CSV brutos
scripts/dev-server.mjs     servidor local (arquivos estáticos + /api/bps)
```

## Formato dos dados

As duas fontes são convertidas para a mesma linha compacta (um array JSON):

| # | Campo | BPS | Compras.gov.br |
| --- | --- | --- | --- |
| 0 | data (AAAA-MM-DD) | `dataCompra` | `dataCompra` |
| 1 | UF | `estado` | `estado` |
| 2 | município | `municipio` | `municipio` |
| 3 | instituição compradora | `nomeInstituicao` | `nomeUasg` |
| 4 | id da instituição | `cnpjInstituicao` | `codigoUasg` |
| 5 | fornecedor | `nomeFornecedor` | `nomeFornecedor` |
| 6 | id do fornecedor | `cnpjFornecedor` | `niFornecedor` |
| 7 | fabricante / marca | `nomeFabricante` | `marca` |
| 8 | unidade de fornecimento | `unidadeMedidaCapacidade` | `Unidade de Fornecimento` |
| 9 | quantidade | `quantidade` | `quantidade` |
| 10 | preço unitário (R$) | `precoUnitario` | `precoUnitario` |
| 11 | valor total (R$) | `precoTotal` | quantidade × preço unitário |
| 12 | modalidade | `modalidade` | código SIASG convertido em rótulo |
| 13 | esfera | `esfera` | `esfera` (F/E/M) |
| 14 | tipo de compra | `tipoCompra` | `forma` (SISRP/SISPP) |
| 15 | genérico (S/N) | `generico` | — |

Linhas sem preço ou quantidade positivos são descartadas nas duas fontes.

## Indicadores

Mesmas definições do painel original: preço mínimo, preço máximo, **média** (valor total ÷ quantidade
total), **mediana** dos preços unitários, total de compras registradas, valor total das compras e
total de itens (quantidade).

## Rodar localmente

```bash
npm run dev
```

Abre em `http://localhost:5173`. Requer Node 20 ou superior; não há dependências para instalar.

## Atualizar os dados do Compras.gov.br

```bash
python3 scripts/etl_comprasgov.py <pasta-com-os-csv> public/data
```

Os CSV usam `@` como separador, UTF-8 com BOM e números no formato brasileiro. O script só usa a
biblioteca padrão do Python. Depois é só fazer commit de `public/data/` — a Vercel publica a cada push.

## Publicação

O projeto na Vercel está ligado a este repositório: todo push em `main` gera uma nova versão.
Configuração em `vercel.json` (pasta de saída `public/`, cabeçalhos de cache).
