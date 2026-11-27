/* Painel de Preços da Saúde — frontend.
 *
 * Uma pesquisa, duas abas: os filtros (material, unidade, período e filtros adicionais) são preenchidos
 * uma vez e consultam as duas fontes ao mesmo tempo — BPS (ao vivo) e Compras.gov.br (dados estáticos).
 * Cada fonte tem a sua aba, com indicadores e tabela calculados só com os registros dela: nada é somado
 * entre as fontes. O arquivo cuida também da exportação CSV e do estado na URL.
 * Script clássico, sem framework e sem etapa de build.
 *
 * Formato das linhas (ROW), igual para as duas fontes:
 *  [0] data  [1] uf  [2] município  [3] instituição  [4] id da instituição  [5] fornecedor
 *  [6] id do fornecedor  [7] fabricante/marca  [8] unidade  [9] qtd  [10] preço  [11] total
 *  [12] modalidade  [13] esfera  [14] tipo  [15] genérico
 * Acrescentados aqui: [16] fonte (0 = BPS, 1 = Compras.gov.br) e [17] chave da unidade.
 */
(function () {
  'use strict';

  /* ============================== Constantes ============================== */

  const URL_BPS = '/api/bps';
  const URL_META = '/data/meta.json';
  const URL_CATALOGO = '/data/catalogo.json.gz';
  const URL_SHARD = (s) => '/data/cg/' + s + '.json.gz';

  const POR_PAGINA = 50;          // linhas da tabela por página
  const BPS_JANELA = 4;           // páginas do BPS pedidas em paralelo
  const BPS_MAX_PAGINAS = 200;    // limite de segurança (200 x 500 = 100 mil registros)
  const BPS_POR_PAGINA = 500;
  const MAX_SUGESTOES = 50;
  const MAX_OPCOES_FACETA = 200;
  const MAX_SHARDS_EM_CACHE = 6;
  const TODAS = '*';
  const SEM_UNIDADE = '(SEM UNIDADE)';
  const NOME_FONTE = ['BPS', 'Compras.gov.br'];   // índice = fonte da linha ([16]) = aba
  const ABAS = ['bps', 'cg'];                     // sufixo dos ids da aba/painel e valor de "aba" na URL
  const ARQUIVO_FONTE = ['bps', 'comprasgov'];    // trecho do nome do CSV exportado
  const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
  const GIRO = '<i class="giro" aria-hidden="true"></i>';
  const AVISO = '<svg class="aba__aviso" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6L1.3 21h21.4L12 2.6z" fill="currentColor"/>' +
    '<path d="M12 9.6v5.2" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17.9" r="1.3" fill="#fff"/></svg>';

  /* ============================== Utilidades ============================== */

  const $ = (id) => document.getElementById(id);
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
  const RE_ACENTO = /[̀-ͯ]/g;
  const RE_NAO_ASCII = /[^\x00-\x7f]/;
  const semAcento = (s) => (RE_NAO_ASCII.test(s) ? s.normalize('NFD').replace(RE_ACENTO, '') : s);
  const norm = (s) => semAcento(String(s)).toLowerCase();

  const fInt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
  const fQtd = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
  const fMoeda = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const fPreco = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 4 });
  const int = (n) => fInt.format(n);
  const registros = (n) => int(n) + (n === 1 ? ' registro' : ' registros');
  const dataBr = (d) => (d ? d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) : '');

  function iso(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  /** Padrão do painel: os últimos 12 meses, terminando hoje. */
  function periodoPadrao() {
    const hoje = new Date();
    return { inicio: iso(new Date(hoje.getFullYear() - 1, hoje.getMonth(), hoje.getDate())), fim: iso(hoje) };
  }
  function dataValida(s) {
    if (typeof s !== 'string' || !RE_DATA.test(s) || s < '1990-01-01' || s > '2100-12-31') return false;
    const d = new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
    return iso(d) === s;
  }
  function mascaraId(v) {
    const s = String(v);
    if (/^\d{14}$/.test(s)) return s.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
    return s;
  }

  /* --- Unidade de fornecimento: chave de comparação comum às duas fontes --- */
  const chavePorUnidade = new Map();   // texto original -> chave
  const rotuloPorChave = new Map();    // chave -> texto exibido
  const limparUnidade = (u) => String(u).toUpperCase().replace(/\s+/g, ' ').trim();
  const chaveDe = (limpo) => semAcento(limpo)
    .replace(/(\d),0+(?!\d)/g, '$1')                // "10,00 ML" -> "10 ML"
    .replace(/(\d,\d*?[1-9])0+(?!\d)/g, '$1');      // "2,50 ML"  -> "2,5 ML"
  function chaveUnidade(u) {
    if (u == null || u === '') u = SEM_UNIDADE;
    let k = chavePorUnidade.get(u);
    if (k === undefined) {
      const limpo = limparUnidade(u);
      k = chaveDe(limpo);
      chavePorUnidade.set(u, k);
      if (!rotuloPorChave.has(k)) rotuloPorChave.set(k, limpo);
    }
    return k;
  }
  const rotuloUnidade = (k) => rotuloPorChave.get(k) || k;

  /** Acrescenta [16] fonte e [17] chave da unidade (uma única vez por linha). */
  function marcar(rows, fonte) {
    for (let i = 0, n = rows.length; i < n; i++) {
      const r = rows[i];
      if (r.length > 16) continue;
      if (typeof r[9] !== 'number') r[9] = Number(r[9]) || 0;
      if (typeof r[10] !== 'number') r[10] = Number(r[10]) || 0;
      if (typeof r[11] !== 'number') r[11] = Number(r[11]) || 0;
      r[16] = fonte;
      r[17] = chaveUnidade(r[8]);
    }
    return rows;
  }

  /** Lê JSON que pode vir compactado (gzip cru) ou já em texto: decide pelos 2 primeiros bytes. */
  async function buscarJsonGz(url, signal) {
    const resp = await fetch(url, { signal: signal });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const buf = new Uint8Array(await resp.arrayBuffer());
    let texto;
    if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      if (typeof DecompressionStream !== 'function') throw new Error('navegador sem suporte a descompactação (DecompressionStream)');
      texto = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    } else {
      texto = new TextDecoder('utf-8').decode(buf);
    }
    return JSON.parse(texto);
  }

  /* ============================== Estado ============================== */

  const S = {
    item: null,                    // { codigo: number, descricao: string }
    aba: 0,                        // aba aberta, pelo índice da fonte: 0 = BPS | 1 = Compras.gov.br
    inicio: '', fim: '',           // AAAA-MM-DD
    unidade: null,                 // null = automática (a mais frequente) | TODAS | chave
    ordem: [{ k: 0, dir: -1 }, { k: 0, dir: -1 }],   // por aba: coluna (índice em COLS) e direção
    pagina: [0, 0],                // por aba
    bps: { estado: 'ocioso', rows: [], erro: '', truncado: false },
    cg: { estado: 'ocioso', rows: [], erro: '' },
  };

  /* Dados derivados (recalculados a cada mudança de filtro ou chegada de dados).
     O que é "por fonte" é sempre um par [BPS, Compras.gov.br]: as duas fontes nunca são somadas. */
  const V = {
    base: [[], []],            // por fonte: após o período
    obrig: null,               // por fonte: após período + unidade (sob demanda, para as facetas)
    linhas: [[], []],          // por fonte: após todos os filtros
    ordenadas: [null, null],   // por fonte: linhas na ordem da tabela (sob demanda)
    k: [null, null],           // por fonte: indicadores
    unidades: [],              // [{ k, rot, n: [BPS, Compras.gov.br], t: soma }]
    unidade: TODAS,            // unidade efetivamente aplicada
  };

  const dadosDaFonte = (f) => (f === 0 ? S.bps : S.cg);
  const carregando = (f) => dadosDaFonte(f).estado === 'carregando';

  let meta;            // undefined = carregando | null = indisponível | objeto
  let metaPromessa;
  const el = {};
  const P = [];        // por fonte: elementos da aba e do painel (ver prepararPaineis)
  const facetas = [];
  let facetaAberta = null;

  /* ============================== Catálogo (Compras.gov.br) ============================== */

  /* Função autocontida (sem dependências externas): roda num Worker, via toString(), para que
     descompactar/analisar ~100 mil itens não trave a página; sem Worker, roda na própria página. */
  async function catalogoBruto(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const buf = new Uint8Array(await resp.arrayBuffer());
    let texto;
    if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      texto = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    } else {
      texto = new TextDecoder('utf-8').decode(buf);
    }
    const arr = JSON.parse(texto);
    if (!Array.isArray(arr)) throw new Error('formato inesperado');
    const n = arr.length;
    const cod = new Int32Array(n);
    const reg = new Int32Array(n);
    const desc = new Array(n);
    const hay = new Array(n);
    const reAcento = /[̀-ͯ]/g;
    const reNaoAscii = /[^\x00-\x7f]/;
    const reQuebra = /[\r\n]+/g;
    for (let i = 0; i < n; i++) {
      const e = arr[i];
      cod[i] = e[0];
      reg[i] = e[2] || 0;
      let d = e[1] == null ? '' : String(e[1]);
      if (d.indexOf('\n') >= 0 || d.indexOf('\r') >= 0) d = d.replace(reQuebra, ' ');
      desc[i] = d;
      hay[i] = e[0] + ' ' + (reNaoAscii.test(d) ? d.normalize('NFD').replace(reAcento, '') : d).toLowerCase();
    }
    return { cod: cod, reg: reg, desc: desc.join('\n'), hay: hay.join('\n') };
  }

  function catalogoViaWorker(url) {
    return new Promise((resolve, reject) => {
      const semWorker = () => reject(Object.assign(new Error('worker indisponível'), { semWorker: true }));
      let w, blobUrl;
      try {
        const fonte = 'const f=' + catalogoBruto.toString() + ';' +
          'self.onmessage=async(e)=>{try{const r=await f(e.data);self.postMessage({ok:true,r:r},[r.cod.buffer,r.reg.buffer]);}' +
          'catch(x){self.postMessage({ok:false,erro:String((x&&x.message)||x)});}};';
        blobUrl = URL.createObjectURL(new Blob([fonte], { type: 'text/javascript' }));
        w = new Worker(blobUrl);
      } catch (_) { semWorker(); return; }
      const encerrar = () => { try { w.terminate(); } catch (_) { /* nada */ } URL.revokeObjectURL(blobUrl); };
      w.onmessage = (ev) => {
        encerrar();
        if (ev.data && ev.data.ok) resolve(ev.data.r); else reject(new Error((ev.data && ev.data.erro) || 'falha'));
      };
      w.onerror = (ev) => { if (ev && ev.preventDefault) ev.preventDefault(); encerrar(); semWorker(); };
      w.postMessage(url);
    });
  }

  const Cat = { estado: 'ocioso', n: 0, cod: null, reg: null, desc: [], hay: [], promessa: null, tentativas: 0 };

  function carregarCatalogo() {
    if (Cat.promessa) return Cat.promessa;
    if (Cat.estado === 'erro' && Cat.tentativas >= 2) return Promise.resolve();
    Cat.estado = 'carregando';
    Cat.tentativas++;
    const url = new URL(URL_CATALOGO, location.href).href;
    Cat.promessa = catalogoViaWorker(url)
      .catch((e) => { if (e && e.semWorker) return catalogoBruto(url); throw e; })
      .then((r) => {
        Cat.cod = r.cod; Cat.reg = r.reg; Cat.n = r.cod.length;
        Cat.desc = Cat.n ? r.desc.split('\n') : [];
        Cat.hay = Cat.n ? r.hay.split('\n') : [];
        Cat.estado = 'ok';
      }, () => { Cat.estado = 'erro'; Cat.promessa = null; })
      .then(aoCarregarCatalogo);
    return Cat.promessa;
  }

  const indiceNoCatalogo = (codigo) => (Cat.estado === 'ok' ? Cat.cod.indexOf(codigo) : -1);

  /** Busca por código e/ou palavras da descrição (sem acento e sem diferenciar maiúsculas). */
  function buscarCatalogo(q) {
    const n = Cat.n, hay = Cat.hay, out = [];
    let mais = false;
    const toks = norm(q).split(/\s+/).map((t) => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')).filter(Boolean);
    if (!toks.length) {
      for (let i = 0; i < n && i < MAX_SUGESTOES; i++) out.push(i);
      return { idx: out, mais: n > MAX_SUGESTOES };
    }
    toks.sort((a, b) => b.length - a.length);     // a palavra mais longa elimina mais rápido
    const t0 = toks[0], nt = toks.length;
    if (nt === 1 && /^\d+$/.test(t0)) {
      // Só dígitos: código exato, depois códigos que começam assim, depois qualquer ocorrência.
      const exato = Cat.cod.indexOf(Number(t0));
      const pref = [], cont = [];
      for (let i = 0; i < n; i++) {
        if (i === exato) continue;
        const p = hay[i].indexOf(t0);
        if (p < 0) continue;
        if (p === 0) { pref.push(i); if (pref.length >= MAX_SUGESTOES) { mais = true; break; } }
        else if (cont.length < MAX_SUGESTOES) cont.push(i);
        else mais = true;
      }
      if (exato >= 0) out.push(exato);
      for (let i = 0; i < pref.length; i++) { if (out.length >= MAX_SUGESTOES) { mais = true; break; } out.push(pref[i]); }
      for (let i = 0; i < cont.length; i++) { if (out.length >= MAX_SUGESTOES) { mais = true; break; } out.push(cont[i]); }
      return { idx: out, mais: mais };
    }
    for (let i = 0; i < n; i++) {
      const h = hay[i];
      if (h.indexOf(t0) < 0) continue;
      let ok = true;
      for (let j = 1; j < nt; j++) { if (h.indexOf(toks[j]) < 0) { ok = false; break; } }
      if (!ok) continue;
      if (out.length >= MAX_SUGESTOES) { mais = true; break; }   // o catálogo já vem ordenado por nº de registros
      out.push(i);
    }
    return { idx: out, mais: mais };
  }

  function aoCarregarCatalogo() {
    renderChips();
    if (S.item && !S.item.descricao) {
      const i = indiceNoCatalogo(S.item.codigo);
      if (i >= 0) {
        S.item.descricao = Cat.desc[i];
        mostrarItem();
        agendar();
      } else if (Cat.estado === 'ok') {
        mostrarItem();
      }
    }
    if (combo.aberto) comboAtualizar();
  }

  /* ============================== Metadados e rodapé ============================== */

  function carregarMeta() {
    metaPromessa = fetch(URL_META)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((m) => {
        meta = m && Number(m.shards) > 0 ? m : null;
        renderRodape();
        return meta;
      });
    return metaPromessa;
  }

  function renderRodape() {
    let cg, info = '';
    if (meta) {
      const periodo = meta.dataMin && meta.dataMax ? ', compras de ' + dataBr(meta.dataMin) + ' a ' + dataBr(meta.dataMax) : '';
      const n = Number(meta.linhas) >= 0 ? ' com ' + registros(Number(meta.linhas)) : '';
      cg = 'Compras.gov.br — extração' + n + periodo + '.';
      info = n + periodo;
      if (meta.geradoEm) {
        const g = new Date(meta.geradoEm);
        if (!isNaN(g)) info += ' (gerada em ' + g.toLocaleDateString('pt-BR') + ')';
      }
    } else {
      cg = 'Compras.gov.br — extração indisponível no momento.';
    }
    el.rodape.innerHTML = '<strong>Fontes:</strong> aba BPS — Banco de Preços em Saúde, API de Dados Abertos do Ministério da Saúde, consulta ao vivo. Aba ' +
      esc(cg) + ' Os filtros valem para as duas abas.';
    el.infoCg.textContent = info;
  }

  /* ============================== Carga: Compras.gov.br ============================== */

  const shards = new Map();     // nº do shard -> objeto { codigo: [ROW...] } (ou null se não existir)
  let abortCg = null;

  async function carregarCg() {
    if (abortCg) abortCg.abort();
    const ctrl = abortCg = new AbortController();
    const codigo = S.item.codigo;
    S.cg = { estado: 'carregando', rows: [], erro: '' };
    agendar();
    try {
      const m = await metaPromessa;
      if (ctrl.signal.aborted) return;
      if (!m) { S.cg = { estado: 'indisponivel', rows: [], erro: '' }; agendar(); return; }
      // Se o catálogo já está na memória e não tem o código, não há o que buscar.
      if (Cat.estado === 'ok' && indiceNoCatalogo(codigo) < 0) { S.cg = { estado: 'ok', rows: [], erro: '' }; agendar(); return; }
      const s = codigo % Number(m.shards);
      let dados = shards.get(s);
      if (dados === undefined) {
        dados = await buscarJsonGz(URL_SHARD(s), ctrl.signal);
        if (ctrl.signal.aborted) return;
        shards.set(s, dados);
        if (shards.size > MAX_SHARDS_EM_CACHE) shards.delete(shards.keys().next().value);
      }
      const rows = (dados && dados[codigo]) || [];
      S.cg = { estado: 'ok', rows: marcar(rows, 1), erro: '' };
    } catch (e) {
      if (ctrl.signal.aborted) return;
      S.cg = { estado: 'erro', rows: [], erro: 'Não foi possível carregar os dados do Compras.gov.br.' };
    }
    agendar();
  }

  /* ============================== Carga: BPS ============================== */

  const cacheBps = new Map();   // codigo -> [{ inicio, fim, rows, proxima, completo, truncado }]
  let abortBps = null;

  function entradaBps(codigo, inicio, fim) {
    let lista = cacheBps.get(codigo);
    if (!lista) { lista = []; cacheBps.set(codigo, lista); }
    let exata = null;
    for (let i = 0; i < lista.length; i++) {
      const e = lista[i];
      if (e.inicio === inicio && e.fim === fim) exata = e;
      // Uma consulta completa de um período maior já contém este período.
      else if (e.completo && !e.truncado && e.inicio <= inicio && e.fim >= fim) return e;
    }
    if (exata) return exata;
    const nova = { inicio: inicio, fim: fim, rows: [], proxima: 1, completo: false, truncado: false };
    lista.push(nova);
    if (lista.length > 8) lista.shift();
    return nova;
  }

  function mensagemErro(e) {
    if (e && e.amigavel) return e.message;
    return 'Não foi possível conectar ao serviço de consulta do BPS. Verifique sua conexão.';
  }

  async function paginaBps(codigo, inicio, fim, pagina, signal) {
    const url = URL_BPS + '?codigo=' + codigo + '&pagina=' + pagina + '&inicio=' + inicio + '&fim=' + fim;
    let ultimo;
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      try {
        const resp = await fetch(url, { signal: signal, headers: { accept: 'application/json' } });
        let corpo = null;
        try { corpo = await resp.json(); } catch (_) { /* corpo não é JSON */ }
        if (resp.ok && corpo && Array.isArray(corpo.rows)) return corpo;
        const erro = new Error((corpo && typeof corpo.erro === 'string' && corpo.erro) || 'O serviço de consulta do BPS respondeu com erro (HTTP ' + resp.status + ').');
        erro.amigavel = true;
        // Só vale repetir falhas passageiras; 4xx e tempo esgotado (504) não melhoram na hora.
        if (resp.status !== 502 && resp.status !== 503) throw Object.assign(erro, { definitivo: true });
        ultimo = erro;
      } catch (e) {
        if (signal.aborted || (e && e.definitivo)) throw e;
        ultimo = e;
      }
      if (tentativa === 0) await new Promise((ok) => setTimeout(ok, 500));
      if (signal.aborted) throw ultimo;
    }
    throw ultimo;
  }

  /** Pede `qtd` páginas em paralelo e resolve assim que a sequência estiver completa até a página final. */
  function janelaBps(codigo, inicio, fim, primeira, qtd, signal) {
    return new Promise((resolve, reject) => {
      const ctrl = new AbortController();
      const aoAbortar = () => ctrl.abort();
      signal.addEventListener('abort', aoAbortar, { once: true });
      const res = new Array(qtd);
      let feito = false;
      const concluir = (fn, valor) => {
        if (feito) return;
        feito = true;
        signal.removeEventListener('abort', aoAbortar);
        ctrl.abort();                       // páginas além da última não interessam mais
        fn(valor);
      };
      const conferir = () => {
        const rows = [];
        for (let i = 0; i < qtd; i++) {
          const r = res[i];
          if (!r) return;                   // ainda falta uma página anterior
          if (r.erro) { concluir(reject, r.erro); return; }
          for (let j = 0; j < r.rows.length; j++) rows.push(r.rows[j]);
          if (r.fim) { concluir(resolve, { rows: rows, fim: true, paginas: i + 1 }); return; }
        }
        concluir(resolve, { rows: rows, fim: false, paginas: qtd });
      };
      for (let i = 0; i < qtd; i++) {
        paginaBps(codigo, inicio, fim, primeira + i, ctrl.signal).then(
          (r) => { res[i] = r; conferir(); },
          (e) => { if (signal.aborted) { concluir(reject, e); return; } res[i] = { erro: e }; conferir(); }
        );
      }
    });
  }

  async function carregarBps() {
    if (abortBps) abortBps.abort();
    const ctrl = abortBps = new AbortController();
    const codigo = S.item.codigo, inicio = S.inicio, fim = S.fim;
    const ent = entradaBps(codigo, inicio, fim);
    if (ent.completo) {
      S.bps = { estado: 'ok', rows: ent.rows, erro: '', truncado: ent.truncado };
      agendar();
      return;
    }
    S.bps = { estado: 'carregando', rows: ent.rows, erro: '', truncado: false };
    agendar();
    try {
      for (;;) {
        if (ent.proxima > BPS_MAX_PAGINAS) { ent.truncado = true; break; }
        const qtd = Math.min(BPS_JANELA, BPS_MAX_PAGINAS - ent.proxima + 1);
        const r = await janelaBps(codigo, ent.inicio, ent.fim, ent.proxima, qtd, ctrl.signal);
        if (ctrl.signal.aborted) return;
        marcar(r.rows, 0);
        for (let i = 0; i < r.rows.length; i++) ent.rows.push(r.rows[i]);
        ent.proxima += r.paginas;
        if (r.fim) break;
        agendar();                           // mostra o que já chegou
      }
      ent.completo = true;
      S.bps = { estado: 'ok', rows: ent.rows, erro: '', truncado: ent.truncado };
    } catch (e) {
      if (ctrl.signal.aborted) return;
      S.bps = { estado: 'erro', rows: ent.rows, erro: mensagemErro(e), truncado: false };
    }
    agendar();
  }

  /* ============================== Cálculo (filtros + indicadores) ============================== */

  function mediana(a) {
    const n = a.length;
    if (!n) return NaN;
    const m = n >> 1;
    return n & 1 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  /** Aplica os filtros — os mesmos para as duas fontes — e calcula as linhas e os indicadores de cada fonte. */
  function recalcular() {
    const ini = S.inicio, fim = S.fim;

    // 1ª passada: período; conta os registros de cada unidade em cada fonte.
    const base = [[], []];
    const cont = new Map();          // chave da unidade -> [nº no BPS, nº no Compras.gov.br]
    if (S.item) {
      for (let f = 0; f < 2; f++) {
        const arr = dadosDaFonte(f).rows, b = base[f];
        for (let i = 0, n = arr.length; i < n; i++) {
          const r = arr[i], d = r[0];
          if (d === null || d < ini || d > fim) continue;
          b.push(r);
          let c = cont.get(r[17]);
          if (c === undefined) cont.set(r[17], c = [0, 0]);
          c[f]++;
        }
      }
    }
    const unidades = [];
    cont.forEach((n, k) => unidades.push({ k: k, n: n, t: n[0] + n[1], rot: rotuloUnidade(k) }));
    unidades.sort((a, b) => b.t - a.t || (a.k < b.k ? -1 : 1));
    const uni = S.unidade !== null ? S.unidade : (unidades.length ? unidades[0].k : TODAS);

    // 2ª passada: unidade + filtros adicionais; linhas e indicadores de cada fonte, em separado.
    const todas = uni === TODAS;
    const ativos = [];
    for (let i = 0; i < facetas.length; i++) if (facetas[i].sel.size) ativos.push(facetas[i]);
    const nf = ativos.length;
    for (let f = 0; f < 2; f++) {
      const b = base[f], nb = b.length, linhas = [];
      const precos = new Float64Array(nb);
      let n = 0, min = Infinity, max = -Infinity, total = 0, qtd = 0;
      for (let i = 0; i < nb; i++) {
        const r = b[i];
        if (!todas && r[17] !== uni) continue;
        if (nf) {
          let ok = true;
          for (let j = 0; j < nf; j++) {
            let v = r[ativos[j].def.c];
            if (v === '' || v === undefined) v = null;
            if (!ativos[j].sel.has(v)) { ok = false; break; }
          }
          if (!ok) continue;
        }
        linhas.push(r);
        const p = r[10];
        precos[n++] = p;
        if (p < min) min = p;
        if (p > max) max = p;
        total += r[11];
        qtd += r[9];
      }
      V.linhas[f] = linhas;
      V.ordenadas[f] = null;
      V.k[f] = { n: n, min: min, max: max, total: total, qtd: qtd, mediana: mediana(precos.subarray(0, n).sort()) };
    }
    V.base = base;
    V.obrig = null;
    V.unidades = unidades;
    V.unidade = uni;
  }

  /** Linhas de cada fonte após os filtros obrigatórios (período e unidade): base das opções das facetas. */
  function linhasObrigatorias() {
    if (!V.obrig) {
      const u = V.unidade;
      V.obrig = u === TODAS ? V.base : V.base.map((b) => b.filter((r) => r[17] === u));
    }
    return V.obrig;
  }

  /* ============================== Ordenação ============================== */

  const colator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

  /** Ordena por uma coluna usando chaves numéricas (texto vira posição entre os valores distintos). */
  function ordenar(rows, col, tipo, dir) {
    const n = rows.length;
    const chaves = new Float64Array(n);
    if (tipo === 'num') {
      for (let i = 0; i < n; i++) { const v = rows[i][col]; chaves[i] = typeof v === 'number' ? v : NaN; }
    } else {
      const pos = new Map(), vals = [];
      for (let i = 0; i < n; i++) {
        const v = rows[i][col];
        if (v == null || v === '') continue;
        if (!pos.has(v)) { pos.set(v, 0); vals.push(v); }
      }
      if (tipo === 'data') vals.sort(); else vals.sort(colator.compare);
      for (let i = 0; i < vals.length; i++) pos.set(vals[i], i);
      for (let i = 0; i < n; i++) { const v = rows[i][col]; chaves[i] = v == null || v === '' ? NaN : pos.get(v); }
    }
    const idx = new Uint32Array(n);
    const vazios = [];
    let m = 0;
    for (let i = 0; i < n; i++) { if (chaves[i] !== chaves[i]) vazios.push(i); else idx[m++] = i; }
    const com = idx.subarray(0, m);
    if (dir > 0) com.sort((a, b) => (chaves[a] - chaves[b]) || (a - b));
    else com.sort((a, b) => (chaves[b] - chaves[a]) || (a - b));
    const out = new Array(n);
    for (let i = 0; i < m; i++) out[i] = rows[com[i]];
    for (let i = 0; i < vazios.length; i++) out[m + i] = rows[vazios[i]];   // sem valor: sempre no fim
    return out;
  }

  function linhasOrdenadas(f) {
    if (!V.ordenadas[f]) {
      const o = S.ordem[f], c = COLS[o.k];
      V.ordenadas[f] = ordenar(V.linhas[f], c.c, c.tipo, o.dir);
    }
    return V.ordenadas[f];
  }

  /* ============================== Indicadores ============================== */

  const media = (g) => (g.qtd > 0 ? g.total / g.qtd : NaN);
  const preco = (v) => (isFinite(v) ? fPreco.format(v) : '—');
  const KPIS = [
    { id: 'min', v: (g) => preco(g.min) },
    { id: 'max', v: (g) => preco(g.max) },
    { id: 'media', v: (g) => preco(media(g)) },
    { id: 'mediana', v: (g) => preco(g.mediana) },
    { id: 'compras', v: (g) => int(g.n) },
    { id: 'valor', v: (g) => fMoeda.format(g.total) },
    { id: 'itens', v: (g) => fQtd.format(g.qtd) },
  ];

  /** Cada painel mostra os indicadores da sua fonte; os dois ficam em dia, então trocar de aba não recalcula nada. */
  function renderKpis() {
    for (let f = 0; f < 2; f++) {
      const p = P[f], k = V.k[f], espera = carregando(f);
      p.kpis.classList.toggle('is-carregando', espera && k.n === 0);
      p.painel.setAttribute('aria-busy', espera ? 'true' : 'false');
      for (let i = 0; i < KPIS.length; i++) p.kpi[i].textContent = k.n ? KPIS[i].v(k) : '—';
    }
  }

  /* ============================== Unidade de fornecimento ============================== */

  const porFonte = (n) => NOME_FONTE[0] + ' ' + int(n[0]) + ' · ' + NOME_FONTE[1] + ' ' + int(n[1]);

  /** Lista única com as unidades das duas fontes; cada opção informa os registros de cada fonte no período. */
  let assinaturaUnidades = '';
  function renderUnidades() {
    const sel = el.unidade, us = V.unidades, efetiva = V.unidade;
    const todas = [V.base[0].length, V.base[1].length];
    let assinatura = efetiva + '\n' + (S.item ? todas.join('\t') : '');
    for (let i = 0; i < us.length; i++) assinatura += '\n' + us[i].k + '\t' + us[i].n.join('\t');
    sel.disabled = !S.item;
    if (assinatura === assinaturaUnidades) return;
    assinaturaUnidades = assinatura;
    let h = '<option value="' + TODAS + '">Todas as unidades' + (S.item ? ' — ' + porFonte(todas) : '') + '</option>';
    let achou = efetiva === TODAS;
    for (let i = 0; i < us.length; i++) {
      h += '<option value="' + esc(us[i].k) + '">' + esc(us[i].rot) + ' — ' + porFonte(us[i].n) + '</option>';
      if (us[i].k === efetiva) achou = true;
    }
    if (!achou) h += '<option value="' + esc(efetiva) + '">' + esc(rotuloUnidade(efetiva)) + ' — ' + porFonte([0, 0]) + '</option>';
    sel.innerHTML = h;
    sel.value = efetiva;
    sel.title = S.item ? sel.options[sel.selectedIndex].text : '';     // o campo pode cortar o texto da opção escolhida
  }

  /* ============================== Tabela (uma por aba) ============================== */

  const COLS = [
    { t: 'Data', c: 0, tipo: 'data', cls: 'td--nw' },
    { t: 'UF', c: 1, tipo: 'txt', cls: 'td--nw' },
    { t: 'Município', c: 2, tipo: 'txt', cls: 'td--curto' },
    { t: 'Instituição', c: 3, tipo: 'txt', cls: 'td--txt', id: 4 },
    { t: 'Fornecedor', c: 5, tipo: 'txt', cls: 'td--txt', id: 6 },
    { t: 'Fabricante/Marca', c: 7, tipo: 'txt', cls: 'td--txt' },
    { t: 'Unidade', c: 8, tipo: 'txt', cls: 'td--curto' },
    { t: 'Qtd.', c: 9, tipo: 'num', cls: 'td--num', fmt: fQtd },
    { t: 'Preço unitário', c: 10, tipo: 'num', cls: 'td--num', fmt: fPreco },
    { t: 'Total', c: 11, tipo: 'num', cls: 'td--num', fmt: fMoeda },
    { t: 'Modalidade', c: 12, tipo: 'txt', cls: 'td--curto' },
    { t: 'Esfera', c: 13, tipo: 'txt', cls: 'td--nw' },
    { t: 'Tipo', c: 14, tipo: 'txt', cls: 'td--curto' },
  ];
  const SELO = [
    '<span class="selo selo--bps"><i class="dot dot--bps" aria-hidden="true"></i>BPS</span>',
    '<span class="selo selo--cg"><i class="dot dot--cg" aria-hidden="true"></i>Compras.gov.br</span>',
  ];
  const VAZIO = '<span class="nulo" aria-label="não informado">—</span>';

  function prepararTabela(p) {
    let h = '';
    for (let k = 0; k < COLS.length; k++) {
      h += '<th scope="col"' + (COLS[k].tipo === 'num' ? ' class="th--num"' : '') + ' data-k="' + k + '">' +
        '<button type="button" class="th-btn" title="Ordenar por ' + esc(COLS[k].t) + '">' + esc(COLS[k].t) + '<span class="seta" aria-hidden="true"></span></button></th>';
    }
    p.cab.innerHTML = h;
    p.cab.addEventListener('click', (ev) => {
      const th = ev.target.closest('th');
      if (!th) return;
      const k = Number(th.dataset.k), o = S.ordem[p.f];
      if (o.k === k) o.dir = -o.dir;
      else S.ordem[p.f] = { k: k, dir: COLS[k].tipo === 'txt' ? 1 : -1 };
      S.pagina[p.f] = 0;
      V.ordenadas[p.f] = null;
      renderTabela(p.f);
    });
    p.paginacao.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-pg]');
      if (!b) return;
      const pg = S.pagina[p.f];
      irParaPagina(p.f, { primeira: 0, anterior: pg - 1, proxima: pg + 1, ultima: Infinity }[b.dataset.pg]);
    });
  }

  function irParaPagina(f, pg) {
    const ultima = Math.max(0, Math.ceil(V.linhas[f].length / POR_PAGINA) - 1);
    S.pagina[f] = Math.max(0, Math.min(ultima, pg));
    renderTabela(f);
    // A paginação fica no fim da tabela: volta ao começo dela para mostrar as linhas da nova página.
    const topo = P[f].rolagem;
    if (topo.getBoundingClientRect().top < 0) topo.scrollIntoView({ block: 'start' });
  }

  function rotuloId(r, colId) {
    const v = mascaraId(r[colId]);
    if (colId === 4) return (r[16] === 0 ? 'CNPJ ' : 'UASG ') + v;
    return 'CNPJ/CPF ' + v;
  }

  function linhaHtml(r) {
    let h = '<tr>';
    for (let k = 0; k < COLS.length; k++) {
      const c = COLS[k], v = r[c.c];
      if (v == null || v === '') h += '<td class="' + c.cls + '">' + VAZIO + '</td>';
      else if (c.tipo === 'num') h += '<td class="td--num">' + c.fmt.format(v) + '</td>';
      else if (c.tipo === 'data') h += '<td class="td--nw">' + dataBr(v) + '</td>';
      else if (c.id !== undefined && r[c.id]) h += '<td class="' + c.cls + '" title="' + esc(rotuloId(r, c.id)) + '">' + esc(v) + '</td>';
      else h += '<td class="' + c.cls + '">' + esc(v) + '</td>';
    }
    return h + '</tr>';
  }

  /** Aba sem linhas: explica o motivo e, se a outra aba tiver registros, oferece um atalho (a troca nunca é automática). */
  function estadoVazio(f) {
    const d = dadosDaFonte(f), nome = NOME_FONTE[f];
    if (d.estado === 'carregando') {
      return '<p>' + GIRO + (f === 0 ? 'Consultando o BPS…' : 'Carregando os registros do Compras.gov.br…') + '</p>';
    }
    let msg;
    if (d.estado === 'erro') {
      msg = f === 0 ? 'A consulta ao BPS não foi concluída: não há registros para mostrar nesta aba.' : 'Os dados do Compras.gov.br não foram carregados: não há registros para mostrar nesta aba.';
    } else if (d.estado === 'indisponivel') {
      msg = 'A extração do Compras.gov.br não está disponível no momento.';
    } else if (V.base[f].length) {
      msg = 'Nenhum registro do ' + nome + ' atende aos filtros selecionados. Experimente outra unidade de fornecimento ou remova filtros adicionais.';
    } else if (f === 0) {
      msg = 'O BPS não tem registros deste material no período selecionado. Experimente ampliar o período.';
    } else if (!d.rows.length) {
      msg = 'Este material não tem registros na extração do Compras.gov.br.';
    } else {
      let min = d.rows[0][0], max = min;
      for (let i = 1; i < d.rows.length; i++) { const dt = d.rows[i][0]; if (dt < min) min = dt; if (dt > max) max = dt; }
      msg = 'O Compras.gov.br não tem registros deste material no período selecionado. A extração tem ' + registros(d.rows.length) +
        ' dele, de ' + dataBr(min) + ' a ' + dataBr(max) + ': ajuste o período para vê-los.';
    }
    const outra = 1 - f, n = V.linhas[outra].length;
    return '<p>' + esc(msg) + '</p>' +
      (n ? '<button type="button" class="btn btn--secundario" data-ver="' + outra + '">Ver ' + registros(n) + ' em ' + NOME_FONTE[outra] + '</button>' : '');
  }

  function renderTabela(f) {
    const p = P[f];
    if (f !== S.aba) { p.suja = true; return; }      // a tabela da aba fechada é refeita quando ela for aberta
    p.suja = false;
    const rows = linhasOrdenadas(f), n = rows.length;
    const paginas = Math.max(1, Math.ceil(n / POR_PAGINA));
    const pg = S.pagina[f] = Math.max(0, Math.min(paginas - 1, S.pagina[f]));
    const a = pg * POR_PAGINA, b = Math.min(n, a + POR_PAGINA);
    let h = '';
    for (let i = a; i < b; i++) h += linhaHtml(rows[i]);
    p.corpo.innerHTML = h;

    const o = S.ordem[f], ths = p.cab.children;
    for (let k = 0; k < ths.length; k++) {
      if (k === o.k) ths[k].setAttribute('aria-sort', o.dir > 0 ? 'ascending' : 'descending');
      else ths[k].removeAttribute('aria-sort');
    }
    const vazio = n ? '' : estadoVazio(f);
    if (vazio !== p.vazioHtml) { p.vazioHtml = vazio; p.vazia.innerHTML = vazio; }
    p.vazia.hidden = n > 0;
    p.rolagem.hidden = p.paginacao.hidden = n === 0;
    p.pgInfo.textContent = n ? int(a + 1) + '–' + int(b) + ' de ' + int(n) : '0 de 0';
    p.pg.primeira.disabled = p.pg.anterior.disabled = pg === 0;
    p.pg.proxima.disabled = p.pg.ultima.disabled = pg >= paginas - 1;
    p.resumo.innerHTML = SELO[f] + (n ? '<span>' + registros(n) + (n === 1 ? ' encontrado' : ' encontrados') + (carregando(f) ? ' até agora' : '') + '</span>' : '');
  }

  /* ============================== Exportação CSV ============================== */

  function csvTexto(v) {
    if (v == null) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;          // evita que planilhas interpretem o texto como fórmula
    return /[";\r\n]/.test(s) || s !== s.trim() ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csvNumero(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '';
    let s = String(v);
    if (s.indexOf('e') >= 0) s = v.toFixed(10).replace(/\.?0+$/, '');
    return s.replace('.', ',');
  }

  /** Exporta os registros filtrados da aba aberta, na ordem da tabela. */
  function exportarCsv() {
    const f = S.aba;
    if (!S.item || !V.linhas[f].length) return;
    const rows = linhasOrdenadas(f);
    const cab = ['Código CATMAT', 'Descrição do material', 'Data da compra', 'UF', 'Município', 'Instituição compradora',
      'Identificador da instituição (CNPJ ou UASG)', 'Fornecedor', 'CNPJ/CPF do fornecedor', 'Fabricante/Marca',
      'Unidade de fornecimento', 'Quantidade', 'Preço unitário (R$)', 'Valor total (R$)', 'Modalidade', 'Esfera',
      'Tipo de compra', 'Genérico', 'Fonte'];
    const prefixo = S.item.codigo + ';' + csvTexto(S.item.descricao || '') + ';';
    const partes = ['﻿' + cab.join(';') + '\r\n'];
    let bloco = '';
    for (let i = 0, n = rows.length; i < n; i++) {
      const r = rows[i];
      bloco += prefixo + (r[0] || '') + ';' + csvTexto(r[1]) + ';' + csvTexto(r[2]) + ';' + csvTexto(r[3]) + ';' + csvTexto(r[4]) + ';' +
        csvTexto(r[5]) + ';' + csvTexto(r[6]) + ';' + csvTexto(r[7]) + ';' + csvTexto(r[8]) + ';' +
        csvNumero(r[9]) + ';' + csvNumero(r[10]) + ';' + csvNumero(r[11]) + ';' +
        csvTexto(r[12]) + ';' + csvTexto(r[13]) + ';' + csvTexto(r[14]) + ';' +
        (r[15] === 'S' ? 'Sim' : r[15] === 'N' ? 'Não' : '') + ';' + NOME_FONTE[r[16]] + '\r\n';
      if ((i & 4095) === 4095) { partes.push(bloco); bloco = ''; }
    }
    partes.push(bloco);
    const blob = new Blob(partes, { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = 'precos-' + ARQUIVO_FONTE[f] + '-' + S.item.codigo + '.csv';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* ============================== Facetas ("Mais filtros") ============================== */

  const ROT_ESFERA = { FEDERAL: 'Federal', ESTADUAL: 'Estadual', MUNICIPAL: 'Municipal' };
  const FACETAS = [
    { k: 'uf', t: 'UF', c: 1 },
    { k: 'municipio', t: 'Município', c: 2 },
    { k: 'esfera', t: 'Esfera', c: 13, rot: ROT_ESFERA },
    { k: 'modalidade', t: 'Modalidade', c: 12 },
    { k: 'tipo', t: 'Tipo de compra', c: 14 },
    { k: 'fornecedor', t: 'Fornecedor', c: 5 },
    { k: 'fabricante', t: 'Fabricante/Marca', c: 7 },
    { k: 'instituicao', t: 'Instituição compradora', c: 3 },
    { k: 'generico', t: 'Genérico', c: 15, rot: { S: 'Sim', N: 'Não' } },
  ];

  /** Componente genérico: botão com contagem + popover com busca e lista de caixas de seleção. */
  function criarFaceta(def) {
    const sel = new Set();
    const raiz = document.createElement('div');
    raiz.className = 'faceta';
    raiz.innerHTML =
      '<button type="button" class="faceta__btn" id="faceta-btn-' + def.k + '" aria-haspopup="dialog" aria-expanded="false" aria-controls="faceta-pop-' + def.k + '" disabled>' +
        '<span class="faceta__nome">' + esc(def.t) + '</span><span class="contador" hidden></span><span class="faceta__seta" aria-hidden="true"></span></button>' +
      '<div class="faceta__pop" id="faceta-pop-' + def.k + '" role="dialog" aria-label="Filtrar por ' + esc(def.t) + '" tabindex="-1" hidden>' +
        '<input type="search" class="ctrl faceta__busca" placeholder="Buscar em ' + esc(def.t) + '…" aria-label="Buscar valores de ' + esc(def.t) + '" autocomplete="off" spellcheck="false">' +
        '<div class="faceta__barra"><span class="faceta__info"></span><button type="button" class="link faceta__limpar">Limpar seleção</button></div>' +
        '<ul class="faceta__lista" aria-label="Valores de ' + esc(def.t) + '"></ul>' +
        '<p class="faceta__nota" hidden></p></div>';
    const btn = raiz.querySelector('.faceta__btn');
    const contador = raiz.querySelector('.contador');
    const pop = raiz.querySelector('.faceta__pop');
    const busca = raiz.querySelector('.faceta__busca');
    const info = raiz.querySelector('.faceta__info');
    const btnLimpar = raiz.querySelector('.faceta__limpar');
    const lista = raiz.querySelector('.faceta__lista');
    const nota = raiz.querySelector('.faceta__nota');
    let ops = [];        // todas as opções: [{ v, n, rot, nrm }]
    let visiveis = [];   // opções mostradas (filtradas pela busca, no máximo MAX_OPCOES_FACETA)

    const rotulo = (v) => (v === null ? 'Não informado' : (def.rot && def.rot[v]) || String(v));

    function calcularOpcoes() {
      // Valores e contagens das DUAS fontes: o mesmo filtro vale para as duas abas.
      const grupos = linhasObrigatorias(), c = def.c, m = new Map();
      for (let f = 0; f < 2; f++) {
        const rows = grupos[f];
        for (let i = 0, n = rows.length; i < n; i++) {
          let v = rows[i][c];
          if (v === '' || v === undefined) v = null;
          const a = m.get(v);
          m.set(v, a === undefined ? 1 : a + 1);
        }
      }
      sel.forEach((v) => { if (!m.has(v)) m.set(v, 0); });
      ops = [];
      m.forEach((n, v) => { const r = rotulo(v); ops.push({ v: v, n: n, rot: r, nrm: norm(r) }); });
      ops.sort((a, b) => b.n - a.n || (a.rot < b.rot ? -1 : a.rot > b.rot ? 1 : 0));
    }

    function renderLista() {
      const q = norm(busca.value).trim();
      visiveis = [];
      let total = 0;
      for (let i = 0; i < ops.length; i++) {
        if (q && ops[i].nrm.indexOf(q) < 0) continue;
        total++;
        if (visiveis.length < MAX_OPCOES_FACETA) visiveis.push(ops[i]);
      }
      let h = '';
      for (let i = 0; i < visiveis.length; i++) {
        const o = visiveis[i];
        h += '<li><label><input type="checkbox" data-i="' + i + '"' + (sel.has(o.v) ? ' checked' : '') + '>' +
          '<span class="faceta__v">' + esc(o.rot) + '</span><span class="faceta__c">' + int(o.n) + '</span></label></li>';
      }
      if (!visiveis.length) {
        h = '<li class="faceta__vazio">' + (ops.length ? 'Nenhum valor encontrado para a busca.' : (carregando(0) || carregando(1) ? 'Carregando valores…' : 'Nenhum valor disponível.')) + '</li>';
      }
      lista.innerHTML = h;
      info.textContent = (q ? int(total) + ' de ' : '') + int(ops.length) + (ops.length === 1 ? ' valor' : ' valores') + (sel.size ? ' · ' + int(sel.size) + (sel.size === 1 ? ' selecionado' : ' selecionados') : '');
      nota.hidden = total <= visiveis.length;
      if (!nota.hidden) nota.textContent = 'Mostrando os ' + MAX_OPCOES_FACETA + ' valores com mais registros. Use a busca para encontrar os demais.';
      btnLimpar.hidden = sel.size === 0;
    }

    function atualizarBotao() {
      const n = sel.size;
      contador.hidden = n === 0;
      contador.innerHTML = n ? int(n) + '<span class="sr"> ' + (n === 1 ? 'valor selecionado' : 'valores selecionados') + '</span>' : '';
      btn.classList.toggle('tem-sel', n > 0);
    }

    function posicionar() {
      pop.style.left = '0px';
      const r = raiz.getBoundingClientRect();
      const largura = pop.offsetWidth, vw = document.documentElement.clientWidth;
      let left = 0;
      if (r.left + largura > vw - 8) left = Math.max(8 - r.left, vw - 8 - largura - r.left);
      pop.style.left = left + 'px';
    }

    const self = {
      def: def, sel: sel, raiz: raiz, rotulo: rotulo,
      abrir: function () {
        if (facetaAberta && facetaAberta !== self) facetaAberta.fechar(false);
        facetaAberta = self;
        busca.value = '';
        calcularOpcoes();
        pop.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
        renderLista();
        posicionar();
        // Em telas de toque, focar a busca abriria o teclado sobre a lista.
        if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) pop.focus(); else busca.focus();
      },
      fechar: function (devolverFoco) {
        if (pop.hidden) return;
        pop.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        if (facetaAberta === self) facetaAberta = null;
        if (devolverFoco) btn.focus();
      },
      /** Os dados mudaram com o popover aberto: refaz a lista preservando foco e rolagem. */
      atualizarLista: function () {
        const ativo = document.activeElement;
        const focado = ativo && ativo.type === 'checkbox' && lista.contains(ativo) ? visiveis[Number(ativo.dataset.i)] : null;
        const rolagem = lista.scrollTop;
        calcularOpcoes();
        renderLista();
        lista.scrollTop = rolagem;
        if (focado) {
          const i = visiveis.findIndex((o) => o.v === focado.v);
          const alvo = i >= 0 ? lista.querySelector('input[data-i="' + i + '"]') : null;
          (alvo || busca).focus();
        }
      },
      limpar: function () {
        if (!sel.size) return false;
        sel.clear();
        atualizarBotao();
        if (!pop.hidden) renderLista();
        return true;
      },
      remover: function (v) {
        if (!sel.delete(v)) return;
        atualizarBotao();
        if (!pop.hidden) renderLista();
      },
      habilitar: function (sim) { btn.disabled = !sim; if (!sim) self.fechar(false); },
    };

    btn.addEventListener('click', () => { if (pop.hidden) self.abrir(); else self.fechar(true); });
    busca.addEventListener('input', renderLista);
    busca.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown') {
        const primeiro = lista.querySelector('input');
        if (primeiro) { ev.preventDefault(); primeiro.focus(); }
      }
    });
    lista.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
      const caixas = Array.prototype.slice.call(lista.querySelectorAll('input'));
      const i = caixas.indexOf(document.activeElement);
      if (i < 0) return;
      ev.preventDefault();
      const alvo = ev.key === 'ArrowDown' ? caixas[i + 1] : (i === 0 ? busca : caixas[i - 1]);
      if (alvo) alvo.focus();
    });
    lista.addEventListener('change', (ev) => {
      const cx = ev.target;
      if (!cx || cx.type !== 'checkbox') return;
      const o = visiveis[Number(cx.dataset.i)];
      if (!o) return;
      if (cx.checked) sel.add(o.v); else sel.delete(o.v);
      atualizarBotao();
      btnLimpar.hidden = sel.size === 0;
      zerarPaginas();
      agendar();
    });
    btnLimpar.addEventListener('click', () => {
      if (self.limpar()) { zerarPaginas(); agendar(); }
      busca.focus();
    });
    raiz.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !pop.hidden) { ev.stopPropagation(); ev.preventDefault(); self.fechar(true); }
    });
    raiz.addEventListener('focusout', (ev) => {
      if (!pop.hidden && ev.relatedTarget && !raiz.contains(ev.relatedTarget)) self.fechar(false);
    });
    return self;
  }

  function prepararFacetas() {
    for (const def of FACETAS) {
      const f = criarFaceta(def);
      facetas.push(f);
      el.facetas.appendChild(f.raiz);
    }
    document.addEventListener('pointerdown', (ev) => {
      if (facetaAberta && !facetaAberta.raiz.contains(ev.target)) facetaAberta.fechar(false);
    });
    window.addEventListener('resize', () => { if (facetaAberta) facetaAberta.fechar(false); });
    el.maisToggle.addEventListener('click', () => alternarMaisFiltros());
  }

  function alternarMaisFiltros(abrir) {
    const aberto = abrir === undefined ? el.maisToggle.getAttribute('aria-expanded') !== 'true' : abrir;
    el.maisToggle.setAttribute('aria-expanded', aberto ? 'true' : 'false');
    el.maisCorpo.hidden = !aberto;
    if (!aberto && facetaAberta) facetaAberta.fechar(false);
  }

  function limparFacetas() {
    let mudou = false;
    for (const f of facetas) if (f.limpar()) mudou = true;
    return mudou;
  }

  /* Etiquetas dos filtros adicionais ativos */
  let tagsRef = [], tagsHtml = '';
  function renderTags() {
    const MAX = 12;
    let h = '', total = 0;
    const ref = [];
    for (const f of facetas) {
      f.sel.forEach((v) => {
        total++;
        if (ref.length >= MAX) return;
        const txt = f.def.t + ': ' + f.rotulo(v);
        h += '<li class="tag"><span class="tag__txt" title="' + esc(txt) + '">' + esc(txt) + '</span>' +
          '<button type="button" class="tag__x" data-i="' + ref.length + '" aria-label="Remover filtro ' + esc(txt) + '">×</button></li>';
        ref.push({ f: f, v: v });
      });
    }
    if (total > ref.length) h += '<li class="tag tag--mais">+' + int(total - ref.length) + ' filtros</li>';
    tagsRef = ref;
    if (h !== tagsHtml) { tagsHtml = h; el.tags.innerHTML = h; }
    el.maisContagem.hidden = total === 0;
    el.maisContagem.innerHTML = total ? int(total) + '<span class="sr"> ' + (total === 1 ? 'filtro adicional ativo' : 'filtros adicionais ativos') + '</span>' : '';
  }

  /* ============================== Combobox de material ============================== */

  const combo = { aberto: false, ops: [], ativo: -1, editado: false, timer: 0 };

  const rotuloItem = (item) => (item.descricao ? item.codigo + ' — ' + item.descricao : String(item.codigo));

  function comboAtualizar() {
    const q = combo.editado ? el.itemInput.value : '';
    const qt = q.trim();
    const soDigitos = /^\d{1,9}$/.test(qt);
    const ops = [];
    let msg = '';
    if (Cat.estado === 'ok') {
      const r = buscarCatalogo(q);
      for (let i = 0; i < r.idx.length; i++) ops.push({ i: r.idx[i] });
      if (soDigitos && indiceNoCatalogo(Number(qt)) < 0) ops.push({ livre: Number(qt) });
      if (!ops.length) msg = 'Nenhum material encontrado. Confira a grafia ou digite o código CATMAT (apenas números) para consultar o BPS.';
      else if (r.mais) msg = 'Mostrando os ' + MAX_SUGESTOES + ' materiais com mais registros. Continue digitando para refinar a busca.';
    } else {
      if (soDigitos) ops.push({ livre: Number(qt) });
      msg = Cat.estado === 'erro'
        ? 'Catálogo do Compras.gov.br indisponível. Digite o código CATMAT (apenas números) para consultar o BPS.'
        : 'Carregando o catálogo de materiais…';
    }
    let h = '';
    for (let k = 0; k < ops.length; k++) {
      const o = ops[k];
      if (o.livre !== undefined) {
        h += '<li role="option" class="combo__op combo__op--livre" id="item-op-' + k + '" data-k="' + k + '" aria-selected="false">Consultar o código ' + o.livre + ' no BPS</li>';
      } else {
        const n = Cat.reg[o.i];
        h += '<li role="option" class="combo__op" id="item-op-' + k + '" data-k="' + k + '" aria-selected="false">' +
          '<span class="combo__txt"><span class="combo__cod">' + Cat.cod[o.i] + '</span> — ' + esc(Cat.desc[o.i]) + '</span>' +
          '<span class="combo__n">' + registros(n) + ' no Compras.gov.br</span></li>';
      }
    }
    if (msg) h += '<li role="presentation" class="combo__msg">' + esc(msg) + '</li>';
    combo.ops = ops;
    el.itemLista.innerHTML = h;
    el.itemLista.scrollTop = 0;
    comboAtivar(ops.length ? 0 : -1, false);
  }

  function comboAtivar(k, rolar) {
    const ant = combo.ativo >= 0 ? $('item-op-' + combo.ativo) : null;
    if (ant) ant.setAttribute('aria-selected', 'false');
    combo.ativo = k;
    const op = k >= 0 ? $('item-op-' + k) : null;
    if (op) {
      op.setAttribute('aria-selected', 'true');
      el.itemInput.setAttribute('aria-activedescendant', op.id);
      if (rolar) {
        // Rola só a lista (scrollIntoView poderia mover a página inteira).
        const l = el.itemLista, topo = op.offsetTop, base = topo + op.offsetHeight;
        if (topo < l.scrollTop) l.scrollTop = topo;
        else if (base > l.scrollTop + l.clientHeight) l.scrollTop = base - l.clientHeight;
      }
    } else {
      el.itemInput.removeAttribute('aria-activedescendant');
    }
  }

  function comboAbrir() {
    comboAtualizar();
    if (combo.aberto) return;
    combo.aberto = true;
    el.itemLista.hidden = false;
    el.itemInput.setAttribute('aria-expanded', 'true');
  }

  function comboFechar() {
    clearTimeout(combo.timer);
    if (!combo.aberto) return;
    combo.aberto = false;
    el.itemLista.hidden = true;
    el.itemInput.setAttribute('aria-expanded', 'false');
    el.itemInput.removeAttribute('aria-activedescendant');
    combo.ativo = -1;
  }

  function comboEscolher(k, porTeclado) {
    const o = combo.ops[k];
    if (!o) return;
    comboFechar();
    combo.editado = false;
    if (o.livre !== undefined) selecionarItem({ codigo: o.livre, descricao: '' });
    else selecionarItem({ codigo: Cat.cod[o.i], descricao: Cat.desc[o.i] });
    if (!porTeclado) el.itemInput.blur();
  }

  function prepararCombo() {
    const inp = el.itemInput;
    inp.addEventListener('focus', () => {
      carregarCatalogo();
      combo.editado = false;
      if (S.item) inp.select();
      comboAbrir();
    });
    inp.addEventListener('click', () => { if (!combo.aberto) comboAbrir(); });
    inp.addEventListener('input', () => {
      combo.editado = true;
      clearTimeout(combo.timer);
      combo.timer = setTimeout(comboAbrir, 80);
    });
    inp.addEventListener('keydown', (ev) => {
      const n = combo.ops.length;
      switch (ev.key) {
        case 'ArrowDown':
          ev.preventDefault();
          if (!combo.aberto) comboAbrir(); else if (n) comboAtivar((combo.ativo + 1) % n, true);
          break;
        case 'ArrowUp':
          ev.preventDefault();
          if (!combo.aberto) comboAbrir(); else if (n) comboAtivar((combo.ativo - 1 + n) % n, true);
          break;
        case 'PageDown':
          if (combo.aberto && n) { ev.preventDefault(); comboAtivar(Math.min(n - 1, combo.ativo + 10), true); }
          break;
        case 'PageUp':
          if (combo.aberto && n) { ev.preventDefault(); comboAtivar(Math.max(0, combo.ativo - 10), true); }
          break;
        case 'Enter':
          if (combo.aberto) {
            ev.preventDefault();
            clearTimeout(combo.timer);
            if (combo.editado) comboAtualizar();          // garante o resultado do texto atual
            if (combo.ativo >= 0) comboEscolher(combo.ativo, true);
          }
          break;
        case 'Escape':
          if (combo.aberto) { ev.preventDefault(); comboFechar(); }
          else if (combo.editado) { combo.editado = false; inp.value = S.item ? rotuloItem(S.item) : ''; }
          break;
        default:
      }
    });
    inp.addEventListener('blur', () => {
      comboFechar();
      if (S.item) inp.value = rotuloItem(S.item);
      combo.editado = false;
    });
    // mousedown com preventDefault mantém o foco no campo; a escolha acontece no clique.
    el.itemLista.addEventListener('mousedown', (ev) => ev.preventDefault());
    el.itemLista.addEventListener('click', (ev) => {
      const li = ev.target.closest('[data-k]');
      if (li) comboEscolher(Number(li.dataset.k), false);
    });
    el.itemLimpar.addEventListener('click', () => { limparItem(); inp.focus(); });
  }

  /* ============================== Seleção do item ============================== */

  function mostrarItem() {
    const item = S.item;
    el.itemLimpar.hidden = !item;
    el.vazio.hidden = !!item;
    el.resultados.hidden = !item;
    for (const f of facetas) f.habilitar(!!item);
    if (!item) { el.titulo.textContent = ''; return; }
    if (document.activeElement !== el.itemInput || !combo.editado) el.itemInput.value = rotuloItem(item);
    if (item.descricao) {
      el.titulo.textContent = item.codigo + ' — ' + item.descricao;
    } else {
      const fora = Cat.estado === 'ok';
      el.titulo.innerHTML = 'Código ' + item.codigo + (fora ? ' <small>(item fora do catálogo do Compras.gov.br — consulta direta ao BPS)</small>' : '');
    }
    document.title = (item.descricao ? item.codigo + ' — ' + item.descricao : 'Código ' + item.codigo) + ' | Painel de Preços da Saúde';
  }

  function zerarPaginas() { S.pagina[0] = S.pagina[1] = 0; }

  function selecionarItem(item, manterFiltros) {
    S.item = { codigo: Number(item.codigo), descricao: item.descricao || '' };
    if (!S.item.descricao) {
      const i = indiceNoCatalogo(S.item.codigo);
      if (i >= 0) S.item.descricao = Cat.desc[i];
    }
    if (!manterFiltros) { S.unidade = null; limparFacetas(); }
    zerarPaginas();
    mostrarItem();
    carregarCg();
    carregarBps();
    agendar();
  }

  function limparItem() {
    if (abortBps) abortBps.abort();
    if (abortCg) abortCg.abort();
    S.item = null;
    S.unidade = null;
    zerarPaginas();
    S.bps = { estado: 'ocioso', rows: [], erro: '', truncado: false };
    S.cg = { estado: 'ocioso', rows: [], erro: '' };
    limparFacetas();
    el.itemInput.value = '';
    document.title = 'Painel de Preços da Saúde';
    mostrarItem();
    agendar();
  }

  function renderChips() {
    if (Cat.estado === 'ok' && Cat.n) {
      let h = '';
      for (let i = 0; i < Cat.n && i < 8; i++) {
        h += '<li><button type="button" class="chip" data-i="' + i + '" title="' + esc(Cat.desc[i]) + ' — ' + registros(Cat.reg[i]) + ' no Compras.gov.br">' +
          '<span class="chip__cod">' + Cat.cod[i] + '</span><span class="chip__desc">' + esc(Cat.desc[i]) + '</span></button></li>';
      }
      el.chips.innerHTML = h;
      el.vazioFreq.hidden = false;
      el.vazioNota.hidden = true;
    } else if (Cat.estado === 'erro') {
      el.vazioFreq.hidden = true;
      el.vazioNota.hidden = false;
      el.vazioNota.textContent = 'O catálogo do Compras.gov.br não está disponível no momento. Ainda é possível consultar o BPS: digite o código CATMAT (apenas números) no campo Material.';
    }
  }

  /* ============================== Situação das consultas ============================== */

  /** Uma linha para as duas fontes: registros de cada uma no período (antes da unidade e dos filtros adicionais). */
  let statusHtml = '';
  function renderSituacao() {
    if (!S.item) { el.situacao.hidden = true; statusHtml = ''; el.status.innerHTML = ''; return; }
    el.situacao.hidden = false;
    const b = S.bps, c = S.cg, nb = V.base[0].length, nc = V.base[1].length;
    let tb, tc;
    if (b.estado === 'carregando') tb = (b.rows.length ? registros(b.rows.length) + ' carregados…' : 'consultando…') + GIRO;
    else if (b.estado === 'erro') tb = b.rows.length ? 'consulta interrompida (' + registros(b.rows.length) + ' carregados)' : 'consulta não concluída';
    else tb = nb ? registros(nb) + ' no período' : 'nenhum registro no período';
    if (c.estado === 'carregando') tc = 'carregando…' + GIRO;
    else if (c.estado === 'erro') tc = 'dados não carregados';
    else if (c.estado === 'indisponivel') tc = 'extração indisponível no momento';
    else if (!c.rows.length) tc = 'material sem registros na extração';
    else tc = (nc ? registros(nc) + ' no período' : 'nenhum registro no período') + ' (' + int(c.rows.length) + ' na extração)';
    const h = '<span class="st"><i class="dot dot--bps" aria-hidden="true"></i><b>BPS:</b> ' + tb + '</span>' +
      '<span class="st__sep" aria-hidden="true">·</span>' +
      '<span class="st"><i class="dot dot--cg" aria-hidden="true"></i><b>Compras.gov.br:</b> ' + tc + '</span>';
    if (h !== statusHtml) { statusHtml = h; el.status.innerHTML = h; }
    el.progresso.hidden = !(carregando(0) || carregando(1));
  }

  /** Erros e avisos ficam no painel da fonte a que se referem (a aba dela ganha um sinal de alerta). */
  function renderAlertas() {
    const b = S.bps, c = S.cg;
    const repetir = '<button type="button" class="btn btn--secundario btn--mini" data-repetir>Tentar novamente</button>';
    const html = ['', ''];
    if (b.estado === 'erro') {
      html[0] += '<div class="alerta alerta--erro" role="alert"><span class="alerta__txt"><b>BPS:</b> ' + esc(b.erro) +
        (c.rows.length ? ' Os registros do Compras.gov.br continuam disponíveis na outra aba.' : '') + '</span>' + repetir + '</div>';
    }
    if (b.truncado) {
      html[0] += '<div class="alerta alerta--aviso" role="status"><span class="alerta__txt"><b>BPS:</b> a consulta foi interrompida em ' +
        int(BPS_MAX_PAGINAS * BPS_POR_PAGINA) + ' registros (limite do painel). Os indicadores desta aba estão incompletos: reduza o período para ver todos os registros.</span></div>';
    }
    if (c.estado === 'erro') {
      html[1] += '<div class="alerta alerta--erro" role="alert"><span class="alerta__txt"><b>Compras.gov.br:</b> ' + esc(c.erro) +
        (b.rows.length ? ' Os registros do BPS continuam disponíveis na outra aba.' : '') + '</span>' + repetir + '</div>';
    }
    for (let f = 0; f < 2; f++) {
      const p = P[f];
      if (html[f] !== p.alertasHtml) { p.alertasHtml = html[f]; p.alertas.innerHTML = html[f]; }
    }
  }

  function renderResumoImpressao() {
    if (!S.item) { el.resumoImp.textContent = ''; return; }
    const f = S.aba, outra = 1 - f;
    const partes = [
      'Aba impressa: ' + NOME_FONTE[f] + ' (' + registros(V.linhas[f].length) + ')',
      'Unidade: ' + (V.unidade === TODAS ? 'todas' : rotuloUnidade(V.unidade)),
      'Período: ' + dataBr(S.inicio) + ' a ' + dataBr(S.fim),
    ];
    for (const fa of facetas) {
      if (!fa.sel.size) continue;
      const vs = [];
      fa.sel.forEach((v) => vs.push(fa.rotulo(v)));
      partes.push(fa.def.t + ': ' + vs.join(', '));
    }
    partes.push('Com os mesmos filtros, a aba ' + NOME_FONTE[outra] + ' (fora desta impressão) tem ' + registros(V.linhas[outra].length));
    el.resumoImp.textContent = partes.join(' · ');
  }

  /* ============================== Abas e painéis (um par por fonte) ============================== */

  /** Monta os dois painéis a partir do mesmo modelo e guarda em P[f] os elementos de cada fonte. */
  function prepararPaineis() {
    const modelo = $('modelo-painel');
    for (let f = 0; f < 2; f++) {
      const painel = $('painel-' + ABAS[f]);
      painel.appendChild(modelo.content.cloneNode(true));
      const p = { f: f, aba: $('aba-' + ABAS[f]), badge: $('aba-' + ABAS[f] + '-n'), painel: painel, kpi: [], pg: {}, suja: true };
      painel.querySelectorAll('[data-p]').forEach((e) => { p[e.dataset.p] = e; });
      painel.querySelectorAll('[data-pg]').forEach((e) => { p.pg[e.dataset.pg] = e; });
      for (const d of KPIS) p.kpi.push(painel.querySelector('[data-kpi="' + d.id + '"] .kpi__valor'));
      p.kpis.setAttribute('aria-label', 'Indicadores — ' + NOME_FONTE[f]);
      p.rolagem.setAttribute('aria-label', 'Tabela de compras registradas — ' + NOME_FONTE[f]);
      p.legenda.textContent = 'Compras registradas do material selecionado na fonte ' + NOME_FONTE[f] + ', conforme os filtros aplicados';
      p.paginacao.setAttribute('aria-label', 'Paginação da tabela — ' + NOME_FONTE[f]);
      prepararTabela(p);
      painel.addEventListener('click', (ev) => {
        const b = ev.target.closest('button');
        if (!b || !S.item) return;
        if (b === p.baixar) exportarCsv();
        else if (b.dataset.ver !== undefined) mostrarAba(Number(b.dataset.ver), true);
        else if (b.dataset.repetir !== undefined) {
          p.aba.focus();                    // o botão some com o alerta: o foco vai para a aba, que mostra o andamento
          if (f === 0) carregarBps(); else carregarCg();
        }
      });
      P.push(p);
    }
  }

  /** Selo de cada aba: nº de registros da fonte que atendem a todos os filtros; sinaliza carga em andamento e falha. */
  function renderAbas() {
    for (let f = 0; f < 2; f++) {
      const p = P[f], estado = dadosDaFonte(f).estado, n = V.linhas[f].length;
      let h;
      if (estado === 'carregando') {
        h = (n ? int(n) : '') + GIRO + '<span class="sr">' + (n ? ' registros até agora, ' : '') + 'carregando</span>';
      } else if (estado === 'erro' || estado === 'indisponivel') {
        h = (n ? int(n) + '<span class="sr"> registros carregados, </span>' : '') + AVISO +
          '<span class="sr">' + (estado === 'erro' ? 'consulta não concluída' : 'fonte indisponível') + '</span>';
      } else {
        h = int(n) + '<span class="sr">' + (n === 1 ? ' registro' : ' registros') + '</span>';
      }
      if (h !== p.badgeHtml) { p.badgeHtml = h; p.badge.innerHTML = h; }
    }
  }

  function marcarAba() {
    for (const p of P) {
      const aberta = p.f === S.aba;
      p.aba.setAttribute('aria-selected', aberta ? 'true' : 'false');
      p.aba.tabIndex = aberta ? 0 : -1;
      p.painel.hidden = !aberta;
    }
  }

  /** Troca de aba: só acontece por ação da pessoa (clique, teclado ou o atalho do estado vazio). */
  function mostrarAba(f, focar) {
    if (f !== S.aba) {
      S.aba = f;
      marcarAba();
      if (P[f].suja) renderTabela(f);
      renderExportacao();
      renderResumoImpressao();
      gravarUrl();
    }
    if (focar) P[f].aba.focus();
  }

  function prepararAbas() {
    const lista = P[0].aba.parentNode;
    lista.addEventListener('click', (ev) => {
      const b = ev.target.closest('[role="tab"]');
      if (b) mostrarAba(ABAS.indexOf(b.dataset.aba), false);
    });
    lista.addEventListener('keydown', (ev) => {
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
      let f;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') f = 1 - S.aba;
      else if (ev.key === 'Home') f = 0;
      else if (ev.key === 'End') f = 1;
      else return;
      ev.preventDefault();
      mostrarAba(f, true);
    });
  }

  /** "Baixar dados" (em cada painel) e "Exportar" (no cabeçalho) valem para a aba aberta. */
  function renderExportacao() {
    for (const p of P) p.baixar.disabled = !V.linhas[p.f].length;
    const n = V.linhas[S.aba].length, nome = NOME_FONTE[S.aba];
    el.btnExportar.disabled = !n;
    el.btnExportar.title = !S.item ? 'Selecione um material para exportar os dados'
      : n ? 'Baixar em CSV ' + (n === 1 ? 'o registro' : 'os ' + registros(n)) + ' da aba ' + nome
        : 'A aba ' + nome + ' não tem registros para exportar';
  }

  /* ============================== URL ============================== */

  let ultimaUrl = null;
  function gravarUrl() {
    const p = new URLSearchParams();
    if (S.item) p.set('codigo', String(S.item.codigo));
    if (S.aba !== 0) p.set('aba', ABAS[S.aba]);         // a aba padrão (BPS) não precisa ir para a URL
    if (S.item) {
      p.set('inicio', S.inicio);
      p.set('fim', S.fim);
      // A unidade automática só é gravada quando as cargas terminam (antes disso ela ainda pode mudar).
      if (S.unidade !== null || !(carregando(0) || carregando(1))) {
        p.set('unidade', V.unidade === TODAS ? 'todas' : V.unidade);
      }
    } else {
      const d = periodoPadrao();
      if (S.inicio !== d.inicio || S.fim !== d.fim) { p.set('inicio', S.inicio); p.set('fim', S.fim); }
    }
    const qs = p.toString();
    const url = location.pathname + (qs ? '?' + qs : '') + location.hash;
    if (url === ultimaUrl) return;
    ultimaUrl = url;
    try { history.replaceState(history.state, '', url); } catch (_) { /* ambiente sem History API utilizável */ }
  }

  function lerUrl() {
    const q = new URLSearchParams(location.search);
    // Links antigos traziam "fonte=bps|cg|ambas": "cg" abre a aba do Compras.gov.br; os demais, a do BPS.
    const aba = ABAS.indexOf(q.get('aba'));
    if (aba >= 0) S.aba = aba;
    else if (q.get('fonte') === 'cg') S.aba = 1;
    const d = periodoPadrao();
    const i = q.get('inicio'), t = q.get('fim');
    S.inicio = dataValida(i) ? i : d.inicio;
    S.fim = dataValida(t) ? t : d.fim;
    if (S.inicio > S.fim) { S.inicio = d.inicio; S.fim = d.fim; }
    const u = q.get('unidade');
    if (u) S.unidade = u.toLowerCase() === 'todas' ? TODAS : chaveDe(limparUnidade(u));
    const c = q.get('codigo');
    return c && /^\d{1,9}$/.test(c) ? Number(c) : null;
  }

  /* ============================== Período e demais controles ============================== */

  let periodoTimer = 0;
  function erroPeriodo(msg) {
    el.periodoErro.hidden = !msg;
    el.periodoErro.textContent = msg || '';
    el.periodo.classList.toggle('tem-erro', !!msg);
    el.inicio.setAttribute('aria-invalid', msg ? 'true' : 'false');
    el.fim.setAttribute('aria-invalid', msg ? 'true' : 'false');
  }

  function aplicarPeriodo() {
    const i = el.inicio.value, t = el.fim.value;
    if (!dataValida(i) || !dataValida(t)) { erroPeriodo('Informe as datas de início e de término (a partir de 1990).'); return; }
    if (i > t) { erroPeriodo('A data de início deve ser anterior ou igual à data de término.'); return; }
    erroPeriodo('');
    if (i === S.inicio && t === S.fim) return;
    S.inicio = i;
    S.fim = t;
    zerarPaginas();
    if (S.item) carregarBps();     // o Compras.gov.br é filtrado por data no navegador
    agendar();
  }

  function prepararControles() {
    const aoMudarPeriodo = () => { clearTimeout(periodoTimer); periodoTimer = setTimeout(aplicarPeriodo, 350); };
    el.inicio.addEventListener('change', aoMudarPeriodo);
    el.fim.addEventListener('change', aoMudarPeriodo);
    el.inicio.addEventListener('blur', () => { clearTimeout(periodoTimer); aplicarPeriodo(); });
    el.fim.addEventListener('blur', () => { clearTimeout(periodoTimer); aplicarPeriodo(); });

    el.unidade.addEventListener('change', () => {
      S.unidade = el.unidade.value;
      zerarPaginas();
      agendar();
    });

    el.limpar.addEventListener('click', () => {
      limparFacetas();
      S.unidade = null;
      zerarPaginas();
      const d = periodoPadrao();
      const mudou = d.inicio !== S.inicio || d.fim !== S.fim;
      S.inicio = d.inicio;
      S.fim = d.fim;
      el.inicio.value = d.inicio;
      el.fim.value = d.fim;
      clearTimeout(periodoTimer);
      erroPeriodo('');
      if (mudou && S.item) carregarBps();
      agendar();
    });

    el.tags.addEventListener('click', (ev) => {
      const b = ev.target.closest('.tag__x');
      if (!b) return;
      const ref = tagsRef[Number(b.dataset.i)];
      if (!ref) return;
      ref.f.remover(ref.v);
      zerarPaginas();
      agendar();
      el.maisToggle.focus();
    });

    el.chips.addEventListener('click', (ev) => {
      const b = ev.target.closest('.chip');
      if (!b) return;
      const i = Number(b.dataset.i);
      selecionarItem({ codigo: Cat.cod[i], descricao: Cat.desc[i] });
      el.conteudo.focus({ preventScroll: true });
    });

    el.btnExportar.addEventListener('click', exportarCsv);

    // Modal de informações (elemento <dialog>: foco preso, Esc fecha, foco volta ao botão).
    const dlg = el.modal;
    el.btnInfo.addEventListener('click', () => {
      if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    });
    const fecharModal = () => { if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open'); el.btnInfo.focus(); };
    dlg.addEventListener('click', (ev) => {
      if (ev.target === dlg || ev.target.closest('[data-fechar]')) fecharModal();
    });
    dlg.addEventListener('close', () => el.btnInfo.focus());
  }

  /* ============================== Ciclo de atualização ============================== */

  let agendado = false;
  function agendar() {
    if (agendado) return;
    agendado = true;
    queueMicrotask(() => { agendado = false; atualizar(); });
  }

  function atualizar() {
    recalcular();
    renderUnidades();
    renderAbas();
    renderKpis();
    P[0].suja = P[1].suja = true;
    renderTabela(S.aba);
    renderSituacao();
    renderAlertas();
    renderTags();
    renderExportacao();
    renderResumoImpressao();
    if (facetaAberta) facetaAberta.atualizarLista();
    gravarUrl();
  }

  /* ============================== Inicialização ============================== */

  function iniciar() {
    const ids = {
      conteudo: 'conteudo', itemInput: 'item-input', itemLista: 'item-lista', itemLimpar: 'item-limpar',
      unidade: 'unidade', inicio: 'inicio', fim: 'fim', periodo: 'periodo', periodoErro: 'periodo-erro',
      maisToggle: 'mais-toggle', maisCorpo: 'mais-filtros', maisContagem: 'mais-contagem', facetas: 'facetas',
      tags: 'tags', limpar: 'limpar', situacao: 'situacao', status: 'status', progresso: 'progresso',
      vazio: 'vazio', vazioFreq: 'vazio-freq', vazioNota: 'vazio-nota', chips: 'chips',
      resultados: 'resultados', titulo: 'item-titulo', resumoImp: 'resumo-impressao', rodape: 'rodape-fontes',
      btnInfo: 'btn-info', btnExportar: 'btn-exportar', modal: 'modal-info', infoCg: 'info-cg-extracao',
    };
    for (const k in ids) el[k] = $(ids[k]);

    const codigoInicial = lerUrl();
    el.inicio.value = S.inicio;
    el.fim.value = S.fim;

    prepararPaineis();
    prepararAbas();
    marcarAba();
    prepararFacetas();
    prepararCombo();
    prepararControles();

    carregarMeta();
    if (codigoInicial !== null) {
      carregarCatalogo();
      selecionarItem({ codigo: codigoInicial, descricao: '' }, true);
    } else {
      // O catálogo (necessário só para a busca e para os atalhos) entra quando o navegador estiver ocioso.
      if (window.requestIdleCallback) window.requestIdleCallback(carregarCatalogo, { timeout: 600 });
      else setTimeout(carregarCatalogo, 150);
      atualizar();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();
})();
