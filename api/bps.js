// Proxy para o Banco de Preços em Saúde (BPS) — API de Dados Abertos do Ministério da Saúde.
//
// Por que existe: a API oficial não envia cabeçalhos CORS (o navegador não consegue
// chamá-la direto), não informa o total de registros e devolve ~35 campos por linha.
// Aqui cada página é convertida no formato compacto usado pelo painel (ROW, ver README)
// e fica em cache na CDN da Vercel, então a segunda consulta ao mesmo item é instantânea.
//
// GET /api/bps?codigo=<CATMAT>&pagina=<n>[&inicio=AAAA-MM-DD][&fim=AAAA-MM-DD]
//   200 -> {"n": <linhas>, "fim": <true se for a última página>,
//           "descricao": <descrição do item no BPS ou null>, "rows": [ROW, ...]}
//   4xx/5xx -> {"erro": "mensagem"}
//
// A consulta só é aceita na forma canônica: os parâmetros nessa ordem, sem repetição, sem
// parâmetros extras, código e página sem zeros à esquerda. A query string faz parte da chave
// do cache da CDN: se "pagina=01", "&x=1" ou outra ordem fossem aceitos, cada grafia da mesma
// consulta furaria o cache e viraria uma chamada nova ao BPS.
//
// Garantias de cada ROW, valha o que valer a resposta do BPS: [0] é "AAAA-MM-DD"; os campos
// de texto são string ou null; quantidade, preço e total são números finitos (os dois
// primeiros, positivos). Linha fora disso é descartada.

export const config = { runtime: 'edge', regions: ['gru1'] };

const UPSTREAM = 'https://apidadosabertos.saude.gov.br/economia-da-saude/bps';
const PAGE_SIZE = 500; // máximo aceito pela API
const MAX_PAGINA = 200; // o painel pede no máximo 200 páginas (100 mil registros)
const TIMEOUT_MS = 11000; // 2 tentativas cabem no limite de 25 s da função
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const RE_DATA_COMPRA = /^(\d{4}-\d{2}-\d{2})(?:[T ]|$)/; // "2026-10-09" (tolera hora depois da data)

// Sem stale-while-revalidate: uma página vencida servida ao lado de outra recém-buscada
// repetiria ou perderia registros (a paginação do BPS é por deslocamento).
const CACHE_OK = 'public, max-age=300, s-maxage=1800';

function json(body, status = 200, cache = 'no-store') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache },
  });
}

// Campo de texto: só string (ou número, caso um identificador venha sem aspas) é aproveitado.
// Objeto, lista e booleano viram null — o painel nunca recebe outro tipo.
const txt = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' ? null : s;
};

const num = (v) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};

// "DOSE", "DOSES", "DOSE(S)" e "(DOSES)" são a mesma unidade escrita de quatro jeitos (o BPS usa
// "DOSES"; o Compras.gov.br, "DOSES", "DOSE(S)" e "(DOSES)"): sai sempre "DOSES". Só a palavra
// inteira é trocada; "DOSEADOR", "MONODOSE" ou "MCG/DOSE" ficam como estão. A expressão é a mesma
// do ETL (_DOSE em scripts/etl_comprasgov.py), para as duas fontes darem a mesma unidade.
const RE_DOSE = /(?<!\S)\(?DOSE(?:\(S\)|S)?\)?(?!\S)/g;

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
    .replace(/\d{4,}(?=,\d)/g, (d) => d.replace(/\B(?=(\d{3})+$)/g, '.'))
    .replace(RE_DOSE, 'DOSES');
}

// CPF embutido no nome do fornecedor (microempreendedor registrado como "NOME + CPF") é dado
// pessoal: vira "***.NNN.NNN-**", a mesma regra (e a mesma expressão, _CPF) que o ETL do
// Compras.gov.br aplica ao nome do fornecedor. Só quando os 11 dígitos passam nos dígitos
// verificadores; CNPJ (14 dígitos) e qualquer outro número ficam como estão. O nome do fabricante
// não é mascarado: os números de 11 dígitos que aparecem nele são registros da Anvisa.
const RE_CPF = /(?<!\d)(\d{3})\.?(\d{3})\.?(\d{3})-?(\d{2})(?!\d)/g;

function cpfValido(s) {
  if (/^(\d)\1{10}$/.test(s)) return false;
  const d = Array.from(s, Number);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < 9; i++) s1 += d[i] * (10 - i);
  for (let i = 0; i < 10; i++) s2 += d[i] * (11 - i);
  return ((s1 * 10) % 11) % 10 === d[9] && ((s2 * 10) % 11) % 10 === d[10];
}

const semCpf = (s) => s && s.replace(RE_CPF, (m, a, b, c, dv) => (cpfValido(a + b + c + dv) ? `***.${b}.${c}-**` : m));

function toRow(r) {
  const qtd = num(r.quantidade);
  const preco = num(r.precoUnitario);
  let total = num(r.precoTotal);
  if (!total && qtd && preco) total = Math.round(qtd * preco * 100) / 100;
  const esfera = txt(r.esfera);
  const generico = txt(r.generico);
  const data = RE_DATA_COMPRA.exec(txt(r.dataCompra) || '');
  return [
    data ? data[1] : null, //              0 data
    txt(r.estado), //                      1 uf
    txt(r.municipio), //                   2 municipio
    txt(r.nomeInstituicao), //             3 instituicao
    txt(r.cnpjInstituicao), //             4 idInst
    semCpf(txt(r.nomeFornecedor)), //      5 fornecedor
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
  const url = new URL(request.url);
  const q = url.searchParams;
  const codigo = q.get('codigo') || '';
  const pagina = Number.parseInt(q.get('pagina') || '', 10);
  const inicio = q.get('inicio'); // null quando ausente
  const fim = q.get('fim');

  if (!/^\d{1,9}$/.test(codigo)) return json({ erro: 'Informe um código CATMAT válido (somente números).' }, 400);
  if (!Number.isInteger(pagina) || pagina < 1 || pagina > MAX_PAGINA) return json({ erro: 'Página inválida.' }, 400);
  if ((inicio !== null && !RE_DATA.test(inicio)) || (fim !== null && !RE_DATA.test(fim))) {
    return json({ erro: 'Datas devem estar no formato AAAA-MM-DD.' }, 400);
  }
  // Uma única grafia por consulta (ver o cabeçalho): a query recebida tem de ser idêntica à canônica.
  const canonica =
    `?codigo=${Number(codigo)}&pagina=${pagina}` + (inicio ? `&inicio=${inicio}` : '') + (fim ? `&fim=${fim}` : '');
  if (url.search !== canonica) {
    return json(
      { erro: 'Consulta fora do formato esperado: ?codigo=<n>&pagina=<n>[&inicio=AAAA-MM-DD][&fim=AAAA-MM-DD], nessa ordem e sem outros parâmetros.' },
      400,
    );
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

  // Linhas sem data válida, sem preço ou quantidade positivos não entram nas estatísticas.
  // A descrição do item vem em todas as linhas; vale a primeira preenchida (serve aos itens
  // que só existem no BPS, fora do catálogo do Compras.gov.br).
  const rows = [];
  let descricao = null;
  for (const r of corpo.bps) {
    if (!r || typeof r !== 'object') continue;
    if (descricao === null && typeof r.descricaoItem === 'string') {
      descricao = r.descricaoItem.replace(/\s+/g, ' ').trim() || null;
    }
    const row = toRow(r);
    if (row[0] && row[9] > 0 && row[10] > 0 && Number.isFinite(row[11])) rows.push(row);
  }
  return json({ n: rows.length, fim: corpo.bps.length < PAGE_SIZE, descricao, rows }, 200, CACHE_OK);
}
