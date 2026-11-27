#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ETL Compras.gov.br -> dados estáticos do Painel de Preços da Saúde.

Uso:
    python3 scripts/etl_comprasgov.py <input_dir> <output_dir> [--shards N] [--jobs J] [--tmp DIR]

    <input_dir>   pasta com os arquivos classe_*.csv (os Relatorio_Integridade__*.csv são ignorados)
    <output_dir>  normalmente public/data  ->  meta.json, catalogo.json.gz e cg/<S>.json.gz (S = codigo % N)

Só usa a biblioteca padrão. Os CSVs são dados baixados (não confiáveis): rode com "python3 -I".
A saída é reprodutível (gzip sem mtime, ordenação que só depende do conteúdo); o único campo variável é
meta.geradoEm, que respeita a variável SOURCE_DATE_EPOCH quando definida.

O QUE FOI VERIFICADO NOS DADOS DE ENTRADA (carga 24-11: 16 arquivos, 1,17 GB, 1.856.215 linhas)
  * UTF-8 com BOM, fim de linha CRLF, separador "@", 39 colunas, cabeçalho idêntico nos 16 arquivos.
  * HÁ aspas: o arquivo segue a RFC 4180 (campo com '"' ou '@' vem entre aspas, aspas internas dobradas).
    Em 5 linhas um campo contém o separador (4 x marca, 1 x nomeFornecedor); um split("@") ingênuo erra
    essas linhas e deixa aspas em ~130 mil outras. Nenhum campo contém quebra de linha. Lido com o módulo
    csv (delimiter="@", quotechar='"'), todas as linhas têm 39 colunas (0 descartadas por contagem).
  * Aspas dobradas dentro dos valores (TUBO ""Y"") vêm da origem e são reduzidas a uma; há TAB e NBSP em marca.
  * Números em pt-BR ("7.000,00"); quantidade e precoUnitario sempre com 2 casas; quantidade sempre inteira.
  * "Preco Total" NÃO segue o pt-BR das outras colunas: vem sem separador de milhar, com vírgula decimal
    e sem zeros à direita ("1089", "3390,2", "176,85"). Conferido com aritmética decimal exata: é igual a
    quantidade x precoUnitario em 100% das linhas. Por isso total = qtd x preco (calculado aqui) e a coluna
    serve só de conferência (meta.normalizacoes.totalDivergente conta as diferenças; hoje 0).
  * dataCompra sempre válida (2020-12-24 a 2026-11-23); sem linhas duplicadas; sem datas futuras.
  * modalidade: 5, 6, 7, 3, 99 e 12 (Credenciamento: compras de 2025-2026, SISPP, sem critério de julgamento);
    esfera: só F/E/M; forma: só SISRP/SISPP; estado: 27 UFs + "EX" (1 linha, compra no exterior -> null).
  * niFornecedor: CNPJ em 99,7% das linhas; o resto são identificadores de estrangeiros ("ESTRANGEIRO",
    "US133326824"...) e 230 linhas com CPF completo de pessoa física, que é mascarado (***.NNN.NNN-**).

NORMALIZAÇÕES APLICADAS (além do mapeamento do contrato de dados)
  * textos: espaços/TAB/NBSP colapsados, caracteres de controle removidos, aspas dobradas reduzidas;
  * instituicao, fornecedor, idForn, fabricante, municipio e unidade em maiúsculas (junta "medix"/"MEDIX");
  * fabricante = null quando a marca é vazia, só pontuação (".", "-", "***") ou null/nan/none/na/n/a;
  * uf fora das 27 UFs -> null; CPF de pessoa física mascarado (ver MASCARAR_CPF).

LINHAS DESCARTADAS (contadas em meta.ignoradas, nesta ordem de teste)
  csvInvalido, colunasInvalidas, codigoInvalido, dataInvalida, valorNaoNumerico, precoNaoPositivo, qtdNaoPositiva
"""
import argparse
import csv
import datetime
import decimal
import glob
import json
import os
import re
import shutil
import struct
import sys
import tempfile
import time
import zlib
from collections import Counter
from decimal import Decimal, ROUND_HALF_UP
from multiprocessing import Pool

N_SHARDS = 2048          # S = codigo % N
N_GRUPOS = 64            # baldes temporários (cada um reúne N/64 shards); só afeta o uso de memória
MASCARAR_CPF = True      # CPF de fornecedor pessoa física vira "***.NNN.NNN-**" (dado pessoal, LGPD)

# Colunas de cada ROW (contrato compartilhado com o front-end e com /api/bps)
COLUNAS = ["data", "uf", "municipio", "instituicao", "idInst", "fornecedor", "idForn", "fabricante",
           "unidade", "qtd", "preco", "total", "modalidade", "esfera", "tipo", "generico"]

# Colunas do CSV que o ETL usa (procuradas pelo nome no cabeçalho)
USADAS = ["codigoItemCatalogo", "descricaoItem", "nomePdm", "forma", "modalidade", "Unidade de Fornecimento",
          "nomeUnidadeFornecimento", "quantidade", "precoUnitario", "Preco Total", "niFornecedor",
          "nomeFornecedor", "marca", "codigoUasg", "nomeUasg", "municipio", "estado", "esfera",
          "dataCompra", "dataResultado"]

MODALIDADES = {
    1: "Convite", 2: "Tomada de Preços", 3: "Concorrência", 4: "Concorrência Internacional", 5: "Pregão",
    6: "Dispensa de Licitação", 7: "Inexigibilidade de Licitação", 12: "Credenciamento", 20: "Concurso",
    22: "Tomada de Preços por Técnica e Preço", 33: "Concorrência por Técnica e Preço",
    44: "Concorrência Internacional por Técnica e Preço", 99: "RDC",
}
ESFERAS = {"F": "FEDERAL", "E": "ESTADUAL", "M": "MUNICIPAL"}
FORMAS = {"SISRP": "Registro de Preços (SRP)", "SISPP": "Compra direta (SISPP)"}
UFS = frozenset("AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO".split())
MOTIVOS = ["csvInvalido", "colunasInvalidas", "codigoInvalido", "dataInvalida", "valorNaoNumerico",
           "precoNaoPositivo", "qtdNaoPositiva"]
SEM_VALOR = frozenset(["", "NULL", "NAN", "NONE", "NA", "N/A"])   # marcadores usuais de valor ausente

Q2 = Decimal("0.01")
Q4 = Decimal("0.0001")
_NUM_BR = re.compile(r"-?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?\Z")
_DATA = re.compile(r"(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?\Z")
_ASPAS = re.compile(r'"{2,}')
_ALFANUM = re.compile(r"[^\W_]")
# controles viram espaço; hífen opcional e caracteres de largura zero somem
_LIXO = {c: " " for c in list(range(0x20)) + list(range(0x7F, 0xA0))}
_LIXO.update({c: None for c in (0xAD, 0x200B, 0x200C, 0x200D, 0x200E, 0x200F, 0x2060, 0xFEFF)})
_json = json.JSONEncoder(ensure_ascii=False, separators=(",", ":")).encode


def log(msg):
    print(msg, file=sys.stderr, flush=True)


# ----------------------------------------------------------------------------- normalização de campos

def limpa(s):
    """Colapsa espaços (inclui TAB/NBSP), remove controles e reduz aspas dobradas herdadas da origem."""
    s = " ".join(s.translate(_LIXO).split())
    if '""' in s:
        s = _ASPAS.sub('"', s)
    return s


def maiusc(s):
    """upper() que preserva o sinal de micro: 'µ'.upper() vira um 'Μ' grego e "30µg" passaria a ler "30MG"."""
    if "µ" in s or "μ" in s:
        return "".join(c if c in "µμ" else c.upper() for c in s)
    return s.upper()


def ausente(s):
    return s == "" or s.lower() == "null"


def cpf_valido(s):
    if len(s) != 11 or not (s.isascii() and s.isdigit()) or s == s[0] * 11:
        return False
    d = [int(c) for c in s]
    v1 = sum(d[i] * (10 - i) for i in range(9)) * 10 % 11 % 10
    v2 = sum(d[i] * (11 - i) for i in range(10)) * 10 % 11 % 10
    return v1 == d[9] and v2 == d[10]


def num_br(s):
    """'7.000,00' -> Decimal('7000.00'); None quando ausente ou fora do formato pt-BR."""
    if _NUM_BR.match(s):
        return Decimal(s.replace(".", "").replace(",", "."))
    return None


def num_json(d):
    """Decimal -> número JSON sem zeros à direita (10 em vez de 10.0; 3390.2; 0.0001)."""
    s = format(d, "f")
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s


class Memo(dict):
    """Cache valor bruto -> valor tratado (os mesmos textos e números se repetem milhares de vezes)."""
    __slots__ = ("fn",)

    def __init__(self, fn):
        super().__init__()
        self.fn = fn

    def __missing__(self, chave):
        v = self[chave] = self.fn(chave)
        return v


# Cada função abaixo devolve o FRAGMENTO JSON pronto do campo.

def f_texto(s):                      # string obrigatória no contrato ("" se faltar)
    s = limpa(s)
    return _json("" if ausente(s) else maiusc(s))


def f_texto_ou_null(s):
    s = limpa(s)
    return "null" if ausente(s) else _json(maiusc(s))


def f_fabricante(s):
    s = maiusc(limpa(s))
    return "null" if s in SEM_VALOR or not _ALFANUM.search(s) else _json(s)


def f_uf(s):
    s = s.strip().upper()
    return _json(s) if s in UFS else "null"


def f_id_fornecedor(s):
    s = maiusc(limpa(s))
    if ausente(s):
        return '""'
    if MASCARAR_CPF and cpf_valido(s):
        s = "***.%s.%s-**" % (s[3:6], s[6:9])
    return _json(s)


def f_id(s):
    s = limpa(s)
    return '""' if ausente(s) else _json(s)


def f_modalidade(s):
    s = s.strip()
    if ausente(s):
        return _json("Não informada")
    rotulo = MODALIDADES.get(int(s)) if s.isascii() and s.isdigit() else None
    return _json(rotulo or "Modalidade " + limpa(s))


def f_esfera(s):
    r = ESFERAS.get(s.strip().upper())
    return _json(r) if r else "null"


def f_tipo(s):
    s = limpa(s)
    if ausente(s):
        return "null"
    return _json(FORMAS.get(s.upper(), s))


def f_data(s):
    """'AAAA-MM-DD' (aceita sufixo de hora) -> fragmento '"AAAA-MM-DD"'; '' se não for data válida."""
    m = _DATA.match(s)
    if not m:
        return ""
    try:
        datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return ""
    return '"%s"' % s[:10]


def f_codigo(s):
    return int(s) if s and s.isascii() and s.isdigit() else -1


def f_qtd(s):
    d = num_br(s)
    if d is None:
        return None
    if d.as_tuple().exponent < -2:
        d = d.quantize(Q2, ROUND_HALF_UP)
    return d, num_json(d)


def f_preco(s):
    d = num_br(s)
    if d is None:
        return None
    if d.as_tuple().exponent < -4:
        d = d.quantize(Q4, ROUND_HALF_UP)
    return d, num_json(d)


def f_descricao(s):
    s = limpa(s).replace(" ,", ",")
    return "" if ausente(s) else s


# ----------------------------------------------------------------------------- fase 1: CSV -> baldes

def processa_arquivo(tarefa):
    """Lê um CSV, valida/mapeia cada linha e grava 'codigo<TAB>ROW-json' no balde do shard. Devolve estatísticas."""
    indice, caminho, tmp, n_shards, n_grupos = tarefa
    decimal.getcontext().prec = 60
    ign = dict.fromkeys(MOTIVOS, 0)
    norm = {"cpfMascarados": 0, "ufForaDoBrasil": 0, "fabricanteAusente": 0, "municipioAusente": 0,
            "totalDivergente": 0}
    c_mod, c_esf, c_tipo, c_cod_mod = Counter(), Counter(), Counter(), Counter()
    descricoes = {}                                   # (codigo, descrição bruta) -> nº de linhas mantidas
    m_cod, m_data = Memo(f_codigo), Memo(f_data)
    m_qtd, m_preco = Memo(f_qtd), Memo(f_preco)
    m_uf, m_mun, m_inst, m_idinst = Memo(f_uf), Memo(f_texto_ou_null), Memo(f_texto), Memo(f_id)
    m_forn, m_idforn, m_fab, m_unid = Memo(f_texto), Memo(f_id_fornecedor), Memo(f_fabricante), Memo(f_texto)
    m_mod, m_esf, m_tipo = Memo(f_modalidade), Memo(f_esfera), Memo(f_tipo)
    lidas = mantidas = 0
    data_min, data_max = '"9999"', '"0000"'
    baldes = [open(os.path.join(tmp, "g%03d_%03d.tsv" % (g, indice)), "w", encoding="utf-8", newline="\n",
                   buffering=1 << 16) for g in range(n_grupos)]
    try:
        with open(caminho, "r", encoding="utf-8-sig", errors="replace", newline="") as f:
            leitor = csv.reader(f, delimiter="@", quotechar='"', doublequote=True, strict=True)
            try:
                cab = next(leitor)
            except StopIteration:
                cab = []
            pos = {nome.strip(): i for i, nome in enumerate(cab)}
            faltam = [c for c in USADAS if c not in pos]
            if faltam:   # (ValueError, e não SystemExit: precisa voltar ao processo principal pelo Pool)
                raise ValueError("%s: cabeçalho sem as colunas %s" % (os.path.basename(caminho), faltam))
            ncol = len(cab)
            (i_cod, i_desc, i_pdm, i_forma, i_mod, i_unid, i_unid2, i_qtd, i_preco, i_tot, i_ni, i_forn, i_marca,
             i_uasg, i_nuasg, i_mun, i_uf, i_esf, i_dc, i_dr) = [pos[c] for c in USADAS]
            while True:
                try:
                    p = next(leitor)
                except StopIteration:
                    break
                except csv.Error:
                    lidas += 1
                    ign["csvInvalido"] += 1
                    continue
                lidas += 1
                if len(p) != ncol:
                    ign["colunasInvalidas"] += 1
                    continue
                cod = m_cod[p[i_cod].strip()]
                if cod < 0:
                    ign["codigoInvalido"] += 1
                    continue
                data = m_data[p[i_dc]] or m_data[p[i_dr]]
                if not data:
                    ign["dataInvalida"] += 1
                    continue
                vq = m_qtd[p[i_qtd]]
                vp = m_preco[p[i_preco]]
                if vq is None or vp is None:
                    ign["valorNaoNumerico"] += 1
                    continue
                preco, j_preco = vp
                if preco <= 0:
                    ign["precoNaoPositivo"] += 1
                    continue
                qtd, j_qtd = vq
                if qtd <= 0:
                    ign["qtdNaoPositiva"] += 1
                    continue
                j_total = num_json((qtd * preco).quantize(Q2, ROUND_HALF_UP))
                bruto = p[i_tot]
                if bruto.replace(",", ".") != j_total:          # confere com a coluna "Preco Total"
                    t = num_br(bruto)
                    if t is None and re.fullmatch(r"\d+(?:[.,]\d+)?", bruto):
                        t = Decimal(bruto.replace(",", "."))
                    if t is not None and abs(t - Decimal(j_total)) > Decimal("0.005"):
                        norm["totalDivergente"] += 1
                j_uf = m_uf[p[i_uf]]
                j_mun = m_mun[p[i_mun]]
                j_fab = m_fab[p[i_marca]]
                j_forn_id = m_idforn[p[i_ni]]
                j_mod = m_mod[p[i_mod]]
                j_esf = m_esf[p[i_esf]]
                j_tipo = m_tipo[p[i_forma]]
                j_unid = m_unid[p[i_unid]]
                if j_unid == '""':
                    j_unid = m_unid[p[i_unid2]]
                if j_uf == "null" and not ausente(p[i_uf].strip()):
                    norm["ufForaDoBrasil"] += 1
                if j_mun == "null":
                    norm["municipioAusente"] += 1
                if j_fab == "null":
                    norm["fabricanteAusente"] += 1
                if j_forn_id.startswith('"***.'):
                    norm["cpfMascarados"] += 1
                c_mod[j_mod] += 1
                c_cod_mod[p[i_mod]] += 1
                c_esf[j_esf] += 1
                c_tipo[j_tipo] += 1
                if data < data_min:
                    data_min = data
                if data > data_max:
                    data_max = data
                desc = p[i_desc]
                if desc == "" or desc == "null":
                    desc = p[i_pdm]
                chave = (cod, desc)
                descricoes[chave] = descricoes.get(chave, 0) + 1
                mantidas += 1
                baldes[cod % n_shards % n_grupos].write(
                    "%d\t[%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,null]\n" % (
                        cod, data, j_uf, j_mun, m_inst[p[i_nuasg]], m_idinst[p[i_uasg]], m_forn[p[i_forn]],
                        j_forn_id, j_fab, j_unid, j_qtd, j_preco, j_total, j_mod, j_esf, j_tipo))
    finally:
        for b in baldes:
            b.close()
    return {
        "arquivo": os.path.basename(caminho), "lidas": lidas, "mantidas": mantidas, "ignoradas": ign,
        "norm": norm, "modalidades": c_mod, "codigosModalidade": c_cod_mod, "esferas": c_esf, "tipos": c_tipo,
        "dataMin": data_min.strip('"'), "dataMax": data_max.strip('"'), "descricoes": descricoes,
    }


# ----------------------------------------------------------------------------- fase 2: baldes -> shards

def gzip_bytes(dados):
    """gzip nível 9 com cabeçalho fixo (mtime=0, sem nome, OS=255): mesma entrada -> mesmos bytes."""
    c = zlib.compressobj(9, zlib.DEFLATED, -15, 9)
    corpo = c.compress(dados) + c.flush()
    return (b"\x1f\x8b\x08\x00\x00\x00\x00\x00\x02\xff" + corpo
            + struct.pack("<II", zlib.crc32(dados) & 0xFFFFFFFF, len(dados) & 0xFFFFFFFF))


def grava(caminho, dados):
    parcial = caminho + ".parcial"
    with open(parcial, "wb") as f:
        f.write(dados)
    os.replace(parcial, caminho)


def _data_da_linha(row_json):
    return row_json[2:12]            # toda ROW começa por ["AAAA-MM-DD",


def grava_grupo(tarefa):
    """Junta os baldes de um grupo e grava cg/<S>.json.gz = {"<codigo>": [ROW, ...]} (ROWs por data desc)."""
    grupo, tmp, dir_cg, n_shards = tarefa
    shards = {}
    for caminho in sorted(glob.glob(os.path.join(tmp, "g%03d_*.tsv" % grupo))):
        with open(caminho, "r", encoding="utf-8", newline="\n") as f:
            for linha in f:
                cod, _, row = linha.rstrip("\n").partition("\t")
                cod = int(cod)
                shards.setdefault(cod % n_shards, {}).setdefault(cod, []).append(row)
    resumo, por_codigo = [], {}
    for s in sorted(shards):
        partes, n_linhas = [], 0
        for cod in sorted(shards[s]):
            rows = shards[s][cod]
            rows.sort()                                   # desempate estável: só depende do conteúdo
            rows.sort(key=_data_da_linha, reverse=True)   # data desc
            partes.append('"%d":[%s]' % (cod, ",".join(rows)))
            por_codigo[cod] = len(rows)
            n_linhas += len(rows)
        bruto = ("{" + ",".join(partes) + "}").encode("utf-8")
        comprimido = gzip_bytes(bruto)
        grava(os.path.join(dir_cg, "%d.json.gz" % s), comprimido)
        resumo.append((s, len(partes), n_linhas, len(bruto), len(comprimido)))
    return resumo, por_codigo


# ----------------------------------------------------------------------------- principal

def main():
    ap = argparse.ArgumentParser(description="ETL Compras.gov.br -> public/data (meta.json, catalogo.json.gz, cg/<S>.json.gz)")
    ap.add_argument("input_dir", help="pasta com os arquivos classe_*.csv")
    ap.add_argument("output_dir", help="pasta de saída (public/data)")
    ap.add_argument("--shards", type=int, default=N_SHARDS, help="número de shards N (padrão %d)" % N_SHARDS)
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 2, help="processos em paralelo")
    ap.add_argument("--tmp", default=None, help="pasta para os arquivos temporários (padrão: temp do sistema)")
    a = ap.parse_args()
    if a.shards < 1:
        ap.error("--shards deve ser >= 1")
    t0 = time.time()
    arquivos = sorted(glob.glob(os.path.join(a.input_dir, "classe_*.csv")))
    if not arquivos:
        raise SystemExit("nenhum arquivo classe_*.csv em %s" % a.input_dir)
    dir_cg = os.path.join(a.output_dir, "cg")
    os.makedirs(dir_cg, exist_ok=True)
    if a.tmp:
        os.makedirs(a.tmp, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="etl_comprasgov_", dir=a.tmp)
    n_grupos = min(N_GRUPOS, a.shards)
    jobs = max(1, a.jobs)
    try:
        # fase 1 (um processo por arquivo, os maiores primeiro)
        tarefas = [(i, c, tmp, a.shards, n_grupos) for i, c in enumerate(arquivos)]
        tarefas.sort(key=lambda t: -os.path.getsize(t[1]))
        log("fase 1: %d arquivos, %.2f GB" % (len(arquivos), sum(os.path.getsize(c) for c in arquivos) / 1e9))
        with Pool(jobs) as pool:
            partes = list(pool.imap_unordered(processa_arquivo, tarefas, chunksize=1))
            partes.sort(key=lambda r: r["arquivo"])
            for r in partes:
                log("  %-28s lidas %8d  mantidas %8d" % (r["arquivo"], r["lidas"], r["mantidas"]))
            log("fase 1 em %.1f s" % (time.time() - t0))
            # fase 2 (remove shards de execuções anteriores e grava os novos)
            for nome in os.listdir(dir_cg):
                if re.fullmatch(r"\d+\.json\.gz(\.parcial)?", nome):
                    os.remove(os.path.join(dir_cg, nome))
            t1 = time.time()
            resumo, por_codigo = [], {}
            for res, cods in pool.imap_unordered(grava_grupo, [(g, tmp, dir_cg, a.shards) for g in range(n_grupos)],
                                                 chunksize=1):
                resumo.extend(res)
                por_codigo.update(cods)
            log("fase 2 em %.1f s" % (time.time() - t1))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # consolidação
    lidas = sum(r["lidas"] for r in partes)
    mantidas = sum(r["mantidas"] for r in partes)
    ignoradas = {m: sum(r["ignoradas"][m] for r in partes) for m in MOTIVOS}
    norm = {k: sum(r["norm"][k] for r in partes) for k in partes[0]["norm"]}

    def soma(campo):
        c = Counter()
        for r in partes:
            c.update(r[campo])
        return c

    def rotulos(campo):               # fragmento JSON -> rótulo, ordenado por frequência
        return {("null" if k == "null" else json.loads(k)): v
                for k, v in sorted(soma(campo).items(), key=lambda kv: (-kv[1], kv[0]))}

    descricoes = {}                   # codigo -> Counter(descrição tratada)
    m_desc = Memo(f_descricao)
    for r in partes:
        for (cod, bruta), n in r["descricoes"].items():
            descricoes.setdefault(cod, Counter())[m_desc[bruta]] += n
    catalogo = []
    for cod, c in descricoes.items():
        # a descrição mais frequente do código; em empate, a primeira em ordem alfabética (determinístico)
        desc = min(c.items(), key=lambda kv: (-kv[1], kv[0]))[0]
        catalogo.append([cod, desc or "ITEM %d" % cod, sum(c.values())])
    catalogo.sort(key=lambda e: (-e[2], e[0]))

    # conferências internas: nada pode se perder entre a fase 1 e os arquivos gravados
    if lidas != mantidas + sum(ignoradas.values()):
        raise SystemExit("ERRO: lidas != mantidas + ignoradas")
    if {e[0]: e[2] for e in catalogo} != por_codigo:
        raise SystemExit("ERRO: contagem por código do catálogo difere da gravada nos shards")
    if sum(r[2] for r in resumo) != mantidas:
        raise SystemExit("ERRO: linhas gravadas nos shards != linhas mantidas")

    gz_cat = gzip_bytes(_json(catalogo).encode("utf-8"))
    grava(os.path.join(a.output_dir, "catalogo.json.gz"), gz_cat)

    tamanhos = sorted(r[4] for r in resumo)
    maior = max(resumo, key=lambda r: r[4])
    epoca = os.environ.get("SOURCE_DATE_EPOCH")
    agora = (datetime.datetime.fromtimestamp(int(epoca), datetime.timezone.utc) if epoca
             else datetime.datetime.now(datetime.timezone.utc))
    meta = {
        "fonte": "Compras.gov.br",
        "shards": a.shards,
        "linhas": mantidas,
        "itens": len(catalogo),
        "dataMin": min(r["dataMin"] for r in partes if r["mantidas"]) if mantidas else None,
        "dataMax": max(r["dataMax"] for r in partes if r["mantidas"]) if mantidas else None,
        "geradoEm": agora.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "colunas": COLUNAS,
        "linhasLidas": lidas,
        "ignoradas": ignoradas,
        "normalizacoes": norm,
        "modalidades": rotulos("modalidades"),
        "esferas": rotulos("esferas"),
        "tipos": rotulos("tipos"),
        "arquivosEntrada": len(arquivos),
        "arquivos": len(resumo) + 2,
        "shardsGravados": len(resumo),
        "maiorShard": {"shard": maior[0], "bytes": maior[4], "linhas": maior[2]},
        "bytesCatalogo": len(gz_cat),
        "bytes": 0,
    }
    fixo = sum(tamanhos) + len(gz_cat)
    for _ in range(5):                # "bytes" inclui o próprio meta.json: itera até estabilizar
        texto = json.dumps(meta, ensure_ascii=False, indent=1) + "\n"
        total = fixo + len(texto.encode("utf-8"))
        if meta["bytes"] == total:
            break
        meta["bytes"] = total
    grava(os.path.join(a.output_dir, "meta.json"), texto.encode("utf-8"))

    # resumo para quem roda o ETL
    print("shards (N): %d   gravados: %d   arquivos: %d" % (a.shards, len(resumo), len(resumo) + 2))
    print("bytes em %s: %d (%.2f MB)   catálogo: %d bytes, %d itens" % (
        a.output_dir, meta["bytes"], meta["bytes"] / 1e6, len(gz_cat), len(catalogo)))
    print("shard gz: maior %d bytes (shard %d, %d linhas), mediana %d, menor %d   JSON descomprimido: %.1f MB" % (
        maior[4], maior[0], maior[2], tamanhos[len(tamanhos) // 2], tamanhos[0], sum(r[3] for r in resumo) / 1e6))
    print("linhas: lidas %d, mantidas %d, ignoradas %d %s" % (lidas, mantidas, sum(ignoradas.values()), ignoradas))
    print("datas: %s a %s" % (meta["dataMin"], meta["dataMax"]))
    print("normalizações:", norm)
    print("modalidade (código bruto):", dict(soma("codigosModalidade").most_common()))
    print("modalidades:", meta["modalidades"])
    print("esferas:", meta["esferas"])
    print("tipos:", meta["tipos"])
    print("tempo total: %.1f s" % (time.time() - t0))


if __name__ == "__main__":
    main()
