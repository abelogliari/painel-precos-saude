// Proxy para o Banco de Preços em Saúde (BPS) — API de Dados Abertos do Ministério da Saúde.
//
// Por que existe: a API oficial não envia cabeçalhos CORS (o navegador não consegue
// chamá-la direto), não informa o total de registros e devolve ~35 campos por linha.
// Aqui cada página é convertida no formato compacto usado pelo painel (ROW, ver README)
// e fica em cache na CDN da Vercel, então a segunda consulta ao mesmo item é instantânea.
//
// GET /api/bps?codigo=<CATMAT>&pagina=<n>[&inicio=AAAA-MM-DD&fim=AAAA-MM-DD]
//   200 -> {"n": <linhas>, "fim": <true se for a última página>, "rows": [ROW, ...]}
//   4xx/5xx -> {"erro": "mensagem"}

export const config = { runtime: 'edge', regions: ['gru1'] };

const UPSTREAM = 'https://apidadosabertos.saude.gov.br/economia-da-saude/bps';
const PAGE_SIZE = 500; // máximo aceito pela API
const MAX_PAGINA = 2000;
const TIMEOUT_MS = 11000; // 2 tentativas cabem no limite de 25 s da função
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;

const CACHE_OK = 'public, max-age=300, s-maxage=1800, stale-while-revalidate=3600';

function json(body, status = 200, cache = 'no-store') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache },
  });
}

const txt = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

const num = (v) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Unidade de fornecimento no mesmo formato do Compras.gov.br, para que as duas fontes
// possam ser comparadas. O BPS já traz a unidade composta em unidadeMedidaCapacidade
// ("FRASCO 1000,00 ML"; em unidadeFornecimento vem só "FRASCO"), mas sem o separador
// de milhar que o Compras.gov.br usa ("FRASCO 1.000,00 ML").
function unidade(r) {
  const u = txt(r.unidadeMedidaCapacidade) || txt(r.unidadeFornecimento);
  if (!u) return null;
  return u
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/\d{4,}(?=,\d)/g, (d) => d.replace(/\B(?=(\d{3})+$)/g, '.'));
}

function toRow(r) {
  const qtd = num(r.quantidade);
  const preco = num(r.precoUnitario);
  let total = num(r.precoTotal);
  if (!total && qtd && preco) total = Math.round(qtd * preco * 100) / 100;
  const esfera = txt(r.esfera);
  const generico = txt(r.generico);
  const data = txt(r.dataCompra);
  return [
    data ? data.slice(0, 10) : null, //  0 data
    txt(r.estado), //                      1 uf
    txt(r.municipio), //                   2 municipio
    txt(r.nomeInstituicao), //             3 instituicao
    txt(r.cnpjInstituicao), //             4 idInst
    txt(r.nomeFornecedor), //              5 fornecedor
    txt(r.cnpjFornecedor), //              6 idForn
    txt(r.nomeFabricante), //              7 fabricante
    unidade(r), //                         8 unidade
    qtd, //                                9 qtd
    preco, //                             10 preco
    total, //                             11 total
    txt(r.modalidade), //                 12 modalidade
    esfera ? esfera.toUpperCase() : null, // 13 esfera
    txt(r.tipoCompra), //                 14 tipo
    generico ? generico.toUpperCase().charAt(0) : null, // 15 generico
  ];
}

async function buscar(url) {
  let ultimoErro;
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(url, { headers: { accept: 'application/json' }, signal: ctrl.signal });
      if (resp.status >= 500) throw new Error(`BPS respondeu ${resp.status}`);
      const corpo = await resp.json();
      return { status: resp.status, corpo };
    } catch (e) {
      ultimoErro = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw ultimoErro;
}

export default async function handler(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ erro: 'Método não permitido.' }, 405);
  }
  const q = new URL(request.url).searchParams;
  const codigo = (q.get('codigo') || '').trim();
  const pagina = Number.parseInt(q.get('pagina') || '1', 10);
  const inicio = (q.get('inicio') || '').trim();
  const fim = (q.get('fim') || '').trim();

  if (!/^\d{1,9}$/.test(codigo)) return json({ erro: 'Informe um código CATMAT válido (somente números).' }, 400);
  if (!Number.isInteger(pagina) || pagina < 1 || pagina > MAX_PAGINA) return json({ erro: 'Página inválida.' }, 400);
  if ((inicio && !RE_DATA.test(inicio)) || (fim && !RE_DATA.test(fim))) {
    return json({ erro: 'Datas devem estar no formato AAAA-MM-DD.' }, 400);
  }

  const up = new URL(UPSTREAM);
  up.searchParams.set('codigoCatmat', String(Number(codigo)));
  up.searchParams.set('tamanhoPagina', String(PAGE_SIZE));
  up.searchParams.set('pagina', String(pagina));
  if (inicio) up.searchParams.set('dataCompraInicio', inicio);
  if (fim) up.searchParams.set('dataCompraFim', fim);

  let resultado;
  try {
    resultado = await buscar(up);
  } catch (e) {
    const lento = e && e.name === 'AbortError';
    return json(
      { erro: lento ? 'O BPS demorou demais para responder. Tente novamente.' : 'Não foi possível consultar o BPS agora. Tente novamente.' },
      lento ? 504 : 502,
    );
  }

  const { status, corpo } = resultado;
  if (status !== 200 || !corpo || !Array.isArray(corpo.bps)) {
    const msg = corpo && typeof corpo.message === 'string' ? corpo.message : 'Resposta inesperada do BPS.';
    return json({ erro: msg }, status >= 400 && status < 500 ? 400 : 502);
  }

  // Linhas sem preço ou quantidade positivos não entram nas estatísticas.
  const rows = [];
  for (const r of corpo.bps) {
    const row = toRow(r);
    if (row[0] && row[9] > 0 && row[10] > 0) rows.push(row);
  }
  return json({ n: rows.length, fim: corpo.bps.length < PAGE_SIZE, rows }, 200, CACHE_OK);
}
