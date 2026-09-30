// Financeiro Leonardo — lógica do app. Firestore no lugar do Apps Script:
// onSnapshot mantém tudo em tempo real, sem precisar recarregar a página.
// Regras de negócio (vencimento em dia útil, cálculo do dashboard, limite do
// cartão) foram trazidas do Code.gs original e agora rodam aqui no navegador.
//
// A única exceção é a integração de Open Finance (Pluggy, aba "Conexões
// Bancárias") — o clientId/clientSecret da Pluggy NUNCA podem aparecer aqui
// nem no index.html (arquivos públicos). Por isso existe um Code.gs
// separado, que guarda esse segredo nas Script Properties dele e repassa as
// chamadas pra API da Pluggy. Veja PLUGGY_PROXY_URL em firebase-init.js e a
// seção "CONEXÕES BANCÁRIAS" abaixo.

import { db, PLUGGY_PROXY_URL } from "./firebase-init.js";
import {
  collection, addDoc, updateDoc, deleteDoc, setDoc, doc, increment,
  onSnapshot, query, orderBy, where, getDocs, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

const STATE = {
  lancamentos: [],
  movimentacoes: [],
  cartoes: [],
  comprasParceladas: [],
  recorrentes: [],
  historico: [],
  feriados: [],
  planos: [],
  listaCompras: [],
  dinheiroExtra: [],
  conexoesBancarias: [],
  cartoesOpenFinance: [],
  regrasCategorizacaoOF: [],
  config: { rendaMensal: 0, saldoInicial: 0, metaGuardarMes: 0 },
  filtroMovMesDe: "",
  filtroMovMesAte: "",
  filtroMovBanco: "",
  filtroMovTipoConta: "",
  filtroMovRevisado: "",
  filtroMovTipo: "",
  buscaLivreMov: "",
  paginaMov: 1,
  movPorPagina: 30,
  filtroLCTipo: "",
  filtroLCCategoria: "",
  filtroLCStatus: "",
  filtroLCOrdenar: "data",
  dashPaginaAtual: 1,
  filtroCPMes: "",
  filtroDashMes: "",
  filtroDashDe: "",
  filtroDashAte: "",
  filtroDashTipo: "",
  filtroDashBanco: "",
  filtroDashCategoria: "",
  filtroDashCategoriasOutras: null,
  paginaDashTransacoes: 1
};

let recorrentesCarregados = false;
let jaVerificouRecorrentesPendentes = false;
let lancamentosCarregados = false;

// Evita sincronizar a mesma conexão bancária mais de uma vez por sessão —
// o listener de conexoesBancarias dispara de novo a cada escrita (inclusive
// a que a própria sincronização faz), então sem essa guarda ela reentraria
// em loop.
const conexoesAutoSincronizadasNestaSessao = new Set();

// Quando o modal "Novo lançamento" é aberto a partir de um campo específico
// (ex: o select de Movimentações), guardamos aqui pra, depois de salvar,
// selecionar automaticamente o lançamento recém-criado nesse campo.
let selectAlvoNovoLancamento = null;
let pendingSelecaoLancamento = null; // { selectId, lancamentoId }

/* ══════════════ HELPERS ══════════════ */

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function moeda(v) {
  return (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function arredondar2(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

// Converte "yyyy-MM-dd" pra "dd/MM/yyyy" só por texto — evita o bug clássico
// de fuso horário de criar um Date() a partir de uma string ISO.
function dataBR(iso) {
  if (!iso) return "—";
  const [a, m, d] = String(iso).split("-");
  return `${d}/${m}/${a}`;
}

// "yyyy-MM-dd" -> Date local (meia-noite no fuso do navegador), sem o
// deslocamento de um dia que "new Date('yyyy-MM-dd')" causa (ele interpreta
// como UTC).
function parseDataLocal(str) {
  const [ano, mes, dia] = String(str).split("-").map(Number);
  return new Date(ano, mes - 1, dia);
}

function formatarDataISO(d) {
  const ano = d.getFullYear();
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}

// "yyyy-MM" de hoje — usado como padrão nos filtros de mês (Dashboard,
// Contas a Pagar) sempre que a pessoa ainda não escolheu um mês.
function mesAtualISO() {
  const hoje = new Date();
  return `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
}

// Quantidade de dias de um mês no formato "yyyy-MM".
function diasNoMes(mesStr) {
  const [ano, mes] = String(mesStr).split("-").map(Number);
  return new Date(ano, mes, 0).getDate();
}

// "yyyy-MM" -> "Agosto/2026", pra exibição amigável nos cards e tabelas.
const NOMES_MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
function rotuloMes(mesStr) {
  const [ano, mes] = String(mesStr).split("-").map(Number);
  const nome = NOMES_MESES[mes - 1] || mesStr;
  return `${nome.charAt(0).toUpperCase()}${nome.slice(1)}/${ano}`;
}

function tsParaMillis(ts) {
  if (!ts) return Date.now();
  if (ts.toMillis) return ts.toMillis();
  return Number(ts) || 0;
}

function fmtDataHora(ts) {
  if (!ts || !ts.toDate) return "agora mesmo";
  const d = ts.toDate();
  return d.toLocaleDateString("pt-BR") + " às " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function mostrarToast(msg, erro) {
  const el = document.getElementById("toast");
  document.getElementById("toast-title").textContent = erro ? "Erro" : "Aviso";
  document.getElementById("toast-msg").textContent = msg;
  el.classList.remove("hidden");
  el.classList.toggle("erro", !!erro);
  clearTimeout(mostrarToast._t);
  mostrarToast._t = setTimeout(() => el.classList.add("hidden"), erro ? 7000 : 3500);
}

function mapaLancamentos() {
  const m = {};
  STATE.lancamentos.forEach((l) => (m[l.id] = l));
  return m;
}

// Une cartão cadastrado manualmente e cartão descoberto via Open Finance
// num único formato — "origemCartao" e "nomeExibicao" deixam quem chama
// tratar os dois sem precisar saber de qual coleção cada um veio.
function buscarCartaoUnificado(cartaoId) {
  if (!cartaoId) return null;
  const manual = STATE.cartoes.find((c) => c.id === cartaoId);
  if (manual) return { ...manual, origemCartao: "manual", nomeExibicao: manual.nome };
  const of = STATE.cartoesOpenFinance.find((c) => c.id === cartaoId);
  if (of) return { ...of, origemCartao: "openFinance", nomeExibicao: `${of.instituicao} — ${of.nome}` };
  return null;
}

// "Filtro mestre" das conexões bancárias: cada conexão tem um interruptor
// "Incluir no uso pessoal" (aba Conexões Bancárias). Uma conexão desligada
// some do Dashboard e de Movimentações em todo o app — só volta a aparecer
// religando o interruptor lá, não tem um jeito de "espiar" só numa tela.
// Serve pra separar conta PJ compartilhada de uso pessoal, por exemplo.
function conexoesAtivasParaPessoal() {
  const set = new Set();
  STATE.conexoesBancarias.forEach((c) => { if (c.ativoParaPessoal !== false) set.add(c.id); });
  return set;
}

// Dado antigo do Open Finance sem "conexaoId" (importado antes desse campo
// existir) fica visível por padrão — não escondemos algo sem saber de qual
// banco veio, pra não sumir dado sem explicação.
function movimentacaoVisivel(m, conexoesAtivas) {
  if (m.origem !== "Open Finance") return true;
  if (!m.conexaoId) return true;
  return conexoesAtivas.has(m.conexaoId);
}

/* ══════════════ REGRAS DE NEGÓCIO (vindas do Code.gs original) ══════════════ */

function ehDiaUtil(date, feriadosSet) {
  const diaSemana = date.getDay(); // 0=domingo, 6=sábado
  if (diaSemana === 0 || diaSemana === 6) return false;
  if (feriadosSet.has(formatarDataISO(date))) return false;
  return true;
}

// Vencimento cai no dia configurado (ou no último dia do mês, se o mês for
// mais curto). Se cair em fim de semana/feriado: empurra pro próximo dia
// útil, a menos que seja o último dia do mês — aí antecipa pro dia útil
// anterior. "referencia" pode ser um Date ou undefined (usa hoje).
function calcularProximoVencimento(diaVencimento, referencia) {
  const feriadosSet = new Set(STATE.feriados.map((f) => f.data));
  const hoje = referencia ? new Date(referencia) : new Date();
  const ano = hoje.getFullYear();
  const mes = hoje.getMonth();
  const ultimoDiaMes = new Date(ano, mes + 1, 0).getDate();
  const dia = Math.min(Number(diaVencimento), ultimoDiaMes);
  const ehUltimoDia = dia === ultimoDiaMes;
  let venc = new Date(ano, mes, dia);

  if (!ehDiaUtil(venc, feriadosSet)) {
    const passo = ehUltimoDia ? -1 : 1;
    while (!ehDiaUtil(venc, feriadosSet)) {
      venc.setDate(venc.getDate() + passo);
    }
  }
  return formatarDataISO(venc);
}

// Próxima data de compra de um item recorrente da Lista de Compras, a
// partir de uma data-base (normalmente "hoje", no momento em que o item foi
// marcado como comprado). Diferente do vencimento de custo recorrente, aqui
// não existe dia-do-mês fixo nem ajuste pra dia útil — é sempre "data-base +
// intervalo da recorrência".
function calcularProximaDataCompra(frequencia, intervaloDias, dataBaseStr) {
  const base = dataBaseStr ? parseDataLocal(dataBaseStr) : new Date();
  const d = new Date(base);
  if (frequencia === "semanal") d.setDate(d.getDate() + 7);
  else if (frequencia === "anual") d.setFullYear(d.getFullYear() + 1);
  else if (frequencia === "personalizada") d.setDate(d.getDate() + (Number(intervaloDias) || 30));
  else d.setMonth(d.getMonth() + 1); // "mensal" e qualquer valor desconhecido caem aqui
  return formatarDataISO(d);
}

function rotuloFrequenciaCompra(frequencia, intervaloDias) {
  if (frequencia === "semanal") return "Semanal";
  if (frequencia === "anual") return "Anual";
  if (frequencia === "personalizada") return `A cada ${Number(intervaloDias) || 0} dias`;
  return "Mensal";
}

// Em qual mês cai a primeira fatura de uma compra (parcelada ou à vista): se
// foi feita antes do dia de fechamento, ela soma na fatura que está fechando
// agora (mesmo mês da compra); se foi feita no dia do fechamento ou depois,
// o fechamento deste mês já passou, então ela cai na fatura do mês seguinte.
function calcularCicloInicial(dataCompraStr, diaFechamento) {
  const d = parseDataLocal(dataCompraStr);
  const mes = d.getMonth() + (d.getDate() < diaFechamento ? 0 : 1);
  const normalizado = new Date(d.getFullYear(), mes, 1);
  return { ano: normalizado.getFullYear(), mes: normalizado.getMonth() };
}

// "Limite utilizado" = soma das parcelas desse cartão ainda não pagas —
// volta a subir sozinho conforme as parcelas são marcadas como pagas.
function calcularLimiteUtilizado(cartaoId) {
  let total = 0;
  STATE.movimentacoes.forEach((m) => {
    if (m.cartaoId && String(m.cartaoId) === String(cartaoId) && m.pago !== true) {
      total += Number(m.valor) || 0;
    }
  });
  return total;
}

// Valor total das parcelas de cartão ainda não pagas cujo vencimento cai no
// mês atual — é o que você precisa separar do salário pra pagar a fatura.
// Sem cartaoId, soma todos os cartões; com cartaoId, soma só aquele cartão.
function calcularFaturaMesAtual(cartaoId) {
  const hoje = new Date();
  const anoMesAtual = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
  let total = 0;
  STATE.movimentacoes.forEach((m) => {
    if (!m.cartaoId) return;
    if (cartaoId && String(m.cartaoId) !== String(cartaoId)) return;
    if (m.pago === true) return;
    if (String(m.data || "").slice(0, 7) !== anoMesAtual) return;
    total += Number(m.valor) || 0;
  });
  return total;
}

// "Saldo atual" agora é só do mês escolhido: recebido (entradas pagas) menos
// pago (saídas pagas) — bate com a ideia de "quanto sobrou na conta", sem
// misturar contas de outros meses. O "saldo inicial" configurado (aba
// Configurações, "o que você tem em caixa hoje") só entra quando o mês
// escolhido é o mês corrente de verdade — pra mês passado/futuro ele não
// faz sentido, porque não representa o caixa daquele período.
function calcularDashboard(mes) {
  const mapaLanc = mapaLancamentos();
  const saldoInicial = Number(STATE.config.saldoInicial) || 0;
  const mesAtual = mesAtualISO();

  let entradasMes = 0;
  let saidasMes = 0;
  let entradasPagasMes = 0;
  let saidasPagasMes = 0;

  STATE.movimentacoes.forEach((m) => {
    if (String(m.data || "").slice(0, 7) !== mes) return;
    const l = mapaLanc[m.lancamentoId] || {};
    const valor = Number(m.valor) || 0;
    if (l.tipo === "Entrada") {
      entradasMes += valor;
      if (m.pago === true) entradasPagasMes += valor;
    } else if (l.tipo === "Saida") {
      saidasMes += valor;
      if (m.pago === true) saidasPagasMes += valor;
    }
  });

  // Dinheiro extra: entra na renda do mês pela data prevista; só vira saldo
  // quando marcado como "já entrou".
  STATE.dinheiroExtra.forEach((e) => {
    if (String(e.data || "").slice(0, 7) !== mes) return;
    const v = Number(e.valor) || 0;
    entradasMes += v;
    if (e.recebido === true) entradasPagasMes += v;
  });

  const saldoAtual = entradasPagasMes - saidasPagasMes + (mes === mesAtual ? saldoInicial : 0);

  // Dias restantes: mês passado já não tem mais dias pra gastar; mês futuro
  // conta com o mês inteiro (ainda não começou); mês corrente conta de hoje
  // até o fim do mês.
  let diasRestantes;
  if (mes < mesAtual) diasRestantes = 0;
  else if (mes > mesAtual) diasRestantes = diasNoMes(mes);
  else {
    const hoje = new Date();
    diasRestantes = diasNoMes(mes) - hoje.getDate() + 1;
  }
  // Desconta o quanto você quer guardar este mês ANTES de dividir pelos dias
  // que faltam — assim "quanto posso gastar por dia" já deixa essa reserva de
  // fora (pode ficar negativo: é o aviso de que, guardando a meta, não sobra
  // nada pra gastar — ou já faltou dinheiro pra guardar o que você queria).
  const metaGuardarMes = Number(STATE.config.metaGuardarMes) || 0;
  const saldoDisponivelParaGastar = saldoAtual - metaGuardarMes;
  const gastoPorDia = diasRestantes > 0 ? saldoDisponivelParaGastar / diasRestantes : 0;

  return { saldoAtual, entradasMes, saidasMes, entradasPagasMes, saidasPagasMes, diasRestantes, gastoPorDia, metaGuardarMes, saldoDisponivelParaGastar };
}

/* ══════════════ GRÁFICO "GASTOS POR CATEGORIA" + ESTIMATIVA MENSAL ══════════════
 *
 * Usa a MESMA definição de "saída do mês" que já aparece no card "Total a
 * pagar no mês" do Dashboard (todas as saídas com data naquele mês, pagas
 * ou não) — assim a soma das fatias da rosca sempre bate com aquele KPI.
 * Se o mês escolhido for o mês corrente (ainda em andamento), os valores
 * vêm do onSnapshot em tempo real, então atualizam sozinhos a cada nova
 * movimentação lançada — sem precisar recarregar a página.
 */

const CORES_CATEGORIAS = ["#7C3AED", "#F59E0B", "#16A34A", "#3B82F6", "#EC4899", "#DC2626", "#0EA5E9", "#A855F7", "#84CC16", "#D97706", "#14B8A6", "#F43F5E"];

// [{ categoria, valor }], só saídas do mês, ordenado do maior pro menor gasto.
function calcularGastosPorCategoria(mes) {
  const mapaLanc = mapaLancamentos();
  const porCategoria = {};
  STATE.movimentacoes.forEach((m) => {
    if (String(m.data || "").slice(0, 7) !== mes) return;
    const l = mapaLanc[m.lancamentoId] || {};
    if (l.tipo !== "Saida") return;
    const categoria = l.categoria || "Sem categoria";
    porCategoria[categoria] = (porCategoria[categoria] || 0) + (Number(m.valor) || 0);
  });
  return Object.entries(porCategoria)
    .map(([categoria, valor]) => ({ categoria, valor }))
    .sort((a, b) => b.valor - a.valor);
}

// { "2026-08": { total, porCategoria: { categoria: valor } } } — todos os
// meses que têm ao menos uma saída lançada, sem limite de quantos meses.
function calcularResumoMensal() {
  const mapaLanc = mapaLancamentos();
  const porMes = {};
  STATE.movimentacoes.forEach((m) => {
    const mes = String(m.data || "").slice(0, 7);
    if (mes.length !== 7) return;
    const l = mapaLanc[m.lancamentoId] || {};
    if (l.tipo !== "Saida") return;
    const valor = Number(m.valor) || 0;
    if (!porMes[mes]) porMes[mes] = { total: 0, porCategoria: {} };
    porMes[mes].total += valor;
    const categoria = l.categoria || "Sem categoria";
    porMes[mes].porCategoria[categoria] = (porMes[mes].porCategoria[categoria] || 0) + valor;
  });
  return porMes;
}

// Desenha a rosca em SVG puro (sem lib externa) — cada fatia é um arco de
// círculo feito com stroke-dasharray, técnica clássica pra gráfico de rosca
// só com CSS/SVG.
function svgRosca(dados) {
  const total = dados.reduce((s, d) => s + d.valor, 0);
  if (!total) return '<div class="empty" style="padding:30px 0;">Nenhuma saída registrada neste mês ainda.</div>';
  const tamanho = 180, espessura = 26;
  const r = (tamanho - espessura) / 2;
  const circunferencia = 2 * Math.PI * r;
  const cx = tamanho / 2, cy = tamanho / 2;
  let acumulado = 0;
  const arcos = dados.map((d, i) => {
    const comprimento = (d.valor / total) * circunferencia;
    const cor = CORES_CATEGORIAS[i % CORES_CATEGORIAS.length];
    const arco = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${cor}" stroke-width="${espessura}" stroke-dasharray="${comprimento} ${circunferencia - comprimento}" stroke-dashoffset="${-acumulado}" transform="rotate(-90 ${cx} ${cy})"></circle>`;
    acumulado += comprimento;
    return arco;
  }).join("");
  return (
    `<svg viewBox="0 0 ${tamanho} ${tamanho}" width="${tamanho}" height="${tamanho}">` +
    arcos +
    `<text x="${cx}" y="${cy - 5}" text-anchor="middle" class="rosca-total-label">Total</text>` +
    `<text x="${cx}" y="${cy + 15}" text-anchor="middle" class="rosca-total-valor">${moeda(total)}</text>` +
    `</svg>`
  );
}

function legendaCategorias(dados) {
  const total = dados.reduce((s, d) => s + d.valor, 0);
  if (!total) return "";
  return '<ul class="legenda-categorias">' + dados.map((d, i) => {
    const pct = (d.valor / total) * 100;
    const cor = CORES_CATEGORIAS[i % CORES_CATEGORIAS.length];
    return (
      `<li><span class="legenda-dot" style="background:${cor}"></span>` +
      `<span class="legenda-nome">${esc(d.categoria)}</span>` +
      `<span class="legenda-valor num">${moeda(d.valor)}</span>` +
      `<span class="legenda-pct num">${pct.toFixed(1)}%</span></li>`
    );
  }).join("") + "</ul>";
}

function renderGraficoCategorias(mes) {
  const dados = calcularGastosPorCategoria(mes);
  const emAndamento = mes === mesAtualISO();
  document.getElementById("dash-cat-mes-label").textContent =
    `Categorias com mais gasto em ${rotuloMes(mes)}` + (emAndamento ? " — mês em andamento, atualiza conforme você lança novas saídas." : ".");
  document.getElementById("dash-rosca-categorias").innerHTML = svgRosca(dados);
  document.getElementById("dash-legenda-categorias").innerHTML = legendaCategorias(dados);
}

function renderEstimativaMeses() {
  const porMes = calcularResumoMensal();
  const meses = Object.keys(porMes).sort().reverse(); // mais recente primeiro
  const kpisEl = document.getElementById("dash-estimativa-kpis");
  const bodyEl = document.getElementById("dash-estimativa-body");
  if (!meses.length) {
    kpisEl.innerHTML = "";
    bodyEl.innerHTML = '<tr><td colspan="3" class="empty">Nenhuma saída registrada ainda.</td></tr>';
    return;
  }
  const totalGeral = meses.reduce((s, m) => s + porMes[m].total, 0);
  const mediaMensal = totalGeral / meses.length;
  const mesMaior = meses.reduce((a, b) => (porMes[a].total > porMes[b].total ? a : b));

  kpisEl.innerHTML =
    kpiCard("Média mensal de gastos", moeda(mediaMensal), true) +
    kpiCard("Meses com registro", String(meses.length), true) +
    kpiCard("Mês com mais gasto", `${rotuloMes(mesMaior)} <small>(${moeda(porMes[mesMaior].total)})</small>`, true);

  bodyEl.innerHTML = meses.map((mes) => {
    const info = porMes[mes];
    const topCategoria = Object.entries(info.porCategoria).sort((a, b) => b[1] - a[1])[0];
    const tagAndamento = mes === mesAtualISO() ? ' <span class="stamp andamento">EM ANDAMENTO</span>' : "";
    return (
      `<tr><td>${rotuloMes(mes)}${tagAndamento}</td>` +
      `<td class="num">${moeda(info.total)}</td>` +
      `<td>${topCategoria ? `${esc(topCategoria[0])} <span class="sublabel">${moeda(topCategoria[1])}</span>` : "—"}</td></tr>`
    );
  }).join("");
}

/* ══════════════ NAVEGAÇÃO ══════════════ */

document.querySelectorAll(".sidebar a[data-view]").forEach((a) => {
  a.addEventListener("click", () => trocarView(a.dataset.view));
});

function trocarView(nome) {
  document.querySelectorAll(".sidebar a[data-view]").forEach((x) => x.classList.remove("active"));
  document.querySelector(`.sidebar a[data-view="${nome}"]`).classList.add("active");
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById("view-" + nome).classList.add("active");
  fecharMenuMobile();
}

function fecharMenuMobile() {
  document.getElementById("sidebar").classList.remove("mobile-open");
  document.getElementById("sidebar-backdrop").classList.remove("active");
}
document.getElementById("btn-abrir-menu").addEventListener("click", () => {
  document.getElementById("sidebar").classList.add("mobile-open");
  document.getElementById("sidebar-backdrop").classList.add("active");
});
document.getElementById("sidebar-backdrop").addEventListener("click", fecharMenuMobile);

/* ══════════════ RENDERIZAÇÃO ══════════════ */

// Select simples (sem busca) usado só na barra de ações em lote.
function preencherSelectLoteLancamento() {
  const sel = document.getElementById("lote-lancamento");
  if (!sel) return;
  sel.innerHTML = '<option value="">Aplicar lançamento…</option>' +
    [...STATE.lancamentos]
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"))
      .map((l) => `<option value="${esc(l.id)}">${esc(rotuloLancamento(l))}</option>`).join("");
}

function renderAll() {
  preencherSelectLoteLancamento();
  renderLancamentos();
  renderMovimentacoes();
  renderCartoes();
  renderComprasParceladas();
  renderParcelasCartao();
  renderRecorrentes();
  renderHistorico();
  renderDashboard();
  renderContasAPagar();
  renderDinheiroExtra();
}

// "Transferencia" é um terceiro tipo de lançamento (troca entre contas) —
// não é ganho nem gasto de verdade, então fica de fora das somas de
// Entrada/Saída em relatórios (KPIs, gráficos), mas continua aparecendo
// normalmente nas listagens.
function rotuloTipo(tipo) {
  if (!tipo) return "";
  if (tipo === "Entrada") return "Entrada";
  if (tipo === "Transferencia") return "Transferência";
  return "Saída";
}

function renderLancamentos() {
  const body = document.getElementById("lancs-body");
  if (!STATE.lancamentos.length) {
    body.innerHTML = '<tr><td colspan="4" class="empty">Nenhum lançamento cadastrado ainda.</td></tr>';
  } else {
    body.innerHTML = STATE.lancamentos.map((l) => (
      `<tr><td>${esc(l.nome)}</td><td><span class="badge-tipo ${l.tipo}">${rotuloTipo(l.tipo)}</span></td>` +
      `<td>${esc(l.categoria)}</td><td><button class="btn-small" data-editar-lanc="${l.id}">Editar</button></td></tr>`
    )).join("");
    document.querySelectorAll("[data-editar-lanc]").forEach((btn) => {
      btn.addEventListener("click", () => abrirModalEdicaoLancamento(btn.dataset.editarLanc));
    });
  }
  preencherCategorias();
  preencherSelectsLancamento();
}

function preencherCategorias() {
  const categorias = [...new Set(STATE.lancamentos.map((l) => l.categoria).filter(Boolean))].sort();
  document.getElementById("lista-categorias").innerHTML = categorias.map((c) => `<option value="${esc(c)}"></option>`).join("");
}

const CAMPOS_BUSCA_LANCAMENTO = [
  "mov-lancamento", "rec-lancamento", "compra-lancamento", "edit-mov-lancamento", "edit-rec-lancamento", "edit-compra-lancamento",
  "qa-mov-lancamento", "qa-compra-lancamento", "qa-rec-lancamento",
  "rev-lancamento"
];

function rotuloLancamento(l) {
  return `${l.nome} (${rotuloTipo(l.tipo)} — ${l.categoria})`;
}

// Cada campo "Lançamento" é, por baixo dos panos, um <input type="hidden">
// com o MESMO id que o <select> antigo tinha — todo o resto do código
// (leituras de .value, validações) continua funcionando sem mudar nada.
// Trocamos de <select> pra busca porque um <select> sem opção em branco
// sempre deixa ALGUM lançamento pré-selecionado (o primeiro da lista) —
// fácil de não notar e salvar no lançamento errado sem querer, e ficava
// mais visível logo depois de usar o botão "+" (a lista reordena e o
// campo "esquece" o que estava selecionado). Um campo de busca começa
// vazio de verdade.
function definirComboLancamento(id, lancamentoId) {
  const hidden = document.getElementById(id);
  const busca = document.getElementById(id + "-busca");
  const l = STATE.lancamentos.find((x) => x.id === lancamentoId);
  hidden.value = l ? l.id : "";
  if (busca) busca.value = l ? rotuloLancamento(l) : "";
}

// Liga cada campo de busca ao hidden correspondente — só precisa rodar uma
// vez (não a cada render), senão os listeners se acumulariam.
function iniciarBuscaLancamento() {
  CAMPOS_BUSCA_LANCAMENTO.forEach((id) => {
    const busca = document.getElementById(id + "-busca");
    if (!busca) return;
    busca.addEventListener("input", () => {
      const alvo = STATE.lancamentos.find((l) => rotuloLancamento(l) === busca.value);
      document.getElementById(id).value = alvo ? alvo.id : "";
    });
  });
}

function preencherSelectsLancamento() {
  const datalistHtml = STATE.lancamentos.map((l) => `<option value="${esc(rotuloLancamento(l))}">`).join("");
  const mapaPorId = mapaLancamentos();

  CAMPOS_BUSCA_LANCAMENTO.forEach((id) => {
    const hidden = document.getElementById(id);
    const busca = document.getElementById(id + "-busca");
    const datalist = document.getElementById("dl-" + id);
    if (datalist) datalist.innerHTML = datalistHtml;

    if (pendingSelecaoLancamento && pendingSelecaoLancamento.selectId === id && mapaPorId[pendingSelecaoLancamento.lancamentoId]) {
      definirComboLancamento(id, pendingSelecaoLancamento.lancamentoId);
      pendingSelecaoLancamento = null;
    } else if (hidden.value && !mapaPorId[hidden.value]) {
      // O lançamento selecionado foi excluído — limpa em vez de deixar um
      // ID morto guardado.
      hidden.value = "";
      if (busca) busca.value = "";
    } else if (hidden.value && busca && document.activeElement !== busca) {
      // Mantém o texto visível sincronizado (ex: se o nome do lançamento
      // mudou), mas nunca sobrescreve enquanto a pessoa está digitando.
      busca.value = rotuloLancamento(mapaPorId[hidden.value]);
    }
  });
}

/* ══════════════ MODAL: NOVO LANÇAMENTO (reutilizado em várias telas) ══════════════ */

function abrirModalNovoLancamento(selectAlvoId) {
  selectAlvoNovoLancamento = selectAlvoId || null;
  document.getElementById("novo-lanc-nome").value = "";
  document.getElementById("novo-lanc-tipo").value = "Entrada";
  document.getElementById("novo-lanc-categoria").value = "";
  document.getElementById("modal-novo-lancamento").classList.add("active");
  document.getElementById("novo-lanc-nome").focus();
}
function fecharModalNovoLancamento() {
  document.getElementById("modal-novo-lancamento").classList.remove("active");
  selectAlvoNovoLancamento = null;
}
document.querySelectorAll("[data-abrir-novo-lancamento]").forEach((btn) => {
  btn.addEventListener("click", () => abrirModalNovoLancamento(btn.dataset.abrirNovoLancamento));
});
document.getElementById("btn-cancelar-novo-lancamento").addEventListener("click", fecharModalNovoLancamento);
document.getElementById("modal-novo-lancamento").addEventListener("click", (e) => {
  if (e.target.id === "modal-novo-lancamento") fecharModalNovoLancamento();
});
document.getElementById("btn-salvar-novo-lancamento").addEventListener("click", async () => {
  const nome = document.getElementById("novo-lanc-nome").value.trim();
  const tipo = document.getElementById("novo-lanc-tipo").value;
  const categoria = document.getElementById("novo-lanc-categoria").value.trim();
  if (!nome || !categoria) return mostrarToast("Preencha nome e categoria.", true);
  try {
    const ref = await addDoc(collection(db, "lancamentos"), { nome, tipo, categoria, createdAt: serverTimestamp() });
    if (selectAlvoNovoLancamento) {
      pendingSelecaoLancamento = { selectId: selectAlvoNovoLancamento, lancamentoId: ref.id };
    }
    mostrarToast("Lançamento cadastrado!");
    fecharModalNovoLancamento();
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
});

function filtrarPorMes(lista) {
  if (!STATE.filtroMovMesDe && !STATE.filtroMovMesAte) return lista;
  return lista.filter((m) => {
    const anoMes = String(m.data || "").slice(0, 7);
    if (STATE.filtroMovMesDe && anoMes < STATE.filtroMovMesDe) return false;
    if (STATE.filtroMovMesAte && anoMes > STATE.filtroMovMesAte) return false;
    return true;
  });
}

function filtrarPorBanco(lista) {
  if (!STATE.filtroMovBanco) return lista;
  return lista.filter((m) => (m.instituicao || "") === STATE.filtroMovBanco);
}

function filtrarPorTipoConta(lista) {
  if (!STATE.filtroMovTipoConta) return lista;
  return lista.filter((m) => (m.contaTipo || "") === STATE.filtroMovTipoConta);
}

// "A revisar" vale pra QUALQUER movimentação ainda não conferida — não só
// as do Open Finance. Antes esta função exigia origem === "Open Finance",
// então quem lança à mão (ou migrou da planilha antiga) nunca via nada no
// filtro "Só a revisar", mesmo com tudo por conferir. Previsões de parcela
// futura ficam de fora: elas se resolvem sozinhas quando a parcela cai.
function precisaRevisao(m) {
  return m.previsao !== true && m.revisado !== true;
}

function filtrarPorRevisao(lista) {
  if (STATE.filtroMovRevisado === "nao") return lista.filter(precisaRevisao);
  if (STATE.filtroMovRevisado === "sim") return lista.filter((m) => !precisaRevisao(m));
  return lista;
}

function filtrarPorTipo(lista) {
  if (!STATE.filtroMovTipo) return lista;
  return lista.filter((m) => m.tipo === STATE.filtroMovTipo);
}

// Um texto só, juntando tudo que aparece na linha (lançamento, banco, tipo,
// categoria, valor, situação, descrição do banco, parcela...) — é contra
// isso que a busca livre compara.
function textoBuscavelMovimentacao(m) {
  return [
    m.nomeLancamento, rotuloTipo(m.tipo), m.categoria,
    m.instituicao, m.contaTipo === "cartao" ? "cartão" : "", m.descricaoOrigem, m.descricaoCompra,
    m.pago ? "Pago" : "Pendente", moeda(m.valor), m.parcelaAtual ? `Parcela ${m.parcelaAtual}/${m.parcelaTotal || ""}` : ""
  ].filter(Boolean).join(" ").toLowerCase();
}

function filtrarPorBuscaLivre(lista) {
  const termo = STATE.buscaLivreMov.trim().toLowerCase();
  if (!termo) return lista;
  return lista.filter((m) => textoBuscavelMovimentacao(m).includes(termo));
}

const CATEGORIAS_FATURA_CARTAO = ["Saldo de Fatura", "Débito Fatura"];

function ehMovimentacaoDeCartao(m) {
  return m.contaTipo === "cartao" || !!m.cartaoId || CATEGORIAS_FATURA_CARTAO.includes(m.categoria);
}

// União das conexões bancárias cadastradas + qualquer nome de banco já
// usado em movimentações importadas.
function preencherFiltroBanco(enriquecidas) {
  const nomes = new Set();
  STATE.conexoesBancarias.forEach((c) => { if (c.instituicao) nomes.add(c.instituicao); });
  enriquecidas.forEach((m) => { if (m.instituicao) nomes.add(m.instituicao); });
  const sel = document.getElementById("mov-filtro-banco");
  const valorAtual = sel.value;
  sel.innerHTML = '<option value="">Todos os bancos</option>' +
    [...nomes].sort((a, b) => a.localeCompare(b, "pt-BR")).map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
  if (valorAtual) sel.value = valorAtual;
}

// Todo filtro volta pra página 1. Sem isso, quem estava na página 3 e mudava
// o mês (ou clicava em "Ver todos os meses") continuava na página 3 de uma
// lista totalmente diferente — parecia que a paginação tinha travado.
document.getElementById("mov-filtro-banco").addEventListener("change", (e) => {
  STATE.filtroMovBanco = e.target.value;
  STATE.paginaMov = 1;
  renderMovimentacoes();
});
document.getElementById("mov-filtro-tipo-conta").addEventListener("change", (e) => {
  STATE.filtroMovTipoConta = e.target.value;
  STATE.paginaMov = 1;
  renderMovimentacoes();
});
document.getElementById("mov-filtro-revisado").addEventListener("change", (e) => {
  STATE.filtroMovRevisado = e.target.value;
  STATE.paginaMov = 1;
  renderMovimentacoes();
});

document.getElementById("mov-busca-livre").addEventListener("input", (e) => {
  STATE.buscaLivreMov = e.target.value;
  STATE.paginaMov = 1;
  renderMovimentacoes();
});
document.getElementById("mov-filtro-tipo").addEventListener("change", (e) => {
  STATE.filtroMovTipo = e.target.value;
  STATE.paginaMov = 1;
  renderMovimentacoes();
});

// Separado por tipo — uma Entrada não paga é dinheiro A RECEBER, não "a
// pagar". Transferência entre contas não é ganho nem gasto, fica de fora
// dessas somas (mas continua aparecendo na lista normalmente).
function renderMovKpis(filtradas, totalCartaoAberto) {
  let pago = 0, qtdPago = 0;
  let aPagar = 0, qtdAPagar = 0;
  let recebido = 0, qtdRecebido = 0;
  let aReceber = 0, qtdAReceber = 0;

  filtradas.forEach((m) => {
    if (m.tipo === "Transferencia") return;
    const valor = Number(m.valor) || 0;
    const ehEntrada = m.tipo === "Entrada";
    if (m.pago) {
      if (ehEntrada) { recebido += valor; qtdRecebido++; }
      else { pago += valor; qtdPago++; }
    } else {
      if (ehEntrada) { aReceber += valor; qtdAReceber++; }
      else { aPagar += valor; qtdAPagar++; }
    }
  });

  document.getElementById("mov-kpi-grid").innerHTML =
    kpiCard("Pago no período", moeda(pago) + ` <small>(${qtdPago})</small>`, true) +
    kpiCard("A pagar no período", moeda(aPagar) + ` <small>(${qtdAPagar})</small>`, aPagar === 0) +
    kpiCard("Recebido no período", moeda(recebido) + ` <small>(${qtdRecebido})</small>`, true) +
    kpiCard("A receber no período", moeda(aReceber) + ` <small>(${qtdAReceber})</small>`, true) +
    // Não é filtrado pelos filtros acima — é sempre o total em aberto agora
    // no cartão (o que vai virar cobrança no vencimento da fatura). O
    // detalhe de cada compra fica na aba Cartão de Crédito.
    kpiCard("A pagar no cartão", moeda(totalCartaoAberto), totalCartaoAberto === 0);
}

const PAGINA_MOV_TAMANHO = 30;

// IDs das movimentações marcadas com o checkbox, pra ações em lote.
const selecionadasMov = new Set();
// Última lista filtrada renderizada — usada pelo "selecionar tudo do filtro"
// e pelo modo de revisão rápida.
let ultimaListaFiltradaMov = [];

function renderMovimentacoes() {
  const mapaLanc = mapaLancamentos();
  const mapaCompra = {};
  STATE.comprasParceladas.forEach((c) => (mapaCompra[c.id] = c));
  const conexoesAtivas = conexoesAtivasParaPessoal();
  const enriquecidas = STATE.movimentacoes
    .filter((m) => movimentacaoVisivel(m, conexoesAtivas))
    .map((m) => {
      const l = mapaLanc[m.lancamentoId] || {};
      const compra = m.compraParceladaId ? mapaCompra[m.compraParceladaId] : null;
      return {
        ...m, nomeLancamento: l.nome || "(excluído)", tipo: l.tipo || "", categoria: l.categoria || "",
        descricaoCompra: compra ? compra.descricao : ""
      };
    });

  const totalCartaoAberto = enriquecidas
    .filter((m) => ehMovimentacaoDeCartao(m) && m.pago !== true)
    .reduce((s, m) => s + (Number(m.valor) || 0), 0);

  preencherFiltroBanco(enriquecidas);
  const filtradas = filtrarPorBuscaLivre(filtrarPorTipo(filtrarPorRevisao(filtrarPorTipoConta(filtrarPorBanco(filtrarPorMes(enriquecidas))))));

  ultimaListaFiltradaMov = filtradas;
  // Limpa da seleção tudo que saiu do filtro atual, pra não agir em lote
  // sobre linhas que a pessoa não está vendo.
  const idsFiltrados = new Set(filtradas.map((m) => m.id));
  [...selecionadasMov].forEach((id) => { if (!idsFiltrados.has(id)) selecionadasMov.delete(id); });

  const tamanhoPagina = STATE.movPorPagina === Infinity ? Math.max(filtradas.length, 1) : (STATE.movPorPagina || PAGINA_MOV_TAMANHO);
  const totalPaginasMov = Math.max(1, Math.ceil(filtradas.length / tamanhoPagina));
  STATE.paginaMov = Math.min(Math.max(1, STATE.paginaMov), totalPaginasMov);
  const inicioPaginaMov = (STATE.paginaMov - 1) * tamanhoPagina;
  const paginadas = filtradas.slice(inicioPaginaMov, inicioPaginaMov + tamanhoPagina);

  const body = document.getElementById("movs-body");
  if (!filtradas.length) {
    const temFiltro = STATE.filtroMovMesDe || STATE.filtroMovMesAte
      || STATE.filtroMovBanco || STATE.filtroMovTipoConta || STATE.filtroMovRevisado
      || STATE.filtroMovTipo || STATE.buscaLivreMov;
    body.innerHTML = `<tr><td colspan="8" class="empty">${temFiltro ? "Nenhuma movimentação com esse filtro." : "Nenhuma movimentação registrada ainda."}</td></tr>`;
  } else {
    body.innerHTML = paginadas.map((m) => {
      const aRevisar = precisaRevisao(m);
      const ehPrevisao = m.previsao === true;
      // Mostra o banco tanto pra transação já confirmada (origem "Open
      // Finance") quanto pra compra parcelada lançada à mão num cartão
      // Open Finance (que só tem "instituicao" preenchido, sem ainda ter
      // vindo do banco de verdade).
      const colunaBanco = (m.origem === "Open Finance" || m.instituicao)
        ? esc(m.instituicao || "não identificado") + (m.contaTipo === "cartao" ? '<span class="sublabel">cartão</span>' : "")
        : "—";
      const rotuloParcela = m.parcelaAtual
        ? `Parcela ${m.parcelaAtual}${m.parcelaTotal ? "/" + m.parcelaTotal : ""}${m.valorTotalCompra ? ` (total ${moeda(m.valorTotalCompra)})` : ""}`
        : "";
      // Pra cartão, "data" é o vencimento da fatura, não quando a compra
      // aconteceu — mostra a data real como referência quando for
      // diferente, senão fica parecendo que a compra foi feita no dia do
      // vencimento.
      const rotuloDataReal = (m.dataTransacaoReal && m.dataTransacaoReal !== m.data)
        ? `Comprado em ${dataBR(m.dataTransacaoReal)}`
        : "";
      const sublabels = [
        m.descricaoCompra,
        rotuloParcela,
        m.descricaoOrigem,
        rotuloDataReal
      ].filter(Boolean).map((s) => `<span class="sublabel">${esc(s)}</span>`).join("");
      return (
        `<tr class="linha-clicavel${aRevisar ? " linha-a-revisar" : ""}" data-abrir-mov="${m.id}">` +
        `<td class="col-check"><input type="checkbox" class="check-mov" data-selecionar-mov="${m.id}"${selecionadasMov.has(m.id) ? " checked" : ""}></td>` +
        `<td>${dataBR(m.data)}</td><td>${esc(m.nomeLancamento)}${aRevisar ? ' <span class="stamp revisar">A REVISAR</span>' : ""}${ehPrevisao ? ' <span class="stamp reconexao">PREVISÃO</span>' : ""}${sublabels}</td>` +
        `<td>${colunaBanco}</td>` +
        `<td><span class="badge-tipo ${m.tipo}">${rotuloTipo(m.tipo)}</span></td>` +
        `<td>${esc(m.categoria)}</td><td class="num">${moeda(m.valor)}</td>` +
        `<td><span class="stamp ${m.pago ? "pago" : "pendente"}" data-alternar-pagamento="${m.id}" data-novo-pago="${!m.pago}">${m.pago ? "PAGO" : "PENDENTE"}</span></td></tr>`
      );
    }).join("");
    // Escopado no corpo desta tabela (era "document.querySelectorAll"): como
    // as tabelas de Contas a Pagar e Cartão usam os mesmos atributos
    // data-abrir-mov/data-alternar-pagamento, o seletor global reanexava um
    // listener nelas a cada render — clicar lá disparava a ação várias vezes
    // (o pagamento alternava e voltava sozinho).
    body.querySelectorAll("[data-abrir-mov]").forEach((tr) => {
      tr.addEventListener("click", (e) => {
        if (e.target.closest("[data-alternar-pagamento]") || e.target.closest("[data-selecionar-mov]")) return;
        abrirModalMovimentacao(tr.dataset.abrirMov);
      });
    });
    body.querySelectorAll("[data-alternar-pagamento]").forEach((stamp) => {
      stamp.addEventListener("click", (e) => {
        e.stopPropagation();
        alternarPagamento(stamp.dataset.alternarPagamento, stamp.dataset.novoPago === "true");
      });
    });
    body.querySelectorAll("[data-selecionar-mov]").forEach((cb) => {
      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", () => {
        if (cb.checked) selecionadasMov.add(cb.dataset.selecionarMov);
        else selecionadasMov.delete(cb.dataset.selecionarMov);
        renderBarraLoteMov();
      });
    });
  }
  renderBarraLoteMov();

  const primeiroItem = filtradas.length ? inicioPaginaMov + 1 : 0;
  const ultimoItem = Math.min(inicioPaginaMov + tamanhoPagina, filtradas.length);
  const paginacaoMov = document.getElementById("mov-paginacao");
  paginacaoMov.innerHTML = filtradas.length ? (
    `<button class="btn btn-small" id="btn-mov-pag-primeira" ${STATE.paginaMov <= 1 ? "disabled" : ""}>« Primeira</button>` +
    `<button class="btn btn-small" id="btn-mov-pag-anterior" ${STATE.paginaMov <= 1 ? "disabled" : ""}>‹ Anterior</button>` +
    `<span class="pg-info">Página ${STATE.paginaMov} de ${totalPaginasMov} — mostrando ${primeiroItem}–${ultimoItem} de ${filtradas.length}</span>` +
    `<button class="btn btn-small" id="btn-mov-pag-proxima" ${STATE.paginaMov >= totalPaginasMov ? "disabled" : ""}>Próxima ›</button>` +
    `<button class="btn btn-small" id="btn-mov-pag-ultima" ${STATE.paginaMov >= totalPaginasMov ? "disabled" : ""}>Última »</button>`
  ) : "";
  const irParaPagina = (n) => { STATE.paginaMov = n; renderMovimentacoes(); window.scrollTo({ top: document.getElementById("movs-body").closest(".card").offsetTop - 20, behavior: "smooth" }); };
  const btnMovPrimeira = document.getElementById("btn-mov-pag-primeira");
  if (btnMovPrimeira) btnMovPrimeira.addEventListener("click", () => irParaPagina(1));
  const btnMovAnterior = document.getElementById("btn-mov-pag-anterior");
  if (btnMovAnterior) btnMovAnterior.addEventListener("click", () => irParaPagina(STATE.paginaMov - 1));
  const btnMovProxima = document.getElementById("btn-mov-pag-proxima");
  if (btnMovProxima) btnMovProxima.addEventListener("click", () => irParaPagina(STATE.paginaMov + 1));
  const btnMovUltima = document.getElementById("btn-mov-pag-ultima");
  if (btnMovUltima) btnMovUltima.addEventListener("click", () => irParaPagina(totalPaginasMov));

  // Contador de pendências de revisão — respeita todos os filtros menos o
  // próprio filtro de revisão, pra sempre mostrar quanto falta conferir.
  const semFiltroRevisao = filtrarPorBuscaLivre(filtrarPorTipo(filtrarPorTipoConta(filtrarPorBanco(filtrarPorMes(enriquecidas)))));
  const qtdARevisar = semFiltroRevisao.filter(precisaRevisao).length;
  const avisoEl = document.getElementById("mov-aviso-revisao");
  if (qtdARevisar) {
    avisoEl.innerHTML = `<strong>${qtdARevisar}</strong> movimentação(ões) ainda por revisar neste filtro.` +
      ` <button class="btn-link" id="btn-revisar-agora">Revisar uma por uma →</button>`;
    avisoEl.classList.remove("hidden");
    document.getElementById("btn-revisar-agora").addEventListener("click", () => abrirModoRevisao());
  } else {
    avisoEl.classList.add("hidden");
    avisoEl.innerHTML = "";
  }

  renderMovKpis(filtradas, totalCartaoAberto);
}

/* ══════════════ REVISÃO: SELEÇÃO EM LOTE ══════════════ */

// Barra que aparece quando há linhas marcadas — permite classificar várias
// movimentações de uma vez, em vez de abrir uma por uma.
function renderBarraLoteMov() {
  const barra = document.getElementById("mov-barra-lote");
  const qtd = selecionadasMov.size;
  if (!qtd) {
    barra.classList.add("hidden");
    const todos = document.getElementById("mov-check-todos");
    if (todos) { todos.checked = false; todos.indeterminate = false; }
    return;
  }
  barra.classList.remove("hidden");
  document.getElementById("lote-contador").textContent =
    `${qtd} selecionada(s)` + (qtd < ultimaListaFiltradaMov.length ? ` de ${ultimaListaFiltradaMov.length} no filtro` : "");
}

document.getElementById("mov-check-todos").addEventListener("change", (e) => {
  const paginaIds = [...document.querySelectorAll("#movs-body [data-selecionar-mov]")].map((cb) => cb.dataset.selecionarMov);
  if (e.target.checked) paginaIds.forEach((id) => selecionadasMov.add(id));
  else paginaIds.forEach((id) => selecionadasMov.delete(id));
  renderMovimentacoes();
});

document.getElementById("btn-lote-selecionar-filtro").addEventListener("click", () => {
  ultimaListaFiltradaMov.forEach((m) => selecionadasMov.add(m.id));
  renderMovimentacoes();
});

document.getElementById("btn-lote-limpar").addEventListener("click", () => {
  selecionadasMov.clear();
  renderMovimentacoes();
});

// Aplica a mesma alteração em todas as selecionadas, em lotes de 400
// operações (o writeBatch do Firestore aceita no máximo 500).
async function aplicarEmLote(dados, descricao) {
  const ids = [...selecionadasMov];
  if (!ids.length) return;
  try {
    for (let i = 0; i < ids.length; i += 400) {
      const batch = writeBatch(db);
      ids.slice(i, i + 400).forEach((id) => batch.update(doc(db, "movimentacoes", id), dados));
      await batch.commit();
    }
    await addDoc(collection(db, "historico"), {
      nomeLancamento: `${ids.length} movimentação(ões)`, campo: "Edição em lote",
      valorAnterior: "—", valorNovo: descricao,
      tipoAlteracao: "Edição em lote", dataHora: serverTimestamp()
    });
    selecionadasMov.clear();
    mostrarToast(`${ids.length} movimentação(ões): ${descricao}.`);
    renderMovimentacoes();
  } catch (err) {
    mostrarToast("Não foi possível aplicar em lote: " + err.message, true);
  }
}

document.getElementById("btn-lote-revisadas").addEventListener("click", () => {
  aplicarEmLote({ revisado: true }, "marcadas como revisadas");
});
document.getElementById("btn-lote-pagas").addEventListener("click", () => {
  aplicarEmLote({ pago: true, revisado: true }, "marcadas como pagas e revisadas");
});
document.getElementById("btn-lote-pendentes").addEventListener("click", () => {
  aplicarEmLote({ pago: false }, "marcadas como pendentes");
});
document.getElementById("lote-lancamento").addEventListener("change", (e) => {
  const lancamentoId = e.target.value;
  if (!lancamentoId) return;
  const nome = (mapaLancamentos()[lancamentoId] || {}).nome || "lançamento";
  e.target.value = "";
  if (!confirm(`Aplicar o lançamento "${nome}" a ${selecionadasMov.size} movimentação(ões)?`)) return;
  aplicarEmLote({ lancamentoId, revisado: true }, `classificadas como "${nome}"`);
});

document.getElementById("btn-lote-excluir").addEventListener("click", async () => {
  const ids = [...selecionadasMov];
  if (!ids.length) return;
  if (!confirm(`Excluir ${ids.length} movimentação(ões)? Isso não pode ser desfeito (fica registrado no Histórico).`)) return;
  try {
    await addDoc(collection(db, "historico"), {
      nomeLancamento: `${ids.length} movimentação(ões)`, campo: "Movimentação",
      valorAnterior: `${ids.length} registro(s)`, valorNovo: "(excluídas em lote)",
      tipoAlteracao: "Exclusão em lote", dataHora: serverTimestamp()
    });
    for (let i = 0; i < ids.length; i += 400) {
      const batch = writeBatch(db);
      ids.slice(i, i + 400).forEach((id) => batch.delete(doc(db, "movimentacoes", id)));
      await batch.commit();
    }
    selecionadasMov.clear();
    mostrarToast(`${ids.length} movimentação(ões) excluída(s).`);
    renderMovimentacoes();
  } catch (err) {
    mostrarToast("Não foi possível excluir: " + err.message, true);
  }
});

/* ══════════════ REVISÃO: MODO UMA POR UMA ══════════════ */

// Fila de revisão da sessão atual. Guarda só os IDs: o conteúdo é sempre
// relido do STATE, que está em tempo real com o Firestore.
let filaRevisao = [];
let posicaoRevisao = 0;

function abrirModoRevisao() {
  filaRevisao = ultimaListaFiltradaMov.filter(precisaRevisao).map((m) => m.id);
  if (!filaRevisao.length) {
    // Se o filtro atual já está só com revisadas, revisa tudo que falta.
    filaRevisao = STATE.movimentacoes.filter(precisaRevisao).map((m) => m.id);
  }
  if (!filaRevisao.length) return mostrarToast("Nada a revisar — está tudo conferido!");
  posicaoRevisao = 0;
  preencherSelectsLancamento();
  document.getElementById("modal-revisao").classList.add("active");
  mostrarItemRevisao();
}

function fecharModoRevisao() {
  document.getElementById("modal-revisao").classList.remove("active");
}

function mostrarItemRevisao() {
  // Pula itens que já saíram da fila (revisados ou excluídos noutra aba).
  while (posicaoRevisao < filaRevisao.length) {
    const m = STATE.movimentacoes.find((x) => x.id === filaRevisao[posicaoRevisao]);
    if (m && precisaRevisao(m)) break;
    posicaoRevisao++;
  }
  if (posicaoRevisao >= filaRevisao.length) {
    fecharModoRevisao();
    mostrarToast("Revisão concluída! 🎉");
    return;
  }

  const m = STATE.movimentacoes.find((x) => x.id === filaRevisao[posicaoRevisao]);
  const l = mapaLancamentos()[m.lancamentoId] || {};
  document.getElementById("rev-progresso").textContent = `${posicaoRevisao + 1} de ${filaRevisao.length}`;
  document.getElementById("rev-progresso-fill").style.width = `${((posicaoRevisao) / filaRevisao.length) * 100}%`;
  document.getElementById("rev-valor").textContent = moeda(m.valor);
  document.getElementById("rev-valor").className = "rev-valor " + (l.tipo === "Entrada" ? "entrada" : "saida");
  document.getElementById("rev-data").textContent = dataBR(m.data);
  document.getElementById("rev-descricao").textContent =
    m.descricaoOrigem || m.descricaoCompra || l.nome || "(sem descrição)";
  const detalhes = [
    l.nome ? `Lançamento atual: ${l.nome}` : "Sem lançamento definido",
    l.categoria ? `Categoria: ${l.categoria}` : "",
    m.instituicao ? `Banco: ${m.instituicao}` : "",
    m.parcelaAtual ? `Parcela ${m.parcelaAtual}${m.parcelaTotal ? "/" + m.parcelaTotal : ""}` : ""
  ].filter(Boolean);
  document.getElementById("rev-detalhes").innerHTML = detalhes.map((d) => `<span>${esc(d)}</span>`).join("");

  definirComboLancamento("rev-lancamento", m.lancamentoId);
  document.getElementById("rev-pago").value = m.pago ? "true" : "false";
  document.getElementById("rev-data-edit").value = m.data || "";
  document.getElementById("rev-valor-edit").value = m.valor;
}

// Confirma o item atual: grava o que estiver nos campos, marca como revisado
// e já pula pro próximo — é o gesto que torna a revisão rápida.
async function confirmarItemRevisao() {
  const m = STATE.movimentacoes.find((x) => x.id === filaRevisao[posicaoRevisao]);
  if (!m) { posicaoRevisao++; return mostrarItemRevisao(); }

  const lancamentoId = document.getElementById("rev-lancamento").value || m.lancamentoId;
  const pago = document.getElementById("rev-pago").value === "true";
  const data = document.getElementById("rev-data-edit").value || m.data;
  const valor = Number(document.getElementById("rev-valor-edit").value) || Number(m.valor);

  if (!lancamentoId) return mostrarToast("Escolha um lançamento pra esta movimentação.", true);
  if (!valor || valor <= 0) return mostrarToast("Valor inválido.", true);

  try {
    await updateDoc(doc(db, "movimentacoes", m.id), { lancamentoId, pago, data, valor, revisado: true });
    // Mesma aprendizagem do modal de edição: se veio do banco e o lançamento
    // mudou, a próxima transação parecida já entra categorizada sozinha.
    if (m.origem === "Open Finance" && m.chaveCategorizador && m.lancamentoId !== lancamentoId) {
      await garantirRegraCategorizacao(m.chaveCategorizador, lancamentoId, m.descricaoOrigem);
    }
    posicaoRevisao++;
    mostrarItemRevisao();
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
}

document.getElementById("btn-rev-confirmar").addEventListener("click", confirmarItemRevisao);
document.getElementById("btn-rev-pular").addEventListener("click", () => { posicaoRevisao++; mostrarItemRevisao(); });
document.getElementById("btn-rev-voltar").addEventListener("click", () => {
  posicaoRevisao = Math.max(0, posicaoRevisao - 1);
  mostrarItemRevisao();
});
document.getElementById("btn-rev-fechar").addEventListener("click", fecharModoRevisao);
document.getElementById("btn-rev-excluir").addEventListener("click", async () => {
  const m = STATE.movimentacoes.find((x) => x.id === filaRevisao[posicaoRevisao]);
  if (!m) return;
  if (!confirm(`Excluir esta movimentação (${dataBR(m.data)} — ${moeda(m.valor)})?`)) return;
  try {
    await addDoc(collection(db, "historico"), {
      lancamentoId: m.lancamentoId || "", nomeLancamento: (mapaLancamentos()[m.lancamentoId] || {}).nome || "(excluído)",
      campo: "Movimentação", valorAnterior: `${dataBR(m.data)} — ${moeda(m.valor)}`, valorNovo: "(excluída na revisão)",
      tipoAlteracao: "Exclusão", dataHora: serverTimestamp()
    });
    await deleteDoc(doc(db, "movimentacoes", m.id));
    posicaoRevisao++;
    mostrarItemRevisao();
  } catch (err) {
    mostrarToast("Não foi possível excluir: " + err.message, true);
  }
});
document.getElementById("modal-revisao").addEventListener("click", (e) => {
  if (e.target.id === "modal-revisao") fecharModoRevisao();
});
// Atalhos de teclado: Enter confirma, seta pra direita pula, Esc fecha.
document.addEventListener("keydown", (e) => {
  if (!document.getElementById("modal-revisao").classList.contains("active")) return;
  if (e.key === "Escape") return fecharModoRevisao();
  if (e.key === "Enter" && e.target.tagName !== "BUTTON") { e.preventDefault(); confirmarItemRevisao(); }
  if (e.key === "ArrowRight" && !["INPUT", "SELECT"].includes(e.target.tagName)) { posicaoRevisao++; mostrarItemRevisao(); }
});

document.getElementById("btn-abrir-revisao").addEventListener("click", () => abrirModoRevisao());

const DASH_PAGE_SIZE = 20;

document.getElementById("mov-filtro-mes-de").addEventListener("change", (e) => {
  STATE.filtroMovMesDe = e.target.value;
  STATE.paginaMov = 1;
  renderMovimentacoes();
});
document.getElementById("mov-filtro-mes-ate").addEventListener("change", (e) => {
  STATE.filtroMovMesAte = e.target.value;
  STATE.paginaMov = 1;
  renderMovimentacoes();
});
document.getElementById("btn-mov-todos-meses").addEventListener("click", () => {
  STATE.filtroMovMesDe = "";
  STATE.filtroMovMesAte = "";
  document.getElementById("mov-filtro-mes-de").value = "";
  document.getElementById("mov-filtro-mes-ate").value = "";
  STATE.paginaMov = 1;
  renderMovimentacoes();
});

document.getElementById("mov-por-pagina").addEventListener("change", (e) => {
  STATE.movPorPagina = e.target.value === "todas" ? Infinity : Number(e.target.value);
  STATE.paginaMov = 1;
  renderMovimentacoes();
});

// Paginado (não só as últimas N) — assim dá pra navegar por todo o
// histórico direto do Dashboard, sem precisar ir na aba Movimentações.
// A lista já chega ordenada da mais recente pra mais antiga (Firestore
// devolve "movimentacoes" com orderBy("data","desc")).
function renderDashMovs(movs) {
  const totalPaginas = Math.max(1, Math.ceil(movs.length / DASH_PAGE_SIZE));
  if (STATE.dashPaginaAtual > totalPaginas) STATE.dashPaginaAtual = totalPaginas;
  if (STATE.dashPaginaAtual < 1) STATE.dashPaginaAtual = 1;
  const inicio = (STATE.dashPaginaAtual - 1) * DASH_PAGE_SIZE;
  const pagina = movs.slice(inicio, inicio + DASH_PAGE_SIZE);

  const body = document.getElementById("dash-movs-body");
  if (!movs.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">Nenhuma movimentação registrada ainda.</td></tr>';
  } else {
    body.innerHTML = pagina.map((m) => (
      `<tr><td>${dataBR(m.data)}</td><td>${esc(m.nomeLancamento)}${m.descricaoCompra ? `<span class="sublabel">${esc(m.descricaoCompra)}</span>` : ""}</td>` +
      `<td><span class="badge-tipo ${m.tipo}">${rotuloTipo(m.tipo)}</span></td>` +
      `<td class="num">${moeda(m.valor)}</td>` +
      `<td><span class="stamp ${m.pago ? "pago" : "pendente"}">${m.pago ? "PAGO" : "PENDENTE"}</span></td></tr>`
    )).join("");
  }

  const pgEl = document.getElementById("dash-paginacao");
  if (!movs.length) { pgEl.innerHTML = ""; return; }
  pgEl.innerHTML =
    `<button class="btn-small" id="dash-pg-anterior" ${STATE.dashPaginaAtual <= 1 ? "disabled" : ""}>‹ Anterior</button>` +
    `<span class="pg-info">Página ${STATE.dashPaginaAtual} de ${totalPaginas} · ${movs.length} no total</span>` +
    `<button class="btn-small" id="dash-pg-proxima" ${STATE.dashPaginaAtual >= totalPaginas ? "disabled" : ""}>Próxima ›</button>`;
  const btnAnterior = document.getElementById("dash-pg-anterior");
  const btnProxima = document.getElementById("dash-pg-proxima");
  if (btnAnterior) btnAnterior.addEventListener("click", () => { STATE.dashPaginaAtual--; renderDashMovs(movs); });
  if (btnProxima) btnProxima.addEventListener("click", () => { STATE.dashPaginaAtual++; renderDashMovs(movs); });
}

/* ══════════════ CONTAS A PAGAR ══════════════ */

function filtrarContasPorMes(lista) {
  if (!STATE.filtroCPMes) return lista;
  return lista.filter((m) => String(m.data || "").slice(0, 7) === STATE.filtroCPMes);
}

// Reaproveita a mesma coleção "movimentacoes" já usada em Movimentações e
// no Dashboard — "conta a pagar" aqui é toda movimentação de Saída (mês
// escolhido), separada só pelo campo "pago". Marcar como paga usa a mesma
// função alternarPagamento(), e clicar na linha abre o mesmo modal de
// edição de Movimentações — não existe cadastro paralelo pra manter.
function renderContasAPagar() {
  const mapaLanc = mapaLancamentos();
  const conexoesAtivas = conexoesAtivasParaPessoal();
  const saidas = STATE.movimentacoes
    .filter((m) => movimentacaoVisivel(m, conexoesAtivas))
    .map((m) => {
      const l = mapaLanc[m.lancamentoId] || {};
      return { ...m, nomeLancamento: l.nome || "(excluído)", tipo: l.tipo || "", categoria: l.categoria || "" };
    })
    .filter((m) => m.tipo === "Saida");

  const doMes = filtrarContasPorMes(saidas);
  const pendentes = doMes.filter((m) => !m.pago).sort((a, b) => (a.data < b.data ? -1 : 1));
  const pagas = doMes.filter((m) => m.pago).sort((a, b) => (a.data < b.data ? -1 : 1));

  const totalPendente = pendentes.reduce((s, m) => s + (Number(m.valor) || 0), 0);
  const totalPago = pagas.reduce((s, m) => s + (Number(m.valor) || 0), 0);
  const totalGeral = totalPendente + totalPago;

  document.getElementById("cp-kpi-grid").innerHTML =
    kpiCard("Falta pagar no mês", moeda(totalPendente) + ` <small>(${pendentes.length})</small>`, totalPendente === 0) +
    kpiCard("Já pago no mês", moeda(totalPago) + ` <small>(${pagas.length})</small>`, true) +
    kpiCard("Total de contas no mês", moeda(totalGeral), true);

  renderContasLista("cp-pendentes-body", pendentes, "Nenhuma conta a pagar neste mês.");
  renderContasLista("cp-pagas-body", pagas, "Nenhuma conta paga neste mês ainda.");
}

function renderContasLista(bodyId, lista, msgVazio) {
  const body = document.getElementById(bodyId);
  if (!lista.length) {
    body.innerHTML = `<tr><td colspan="5" class="empty">${msgVazio}</td></tr>`;
    return;
  }
  body.innerHTML = lista.map((m) => (
    `<tr class="linha-clicavel" data-abrir-mov="${m.id}"><td>${dataBR(m.data)}</td><td>${esc(m.nomeLancamento)}</td>` +
    `<td>${esc(m.categoria)}</td><td class="num">${moeda(m.valor)}</td>` +
    `<td><span class="stamp ${m.pago ? "pago" : "pendente"}" data-alternar-pagamento="${m.id}" data-novo-pago="${!m.pago}">${m.pago ? "PAGO" : "PENDENTE"}</span></td></tr>`
  )).join("");
  body.querySelectorAll("[data-abrir-mov]").forEach((tr) => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("[data-alternar-pagamento]")) return;
      abrirModalMovimentacao(tr.dataset.abrirMov);
    });
  });
  body.querySelectorAll("[data-alternar-pagamento]").forEach((stamp) => {
    stamp.addEventListener("click", (e) => {
      e.stopPropagation();
      alternarPagamento(stamp.dataset.alternarPagamento, stamp.dataset.novoPago === "true");
    });
  });
}

document.getElementById("cp-filtro-mes").addEventListener("change", (e) => {
  STATE.filtroCPMes = e.target.value;
  renderContasAPagar();
});
document.getElementById("btn-cp-mes-atual").addEventListener("click", () => {
  const hoje = new Date();
  const mesAtual = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
  STATE.filtroCPMes = mesAtual;
  document.getElementById("cp-filtro-mes").value = mesAtual;
  renderContasAPagar();
});

function renderCartaoKpis() {
  let totalLimite = 0, totalUtilizado = 0;
  STATE.cartoes.forEach((c) => {
    totalLimite += Number(c.limiteTotal) || 0;
    totalUtilizado += calcularLimiteUtilizado(c.id);
  });
  const totalDisponivel = totalLimite - totalUtilizado;
  const faturaMesAtual = calcularFaturaMesAtual();
  document.getElementById("cartao-kpi-grid").innerHTML =
    kpiCard("Total a pagar este mês (todos os cartões)", moeda(faturaMesAtual), faturaMesAtual === 0) +
    kpiCard("Limite total (todos os cartões)", moeda(totalLimite), true) +
    kpiCard("Soma de parcelas ativas (todos os meses)", moeda(totalUtilizado), totalUtilizado === 0) +
    kpiCard("Disponível (todos os cartões)", moeda(totalDisponivel), totalDisponivel >= 0);
}

function renderCartoes() {
  const body = document.getElementById("cartoes-body");
  if (!STATE.cartoes.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty">Nenhum cartão cadastrado ainda.</td></tr>';
  } else {
    body.innerHTML = STATE.cartoes.map((c) => {
      const utilizado = calcularLimiteUtilizado(c.id);
      const disponivel = (Number(c.limiteTotal) || 0) - utilizado;
      const faturaMes = calcularFaturaMesAtual(c.id);
      const ativo = c.ativo !== false;
      return (
        `<tr class="linha-clicavel" data-abrir-cartao="${c.id}"><td>${esc(c.nome)}</td><td class="num">${moeda(c.limiteTotal)}</td>` +
        `<td class="num">${moeda(utilizado)}</td><td class="num">${moeda(disponivel)}</td><td class="num">${moeda(faturaMes)}</td>` +
        `<td>dia ${c.diaFechamento}</td><td>dia ${c.diaVencimento}</td>` +
        `<td><span class="stamp ${ativo ? "ativo" : "inativo"}" data-alternar-cartao-ativo="${c.id}" data-novo-ativo="${!ativo}">${ativo ? "ATIVO" : "INATIVO"}</span></td></tr>`
      );
    }).join("");
    document.querySelectorAll("[data-abrir-cartao]").forEach((tr) => {
      tr.addEventListener("click", () => abrirModalEditarCartao(tr.dataset.abrirCartao));
    });
    document.querySelectorAll("[data-alternar-cartao-ativo]").forEach((stamp) => {
      stamp.addEventListener("click", (e) => {
        e.stopPropagation();
        alternarAtivoCartao(stamp.dataset.alternarCartaoAtivo, stamp.dataset.novoAtivo === "true");
      });
    });
  }
  preencherSelectCartoes();
  renderCartaoKpis();
}

async function alternarAtivoCartao(id, novoAtivo) {
  try {
    await updateDoc(doc(db, "cartoes", id), { ativo: novoAtivo });
  } catch (err) {
    mostrarToast("Não foi possível atualizar: " + err.message, true);
  }
}

function abrirModalEditarCartao(id) {
  const c = STATE.cartoes.find((x) => x.id === id);
  if (!c) return mostrarToast("Cartão não encontrado.", true);
  document.getElementById("edit-cartao-id").value = c.id;
  document.getElementById("edit-cartao-nome").value = c.nome;
  document.getElementById("edit-cartao-limite").value = c.limiteTotal;
  document.getElementById("edit-cartao-fechamento").value = c.diaFechamento;
  document.getElementById("edit-cartao-vencimento").value = c.diaVencimento;
  document.getElementById("edit-cartao-ativo").value = c.ativo !== false ? "true" : "false";
  document.getElementById("modal-editar-cartao").classList.add("active");
}
function fecharModalEditarCartao() {
  document.getElementById("modal-editar-cartao").classList.remove("active");
}
document.getElementById("btn-cancelar-edicao-cartao").addEventListener("click", fecharModalEditarCartao);
document.getElementById("modal-editar-cartao").addEventListener("click", (e) => {
  if (e.target.id === "modal-editar-cartao") fecharModalEditarCartao();
});

document.getElementById("btn-salvar-edicao-cartao").addEventListener("click", async () => {
  const id = document.getElementById("edit-cartao-id").value;
  const nome = document.getElementById("edit-cartao-nome").value.trim();
  const limiteTotal = Number(document.getElementById("edit-cartao-limite").value);
  const diaFechamento = Number(document.getElementById("edit-cartao-fechamento").value);
  const diaVencimento = Number(document.getElementById("edit-cartao-vencimento").value);
  const ativo = document.getElementById("edit-cartao-ativo").value === "true";
  if (!nome || !limiteTotal || !diaFechamento || !diaVencimento) return mostrarToast("Preencha todos os campos.", true);
  if (diaFechamento < 1 || diaFechamento > 31 || diaVencimento < 1 || diaVencimento > 31) {
    return mostrarToast("Dia de fechamento/vencimento inválido (1 a 31).", true);
  }
  try {
    await updateDoc(doc(db, "cartoes", id), { nome, limiteTotal, diaFechamento, diaVencimento, ativo });
    mostrarToast("Cartão atualizado!");
    fecharModalEditarCartao();
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
});

document.getElementById("btn-excluir-cartao").addEventListener("click", async () => {
  const id = document.getElementById("edit-cartao-id").value;
  if (!confirm("Excluir este cartão? Movimentações e compras já lançadas continuam existindo, só deixam de referenciar um cartão válido.")) return;
  try {
    await deleteDoc(doc(db, "cartoes", id));
    mostrarToast("Cartão excluído.");
    fecharModalEditarCartao();
  } catch (err) {
    mostrarToast("Não foi possível excluir: " + err.message, true);
  }
});

function preencherSelectCartoes() {
  const opcoesManuais = STATE.cartoes.map((c) => {
    const disponivel = (Number(c.limiteTotal) || 0) - calcularLimiteUtilizado(c.id);
    return `<option value="${c.id}">${esc(c.nome)} (disponível ${moeda(disponivel)})</option>`;
  }).join("");
  // Cartões via Open Finance também aparecem aqui — "disponível" vem direto
  // do banco (limiteDisponivel), não é calculado somando movimentações
  // como no cadastro manual.
  const opcoesOpenFinance = STATE.cartoesOpenFinance.map((c) => (
    `<option value="${c.id}">🏦 ${esc(c.instituicao)} — ${esc(c.nome)} (disponível ${moeda(c.limiteDisponivel)})</option>`
  )).join("");
  const opcoes = opcoesManuais + opcoesOpenFinance;
  ["compra-cartao", "edit-compra-cartao", "qa-compra-cartao"].forEach((id) => {
    const sel = document.getElementById(id);
    if (!STATE.cartoes.length && !STATE.cartoesOpenFinance.length) {
      sel.innerHTML = '<option value="">Cadastre um cartão primeiro</option>';
      return;
    }
    const valorAtual = sel.value;
    sel.innerHTML = opcoes;
    if (valorAtual) sel.value = valorAtual;
  });
}

// Lista "achatada" de todo gasto já lançado no cartão (cada parcela de cada
// compra), pra corrigir rapidinho um erro de valor/data/responsável sem
// precisar ir até Movimentações e procurar. Reaproveita o mesmo modal de
// edição de movimentação (com o mesmo registro em Histórico).
function renderParcelasCartao() {
  const body = document.getElementById("parcelas-cartao-body");
  if (!body) return;
  const mapaCompra = {};
  STATE.comprasParceladas.forEach((c) => (mapaCompra[c.id] = c));

  // Cartão manual: linkado por cartaoId. Cartão Open Finance real (já
  // sincronizado do banco): não tem cartaoId, é identificado por
  // contaTipo "cartao" + conexaoId. As duas formas aparecem juntas aqui,
  // pra dar visão completa do que está ocupando o limite de cada cartão.
  const parcelas = STATE.movimentacoes.filter((m) => m.cartaoId || (m.contaTipo === "cartao" && m.conexaoId));
  if (!parcelas.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">Nenhum gasto lançado no cartão ainda.</td></tr>';
    return;
  }
  const ordenadas = [...parcelas].sort((a, b) => (a.data < b.data ? 1 : -1));
  body.innerHTML = ordenadas.map((m) => {
    const compra = mapaCompra[m.compraParceladaId];
    const descricao = compra ? compra.descricao : (m.descricaoOrigem || "(compra excluída)");
    const cartaoNome = m.cartaoId
      ? ((buscarCartaoUnificado(m.cartaoId) || {}).nomeExibicao || "(excluído)")
      : `${m.instituicao || "Banco"} (Open Finance)`;
    return (
      `<tr class="linha-clicavel" data-abrir-mov="${m.id}"><td>${dataBR(m.data)}</td><td>${esc(descricao)}</td>` +
      `<td>${esc(cartaoNome)}</td><td class="num">${moeda(m.valor)}</td>` +
      `<td><span class="stamp ${m.pago ? "pago" : "pendente"}" data-alternar-pagamento="${m.id}" data-novo-pago="${!m.pago}">${m.pago ? "PAGO" : "PENDENTE"}</span></td></tr>`
    );
  }).join("");
  body.querySelectorAll("[data-abrir-mov]").forEach((tr) => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("[data-alternar-pagamento]")) return;
      abrirModalMovimentacao(tr.dataset.abrirMov);
    });
  });
  body.querySelectorAll("[data-alternar-pagamento]").forEach((stamp) => {
    stamp.addEventListener("click", (e) => {
      e.stopPropagation();
      alternarPagamento(stamp.dataset.alternarPagamento, stamp.dataset.novoPago === "true");
    });
  });
}

function renderComprasParceladas() {
  const body = document.getElementById("compras-body");
  if (!STATE.comprasParceladas.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">Nenhuma compra parcelada registrada ainda.</td></tr>';
    return;
  }
  // Data da compra manda (mais recente primeiro); no empate (mesma data),
  // desempata por ordem de cadastro (mais recém-lançada primeiro).
  const ordenadas = [...STATE.comprasParceladas].sort((a, b) => {
    if (a.dataCompra !== b.dataCompra) return a.dataCompra < b.dataCompra ? 1 : -1;
    return tsParaMillis(b.dataRegistro) - tsParaMillis(a.dataRegistro);
  });
  body.innerHTML = ordenadas.map((c) => {
    const numParcelas = Number(c.numParcelas) || 1;
    const valorTotal = Number(c.valorTotal) || 0;
    const valorParcela = arredondar2(valorTotal / numParcelas);
    return (
      `<tr class="linha-clicavel" data-abrir-compra="${c.id}"><td>${esc(c.descricao)}</td><td>${esc((buscarCartaoUnificado(c.cartaoId) || {}).nomeExibicao || "(excluído)")}</td>` +
      `<td class="num">${moeda(valorTotal)}</td><td>${numParcelas}x</td>` +
      `<td class="num">${moeda(valorParcela)}</td><td>${dataBR(c.dataCompra)}</td></tr>`
    );
  }).join("");
  document.querySelectorAll("[data-abrir-compra]").forEach((tr) => {
    tr.addEventListener("click", () => abrirModalEditarCompra(tr.dataset.abrirCompra));
  });
}

function abrirModalEditarCompra(id) {
  const c = STATE.comprasParceladas.find((x) => x.id === id);
  if (!c) return mostrarToast("Compra não encontrada.", true);
  preencherSelectsLancamento();
  preencherSelectCartoes();
  document.getElementById("edit-compra-id").value = c.id;
  document.getElementById("edit-compra-cartao").value = c.cartaoId;
  definirComboLancamento("edit-compra-lancamento", c.lancamentoId);
  document.getElementById("edit-compra-descricao").value = c.descricao;
  document.getElementById("edit-compra-valor").value = c.valorTotal;
  document.getElementById("edit-compra-parcelas").value = c.numParcelas;
  document.getElementById("edit-compra-data").value = c.dataCompra;

  const numParcelas = Number(c.numParcelas) || 1;
  const naoPagas = STATE.movimentacoes.filter((m) => m.compraParceladaId === id && m.pago !== true);
  const paidCount = numParcelas - naoPagas.length;
  const cartaoAtual = buscarCartaoUnificado(c.cartaoId);
  const ehCartaoOpenFinance = cartaoAtual && cartaoAtual.origemCartao === "openFinance";
  // Recalcular cronograma (dia de fechamento, limite) só existe pro
  // cadastro manual — cartão Open Finance trava esses campos sempre, não
  // só quando já paga tudo.
  const travar = !naoPagas.length || ehCartaoOpenFinance;
  ["edit-compra-cartao", "edit-compra-valor", "edit-compra-parcelas", "edit-compra-data"].forEach((elId) => {
    document.getElementById(elId).disabled = travar;
  });
  document.getElementById("edit-compra-info").textContent = ehCartaoOpenFinance
    ? "Cartão via Open Finance — cartão, valor, parcelas e data não são editáveis aqui (esses dados vêm do banco). Só descrição, lançamento e responsável podem ser alterados."
    : (travar
      ? "Todas as parcelas dessa compra já foram pagas — só descrição, lançamento e responsável ainda podem ser alterados."
      : `${paidCount} de ${numParcelas} parcela(s) já paga(s). Mudar cartão, valor, nº de parcelas ou data recalcula automaticamente só as ${naoPagas.length} parcela(s) ainda não paga(s) — as pagas não são tocadas.`);
  document.getElementById("modal-editar-compra").classList.add("active");
}
function fecharModalEditarCompra() {
  document.getElementById("modal-editar-compra").classList.remove("active");
}
document.getElementById("btn-cancelar-edicao-compra").addEventListener("click", fecharModalEditarCompra);
document.getElementById("modal-editar-compra").addEventListener("click", (e) => {
  if (e.target.id === "modal-editar-compra") fecharModalEditarCompra();
});

async function salvarEdicaoCompra(forcarRecalculo) {
  const id = document.getElementById("edit-compra-id").value;
  const cartaoId = document.getElementById("edit-compra-cartao").value;
  const lancamentoId = document.getElementById("edit-compra-lancamento").value;
  const descricao = document.getElementById("edit-compra-descricao").value.trim();
  const valorTotal = Number(document.getElementById("edit-compra-valor").value);
  const numParcelas = Number(document.getElementById("edit-compra-parcelas").value);
  const dataCompra = document.getElementById("edit-compra-data").value;

  if (!descricao) return mostrarToast("A descrição não pode ficar em branco.", true);
  if (!lancamentoId) return mostrarToast("Selecione um lançamento.", true);
  if (!cartaoId) return mostrarToast("Selecione um cartão.", true);
  if (!valorTotal || valorTotal <= 0) return mostrarToast("Informe um valor total válido.", true);
  if (!numParcelas || numParcelas < 1 || numParcelas > 60) return mostrarToast("Número de parcelas inválido (1 a 60).", true);
  if (!dataCompra) return mostrarToast("Informe a data da compra.", true);

  const atual = STATE.comprasParceladas.find((x) => x.id === id);
  if (!atual) return mostrarToast("Compra não encontrada.", true);
  const cartao = buscarCartaoUnificado(cartaoId);
  if (!cartao) return mostrarToast("Cartão não encontrado.", true);
  if (cartao.origemCartao === "openFinance") {
    if (forcarRecalculo) return mostrarToast("Cartão via Open Finance não tem cronograma pra recalcular — quem controla isso é o próprio banco.", true);
    // Cartão/valor/parcelas/data ficam desabilitados na tela pra esse caso,
    // então só descrição/lançamento mudam — segue direto pro
    // caminho "não afeta cronograma" mais abaixo.
  }

  const parcelas = STATE.movimentacoes.filter((m) => m.compraParceladaId === id);
  const pagas = [...parcelas.filter((m) => m.pago === true)].sort((a, b) => (a.data < b.data ? -1 : 1));
  const naoPagas = [...parcelas.filter((m) => m.pago !== true)].sort((a, b) => (a.data < b.data ? -1 : 1));
  const paidCount = pagas.length;
  const somaPagas = arredondar2(pagas.reduce((s, m) => s + (Number(m.valor) || 0), 0));

  const valorTotalAtual = arredondar2(Number(atual.valorTotal) || 0);
  const numParcelasAtual = Number(atual.numParcelas) || 1;
  const afetaCronograma =
    forcarRecalculo ||
    cartaoId !== atual.cartaoId ||
    dataCompra !== atual.dataCompra ||
    numParcelas !== numParcelasAtual ||
    arredondar2(valorTotal) !== valorTotalAtual;

  if (afetaCronograma) {
    if (!naoPagas.length) {
      return mostrarToast(
        forcarRecalculo
          ? "Todas as parcelas dessa compra já foram pagas — não há mais nada pra recalcular."
          : "Todas as parcelas já foram pagas — cartão, valor, parcelas e data não podem mais ser ajustados.",
        true
      );
    }
    if (numParcelas < paidCount) {
      return mostrarToast(`Já foram pagas ${paidCount} parcela(s) — o número de parcelas não pode ser menor que isso.`, true);
    }
    if (arredondar2(valorTotal - somaPagas) < 0) {
      return mostrarToast(`O valor total não pode ser menor que o já pago (${moeda(somaPagas)}).`, true);
    }
  }

  const alteracoes = [];
  if (atual.descricao !== descricao) alteracoes.push({ campo: "Descrição", antes: atual.descricao, depois: descricao });
  if (arredondar2(valorTotal) !== valorTotalAtual) alteracoes.push({ campo: "Valor total", antes: moeda(valorTotalAtual), depois: moeda(valorTotal) });
  if (numParcelas !== numParcelasAtual) alteracoes.push({ campo: "Nº de parcelas", antes: String(numParcelasAtual), depois: String(numParcelas) });
  if (atual.dataCompra !== dataCompra) alteracoes.push({ campo: "Data da compra", antes: dataBR(atual.dataCompra), depois: dataBR(dataCompra) });
  const mapaLanc = mapaLancamentos();
  const mapaCartao = {};
  STATE.cartoes.forEach((c) => (mapaCartao[c.id] = c));
  if (atual.cartaoId !== cartaoId) {
    alteracoes.push({ campo: "Cartão", antes: (mapaCartao[atual.cartaoId] || {}).nome || "(excluído)", depois: cartao.nome });
  }
  if (atual.lancamentoId !== lancamentoId) {
    alteracoes.push({ campo: "Lançamento", antes: (mapaLanc[atual.lancamentoId] || {}).nome || "(excluído)", depois: (mapaLanc[lancamentoId] || {}).nome || "(excluído)" });
  }

  if (!alteracoes.length && !forcarRecalculo) {
    mostrarToast("Nenhuma alteração encontrada — os dados já eram esses.");
    fecharModalEditarCompra();
    return;
  }
  if (!alteracoes.length && forcarRecalculo) {
    alteracoes.push({ campo: "Parcelas", antes: "—", depois: "Recalculadas manualmente com os dados atuais" });
  }

  // Se algo que afeta o cronograma mudou (cartão, valor, nº de parcelas ou
  // data), checa se o novo valor restante cabe no limite do cartão de
  // destino — descontando as parcelas não pagas desta própria compra, que
  // serão substituídas (senão o limite delas contaria em dobro).
  if (afetaCronograma) {
    const valorRestante = arredondar2(valorTotal - somaPagas);
    const naoPagasNoCartaoDestino = naoPagas
      .filter((m) => String(m.cartaoId) === String(cartaoId))
      .reduce((s, m) => s + (Number(m.valor) || 0), 0);
    const limiteDisponivel = (Number(cartao.limiteTotal) || 0) - (calcularLimiteUtilizado(cartaoId) - naoPagasNoCartaoDestino);
    if (valorRestante > limiteDisponivel) {
      return mostrarToast("Limite insuficiente nesse cartão. Disponível: " + moeda(limiteDisponivel), true);
    }
  }

  try {
    const batch = writeBatch(db);
    batch.update(doc(db, "comprasParceladas", id), { cartaoId, lancamentoId, descricao, valorTotal, numParcelas, dataCompra });

    if (afetaCronograma) {
      // Apaga só as parcelas ainda não pagas e recria a partir da posição
      // seguinte à última já paga, usando a mesma regra de fechamento da
      // criação (calcularCicloInicial + calcularProximoVencimento).
      naoPagas.forEach((m) => batch.delete(doc(db, "movimentacoes", m.id)));

      const parcelasRestantes = numParcelas - paidCount;
      const valorRestante = arredondar2(valorTotal - somaPagas);
      const valorPorParcela = arredondar2(valorRestante / parcelasRestantes);
      const ciclo = calcularCicloInicial(dataCompra, Number(cartao.diaFechamento));

      for (let i = paidCount; i < numParcelas; i++) {
        const mesRef = new Date(ciclo.ano, ciclo.mes + i, 1);
        const vencimento = calcularProximoVencimento(cartao.diaVencimento, mesRef);
        const idxRestante = i - paidCount;
        const valorDaParcela = idxRestante === parcelasRestantes - 1
          ? arredondar2(valorRestante - valorPorParcela * (parcelasRestantes - 1))
          : valorPorParcela;
        const movRef = doc(collection(db, "movimentacoes"));
        batch.set(movRef, {
          lancamentoId, data: vencimento, valor: valorDaParcela, pago: false,
          origem: `Cartao ${i + 1}/${numParcelas}`, cartaoId, compraParceladaId: id, revisado: true, createdAt: serverTimestamp()
        });
      }
      // Parcelas já pagas continuam com data/valor intactos (viraram
      // histórico) — só atualiza o rótulo "i/numParcelas", já que o total
      // de parcelas pode ter mudado.
      pagas.forEach((m, idx) => {
        batch.update(doc(db, "movimentacoes", m.id), { origem: `Cartao ${idx + 1}/${numParcelas}` });
      });
    }

    const nomeLanc = (mapaLanc[lancamentoId] || {}).nome || "(excluído)";
    alteracoes.forEach((a) => {
      const histRef = doc(collection(db, "historico"));
      batch.set(histRef, {
        lancamentoId, nomeLancamento: `${nomeLanc} (compra: ${descricao})`, campo: a.campo,
        valorAnterior: String(a.antes), valorNovo: String(a.depois),
        tipoAlteracao: "Edição de compra no cartão", dataHora: serverTimestamp()
      });
    });

    await batch.commit();
    mostrarToast(
      forcarRecalculo
        ? "Parcelas recalculadas com os dados atuais."
        : `Compra atualizada (${alteracoes.length} campo(s) alterado(s))${afetaCronograma ? " — parcelas recalculadas" : ""}.`
    );
    fecharModalEditarCompra();
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
}

document.getElementById("btn-salvar-edicao-compra").addEventListener("click", () => salvarEdicaoCompra(false));
document.getElementById("btn-recalcular-compra").addEventListener("click", () => {
  if (!confirm("Recalcular as parcelas ainda não pagas desta compra com os dados atuais? Útil se elas foram criadas antes de algum ajuste na regra do sistema.")) return;
  salvarEdicaoCompra(true);
});

document.getElementById("btn-excluir-compra").addEventListener("click", async () => {
  const id = document.getElementById("edit-compra-id").value;
  if (!confirm("Excluir esta compra? As parcelas ainda não pagas serão removidas de Movimentações. Parcelas já pagas continuam registradas.")) return;
  try {
    const parcelasNaoPagas = STATE.movimentacoes.filter((m) => m.compraParceladaId === id && m.pago !== true);
    for (const p of parcelasNaoPagas) {
      await deleteDoc(doc(db, "movimentacoes", p.id));
    }
    await deleteDoc(doc(db, "comprasParceladas", id));
    mostrarToast(`Compra excluída (${parcelasNaoPagas.length} parcela(s) pendente(s) removida(s)).`);
    fecharModalEditarCompra();
  } catch (err) {
    mostrarToast("Não foi possível excluir: " + err.message, true);
  }
});

function renderRecKpis() {
  const ativos = STATE.recorrentes.filter((r) => r.ativo === true);
  const inativos = STATE.recorrentes.filter((r) => r.ativo !== true);
  const totalMensalAtivos = ativos.reduce((s, r) => s + (Number(r.valor) || 0), 0);
  document.getElementById("rec-kpi-grid").innerHTML =
    kpiCard("Recorrentes ativos", String(ativos.length), true) +
    kpiCard("Recorrentes inativos", String(inativos.length), inativos.length === 0) +
    kpiCard("Total mensal (ativos)", moeda(totalMensalAtivos), true);
}

function renderRecorrentes() {
  const mapaLanc = mapaLancamentos();
  const body = document.getElementById("recs-body");
  if (!STATE.recorrentes.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">Nenhum custo recorrente cadastrado ainda.</td></tr>';
  } else {
    body.innerHTML = STATE.recorrentes.map((r) => {
      const nomeLanc = (mapaLanc[r.lancamentoId] || {}).nome || "(excluído)";
      const prox = calcularProximoVencimento(r.diaVencimento);
      return (
        `<tr class="linha-clicavel" data-abrir-recorrente="${r.id}"><td>${esc(nomeLanc)}</td><td class="num">${moeda(r.valor)}</td><td>${r.diaVencimento}</td>` +
        `<td>${dataBR(prox)}</td><td><span class="stamp ${r.ativo ? "ativo" : "inativo"}" data-alternar-ativo="${r.id}" data-novo-ativo="${!r.ativo}">${r.ativo ? "ATIVO" : "INATIVO"}</span></td></tr>`
      );
    }).join("");
    document.querySelectorAll("[data-abrir-recorrente]").forEach((tr) => {
      tr.addEventListener("click", () => abrirModalEditarRecorrente(tr.dataset.abrirRecorrente));
    });
    document.querySelectorAll("[data-alternar-ativo]").forEach((stamp) => {
      stamp.addEventListener("click", (e) => {
        e.stopPropagation();
        alternarAtivoRecorrente(stamp.dataset.alternarAtivo, stamp.dataset.novoAtivo === "true");
      });
    });
  }
  renderRecKpis();
}

function abrirModalEditarRecorrente(id) {
  const r = STATE.recorrentes.find((x) => x.id === id);
  if (!r) return mostrarToast("Custo recorrente não encontrado.", true);
  preencherSelectsLancamento();
  document.getElementById("edit-rec-id").value = r.id;
  definirComboLancamento("edit-rec-lancamento", r.lancamentoId);
  document.getElementById("edit-rec-valor").value = r.valor;
  document.getElementById("edit-rec-inicio").value = r.dataInicio;
  document.getElementById("edit-rec-dia").value = r.diaVencimento;
  document.getElementById("edit-rec-ativo").value = r.ativo ? "true" : "false";
  document.getElementById("modal-editar-recorrente").classList.add("active");
}
function fecharModalEditarRecorrente() {
  document.getElementById("modal-editar-recorrente").classList.remove("active");
}
document.getElementById("btn-cancelar-edicao-rec").addEventListener("click", fecharModalEditarRecorrente);
document.getElementById("modal-editar-recorrente").addEventListener("click", (e) => {
  if (e.target.id === "modal-editar-recorrente") fecharModalEditarRecorrente();
});

document.getElementById("btn-salvar-edicao-rec").addEventListener("click", async () => {
  const id = document.getElementById("edit-rec-id").value;
  const lancamentoId = document.getElementById("edit-rec-lancamento").value;
  const valor = Number(document.getElementById("edit-rec-valor").value);
  const dataInicio = document.getElementById("edit-rec-inicio").value;
  const diaVencimento = Number(document.getElementById("edit-rec-dia").value);
  const ativo = document.getElementById("edit-rec-ativo").value === "true";
  if (!lancamentoId) return mostrarToast("Selecione um lançamento.", true);
  if (!valor || !dataInicio || !diaVencimento) return mostrarToast("Preencha valor, data de início e dia de vencimento.", true);
  try {
    await updateDoc(doc(db, "recorrentes", id), { lancamentoId, valor, dataInicio, diaVencimento, ativo });
    mostrarToast("Custo recorrente atualizado!");
    fecharModalEditarRecorrente();
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
});

document.getElementById("btn-excluir-recorrente").addEventListener("click", async () => {
  const id = document.getElementById("edit-rec-id").value;
  if (!confirm("Excluir este custo recorrente? Movimentações já lançadas por ele não são afetadas.")) return;
  try {
    await deleteDoc(doc(db, "recorrentes", id));
    mostrarToast("Custo recorrente excluído.");
    fecharModalEditarRecorrente();
  } catch (err) {
    mostrarToast("Não foi possível excluir: " + err.message, true);
  }
});

function renderHistorico() {
  const body = document.getElementById("historico-body");
  if (!STATE.historico.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">Nenhuma alteração registrada ainda.</td></tr>';
    return;
  }
  const ordenado = [...STATE.historico].sort((a, b) => tsParaMillis(b.dataHora) - tsParaMillis(a.dataHora));
  body.innerHTML = ordenado.map((h) => (
    `<tr><td>${fmtDataHora(h.dataHora)}</td><td>${esc(h.nomeLancamento || "")}</td>` +
    `<td><span class="campo-alterado">${esc(h.campo)}</span></td>` +
    `<td>${esc(h.valorAnterior)}</td><td>${esc(h.valorNovo)}</td><td>${esc(h.tipoAlteracao)}</td></tr>`
  )).join("");
}

function kpiCard(label, value, positivo, opts) {
  const o = opts || {};
  const classes = ["kpi-card", positivo ? "positive" : "negative"];
  if (o.destaque) classes.push("destaque");
  return (
    `<div class="${classes.join(" ")}">` +
    `<div class="label">${label}</div>` +
    `<div class="value num">${value}</div>` +
    (o.sub ? `<div class="sub">${o.sub}</div>` : "") +
    `</div>`
  );
}

// Indicadores adicionais do Dashboard, sempre relativos a HOJE (não ao mês
// escolhido no filtro "Mês" acima) — saldo previsto olhando pendências, %
// da renda já gasta no mês corrente, quanto já podia ter gasto até hoje e o
// total de parcelas de cartão ainda em aberto (qualquer mês). Cálculo
// independente do "Saldo atual" (que fica só no mês escolhido).
function calcularIndicadoresGeraisDash() {
  const mapaLanc = mapaLancamentos();
  const rendaMensal = Number(STATE.config.rendaMensal) || 0;
  const saldoInicial = Number(STATE.config.saldoInicial) || 0;

  const hoje = new Date();
  const anoMes = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;

  let saldoAtual = saldoInicial;
  let saidasNaoPagas = 0;
  let entradasNaoPagas = 0;
  let saidasPagasMes = 0;
  let parcelasCartaoFuturas = 0;

  const conexoesAtivas = conexoesAtivasParaPessoal();
  STATE.movimentacoes.forEach((m) => {
    if (!movimentacaoVisivel(m, conexoesAtivas)) return;
    const l = mapaLanc[m.lancamentoId] || {};
    const valor = Number(m.valor) || 0;
    const ehSaida = l.tipo === "Saida";
    const dataAnoMes = String(m.data || "").slice(0, 7);
    const ehCartao = m.contaTipo === "cartao" || !!m.cartaoId;
    const ehTransferencia = l.tipo === "Transferencia";

    if (m.pago === true) {
      // Transferência entre contas é neutra: não soma nem subtrai do saldo.
      if (!ehCartao && !ehTransferencia) saldoAtual += ehSaida ? -valor : valor;
      if (!ehTransferencia && ehSaida && dataAnoMes === anoMes) saidasPagasMes += valor;
    } else {
      if (!ehTransferencia) {
        if (ehSaida) saidasNaoPagas += valor;
        else entradasNaoPagas += valor;
      }
      if (m.cartaoId) parcelasCartaoFuturas += valor;
    }
  });

  STATE.dinheiroExtra.forEach((e) => {
    const v = Number(e.valor) || 0;
    if (e.recebido === true) saldoAtual += v; else entradasNaoPagas += v;
  });

  const saldoPrevisto = saldoAtual - saidasNaoPagas + entradasNaoPagas;
  const diaAtual = hoje.getDate();
  const ultimoDiaMes = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getDate();
  const percentualRendaGasta = rendaMensal > 0 ? (saidasPagasMes / rendaMensal) * 100 : 0;
  // Mesma ideia do "gasto por dia": o orçamento que dá pra gastar no mês é a
  // renda MENOS o quanto você quer guardar — só esse valor é rateado pelos
  // dias do mês pra saber o quanto já podia ter sido gasto até hoje.
  const metaGuardarMes = Number(STATE.config.metaGuardarMes) || 0;
  const orcamentoDisponivelMes = rendaMensal - metaGuardarMes;
  const gastoPermitidoAteHoje = rendaMensal > 0 ? (orcamentoDisponivelMes / ultimoDiaMes) * diaAtual : 0;
  // Folga real: o que você já podia ter gasto até hoje menos o que já gastou
  // de fato. Negativo = já passou do ritmo (risco de faltar dinheiro pra
  // guardar a meta ou pra fechar o mês).
  const folgaAteHoje = gastoPermitidoAteHoje - saidasPagasMes;

  return { saldoPrevisto, percentualRendaGasta, gastoPermitidoAteHoje, folgaAteHoje, saidasPagasMes, metaGuardarMes, parcelasCartaoFuturas };
}

/* ══════════════ DASHBOARD: PAINEL DE PERÍODO (filtros + gráficos + transações) ══════════════
 *
 * Seção adicional abaixo da já existente — trabalha com um intervalo de
 * datas livre (De/Até) em vez do filtro "Mês" acima, e nunca conta
 * movimentação de cartão nem transferência entre contas.
 */

const CORES_CATEGORICAS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
const COR_OUTRAS = "#9AA7BD";

// Movimentações "normais" (sem cartão, sem transferência) dentro de um
// intervalo de datas — base compartilhada pelos KPIs de período e pelo
// gráfico de categorias.
function movimentacoesNoPeriodo(de, ate) {
  const mapaLanc = mapaLancamentos();
  const conexoesAtivas = conexoesAtivasParaPessoal();
  return STATE.movimentacoes
    .filter((m) => movimentacaoVisivel(m, conexoesAtivas))
    .map((m) => {
      const l = mapaLanc[m.lancamentoId] || {};
      const nomeLancamento = l.nome || "(excluído)";
      const usaDescricaoComoTitulo = m.origem === "Open Finance" && !!m.descricaoOrigem && nomeLancamento === "Importado do banco";
      return {
        ...m, tipo: l.tipo || "", categoria: l.categoria || "", nomeLancamento,
        tituloLista: usaDescricaoComoTitulo ? m.descricaoOrigem : nomeLancamento
      };
    })
    .filter((m) => !ehMovimentacaoDeCartao(m))
    .filter((m) => m.tipo !== "Transferencia")
    .filter((m) => (!de || m.data >= de) && (!ate || m.data <= ate));
}

// Filtros de Tipo e Banco (dropdowns) recalculam de verdade os gráficos e
// KPIs — Categoria (dropdown OU clique numa fatia) só filtra a LISTA de
// transações embaixo, sem remodelar a rosca.
function movimentacoesFiltradasDash() {
  const base = movimentacoesNoPeriodo(STATE.filtroDashDe, STATE.filtroDashAte);
  return base
    .filter((m) => !STATE.filtroDashTipo || m.tipo === STATE.filtroDashTipo)
    .filter((m) => !STATE.filtroDashBanco || (m.instituicao || "") === STATE.filtroDashBanco);
}

function transacoesListaDash(listaFiltrada) {
  if (!STATE.filtroDashCategoria) return listaFiltrada;
  if (STATE.filtroDashCategoria === "Outras" && STATE.filtroDashCategoriasOutras) {
    return listaFiltrada.filter((m) => STATE.filtroDashCategoriasOutras.includes(m.categoria));
  }
  return listaFiltrada.filter((m) => m.categoria === STATE.filtroDashCategoria);
}

// Opções dos dropdowns vêm sempre do período inteiro (sem aplicar tipo,
// banco ou categoria) — assim a lista de opções não encolhe conforme você
// vai filtrando.
function preencherFiltrosPeriodoDash(listaPeriodo) {
  const bancos = new Set();
  const categorias = new Set();
  listaPeriodo.forEach((m) => {
    if (m.instituicao) bancos.add(m.instituicao);
    if (m.categoria) categorias.add(m.categoria);
  });
  const selBanco = document.getElementById("dash-filtro-banco");
  selBanco.innerHTML = '<option value="">Todos os bancos</option>' +
    [...bancos].sort((a, b) => a.localeCompare(b, "pt-BR")).map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
  selBanco.value = STATE.filtroDashBanco;

  const selCategoria = document.getElementById("dash-filtro-categoria");
  selCategoria.innerHTML = '<option value="">Todas as categorias</option>' +
    [...categorias].sort((a, b) => a.localeCompare(b, "pt-BR")).map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
  // "Outras" não é uma opção real do dropdown (é um agrupado só do
  // gráfico) — nesse caso o dropdown fica em branco, mesmo com a rosca
  // destacando a fatia.
  selCategoria.value = STATE.filtroDashCategoriasOutras ? "" : STATE.filtroDashCategoria;
}

function renderDashPeriodoKpis(lista) {
  let entrada = 0, saida = 0;
  lista.forEach((m) => {
    if (m.pago !== true) return;
    const valor = Number(m.valor) || 0;
    if (m.tipo === "Entrada") entrada += valor;
    else if (m.tipo === "Saida") saida += valor;
  });
  document.getElementById("dash-periodo-kpi-grid").innerHTML =
    kpiCard("Entrada no período", moeda(entrada), true) +
    kpiCard("Saída no período", moeda(saida), true);
}

// "tipo" é "Saida" (gastos) ou "Entrada" (entradas) — cartão e
// transferência já saem de "lista" lá na origem (movimentacoesNoPeriodo).
function agruparPorCategoria(lista, tipo) {
  const mapa = {};
  lista.forEach((m) => {
    if (m.pago !== true || m.tipo !== tipo) return;
    const cat = m.categoria || "Sem categoria";
    mapa[cat] = (mapa[cat] || 0) + (Number(m.valor) || 0);
  });
  return Object.entries(mapa)
    .map(([categoria, valor]) => ({ categoria, valor }))
    .sort((a, b) => b.valor - a.valor);
}

// Tooltip único, reaproveitado pelos gráficos novos — cria a div uma vez e
// só reposiciona/reescreve o conteúdo a cada hover.
function mostrarTooltipViz(evt, texto) {
  let tt = document.getElementById("viz-tooltip");
  if (!tt) {
    tt = document.createElement("div");
    tt.id = "viz-tooltip";
    tt.className = "viz-tooltip";
    document.body.appendChild(tt);
  }
  tt.textContent = texto;
  tt.style.left = evt.clientX + 14 + "px";
  tt.style.top = evt.clientY + 14 + "px";
  tt.classList.add("active");
}
function esconderTooltipViz() {
  const tt = document.getElementById("viz-tooltip");
  if (tt) tt.classList.remove("active");
}

function arcoDonut(cx, cy, rOuter, rInner, a1, a2) {
  const large = (a2 - a1) > Math.PI ? 1 : 0;
  const x1 = cx + rOuter * Math.cos(a1), y1 = cy + rOuter * Math.sin(a1);
  const x2 = cx + rOuter * Math.cos(a2), y2 = cy + rOuter * Math.sin(a2);
  const x3 = cx + rInner * Math.cos(a2), y3 = cy + rInner * Math.sin(a2);
  const x4 = cx + rInner * Math.cos(a1), y4 = cy + rInner * Math.sin(a1);
  return `M ${x1} ${y1} A ${rOuter} ${rOuter} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${rInner} ${rInner} 0 ${large} 0 ${x4} ${y4} Z`;
}

// Clicar numa fatia (ou na legenda) seleciona aquela categoria — estilo BI:
// a fatia clicada fica em destaque total, as outras ficam opacas, e a
// lista de transações embaixo filtra só pra ela. Clicar de novo (ou em
// "Limpar seleção") desfaz. "Outras" é um agrupado de várias categorias
// pequenas — clicar nela filtra a lista por todas elas juntas.
function alternarSelecaoCategoriaDash(categoria, categoriasReais) {
  if (STATE.filtroDashCategoria === categoria) {
    STATE.filtroDashCategoria = "";
    STATE.filtroDashCategoriasOutras = null;
  } else {
    STATE.filtroDashCategoria = categoria;
    STATE.filtroDashCategoriasOutras = categoriasReais || null;
  }
  STATE.paginaDashTransacoes = 1;
  renderPainelPeriodoDash();
}

// Rosca interativa reaproveitável (categoria "Gastos" e "Entradas" do
// painel de período) — não confundir com svgRosca(), que é a rosca simples
// e não-interativa do card "Gastos por categoria" já existente acima.
function renderGraficoCategoriasPeriodo(elId, grupos, rotuloTotal, mensagemVazia) {
  const el = document.getElementById(elId);
  const LIMITE = 8;
  const principais = grupos.slice(0, LIMITE);
  const resto = grupos.slice(LIMITE);
  const categoriasOutras = resto.map((g) => g.categoria);
  const grupoFinal = resto.length
    ? [...principais, { categoria: "Outras", valor: resto.reduce((s, g) => s + g.valor, 0) }]
    : principais;
  const total = grupoFinal.reduce((s, g) => s + g.valor, 0);

  if (!grupoFinal.length || total <= 0) {
    el.innerHTML = `<div class="empty">${esc(mensagemVazia)}</div>`;
    return;
  }

  const selecaoAtiva = !!STATE.filtroDashCategoria;
  const cx = 110, cy = 110, rOuter = 95, rInner = 58;
  const gap = grupoFinal.length > 1 ? 0.02 : 0;
  let anguloIni = -Math.PI / 2;
  let pathsHtml = "";
  let legendaHtml = "";
  grupoFinal.forEach((g, i) => {
    const fracao = g.valor / total;
    const anguloFim = anguloIni + fracao * Math.PI * 2;
    const cor = g.categoria === "Outras" ? COR_OUTRAS : CORES_CATEGORICAS[i % CORES_CATEGORICAS.length];
    const a1 = anguloIni + gap / 2, a2 = anguloFim - gap / 2;
    const selecionada = STATE.filtroDashCategoria === g.categoria;
    const classeEstado = selecionada ? " selecionada" : (selecaoAtiva ? " dimmed" : "");
    if (a2 > a1) {
      pathsHtml += `<path d="${arcoDonut(cx, cy, rOuter, rInner, a1, a2)}" fill="${cor}" class="fatia-donut${classeEstado}" data-categoria="${esc(g.categoria)}" data-tip="${esc(g.categoria)}: ${esc(moeda(g.valor))} (${(fracao * 100).toFixed(1)}%)"></path>`;
    }
    legendaHtml += (
      `<div class="legenda-item${classeEstado}" data-categoria="${esc(g.categoria)}">` +
      `<span class="legenda-swatch" style="background:${cor}"></span>` +
      `<span class="legenda-nome">${esc(g.categoria)}</span>` +
      `<span class="legenda-valor">${moeda(g.valor)} <small>(${(fracao * 100).toFixed(1)}%)</small></span></div>`
    );
    anguloIni = anguloFim;
  });

  el.innerHTML =
    `<div class="donut-wrap">` +
    `<svg viewBox="0 0 220 220" class="donut-svg">${pathsHtml}` +
    `<text x="110" y="103" text-anchor="middle" class="donut-total-label">${esc(rotuloTotal)}</text>` +
    `<text x="110" y="127" text-anchor="middle" class="donut-total-valor">${esc(moeda(total))}</text>` +
    `</svg>` +
    `<div class="donut-legenda">${legendaHtml}</div>` +
    `</div>`;

  const aoClicar = (categoria) => alternarSelecaoCategoriaDash(categoria, categoria === "Outras" ? categoriasOutras : null);
  el.querySelectorAll(".fatia-donut").forEach((path) => {
    path.addEventListener("mousemove", (e) => mostrarTooltipViz(e, path.dataset.tip));
    path.addEventListener("mouseleave", esconderTooltipViz);
    path.addEventListener("click", () => aoClicar(path.dataset.categoria));
  });
  el.querySelectorAll(".legenda-item").forEach((item) => {
    item.addEventListener("click", () => aoClicar(item.dataset.categoria));
  });
}

const PAGINA_DASH_TAMANHO = 10;

function renderTransacoesDash(lista) {
  const totalPaginas = Math.max(1, Math.ceil(lista.length / PAGINA_DASH_TAMANHO));
  STATE.paginaDashTransacoes = Math.min(Math.max(1, STATE.paginaDashTransacoes), totalPaginas);
  const inicio = (STATE.paginaDashTransacoes - 1) * PAGINA_DASH_TAMANHO;
  const pagina = lista.slice(inicio, inicio + PAGINA_DASH_TAMANHO);

  const body = document.getElementById("dash-transacoes-body");
  body.innerHTML = pagina.length
    ? pagina.map((m) => (
        `<tr><td>${dataBR(m.data)}</td><td>${esc(m.tituloLista)}</td>` +
        `<td>${esc(m.instituicao || "—")}</td>` +
        `<td><span class="badge-tipo ${m.tipo}">${rotuloTipo(m.tipo)}</span></td>` +
        `<td>${esc(m.categoria)}</td><td class="num">${moeda(m.valor)}</td>` +
        `<td><span class="stamp ${m.pago ? "pago" : "pendente"}">${m.pago ? "PAGO" : "PENDENTE"}</span></td></tr>`
      )).join("")
    : '<tr><td colspan="7" class="empty">Nenhuma transação com esse filtro.</td></tr>';

  const paginacao = document.getElementById("dash-transacoes-paginacao");
  paginacao.innerHTML = lista.length ? (
    `<button class="btn btn-small" id="btn-dash-pag-anterior" ${STATE.paginaDashTransacoes <= 1 ? "disabled" : ""}>‹ Anterior</button>` +
    `<span>Página ${STATE.paginaDashTransacoes} de ${totalPaginas} — ${lista.length} transação(ões)</span>` +
    `<button class="btn btn-small" id="btn-dash-pag-proxima" ${STATE.paginaDashTransacoes >= totalPaginas ? "disabled" : ""}>Próxima ›</button>`
  ) : "";
  const btnAnterior = document.getElementById("btn-dash-pag-anterior");
  if (btnAnterior) btnAnterior.addEventListener("click", () => { STATE.paginaDashTransacoes--; renderPainelPeriodoDash(); });
  const btnProxima = document.getElementById("btn-dash-pag-proxima");
  if (btnProxima) btnProxima.addEventListener("click", () => { STATE.paginaDashTransacoes++; renderPainelPeriodoDash(); });

  document.getElementById("btn-dash-limpar-selecao").style.display = STATE.filtroDashCategoria ? "" : "none";
}

// Um ponto por dia, últimos 30 dias — só movimentação de conta "normal"
// (sem cartão) já paga, tipo Saída, é o que conta como "compra" aqui.
function computarComprasUltimos30Dias() {
  const hoje = new Date();
  const dias = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(hoje);
    d.setDate(d.getDate() - i);
    dias.push(formatarDataISO(d));
  }
  const porDia = {};
  dias.forEach((d) => (porDia[d] = { qtd: 0, valor: 0 }));

  const mapaLanc = mapaLancamentos();
  const conexoesAtivas = conexoesAtivasParaPessoal();
  STATE.movimentacoes.forEach((m) => {
    if (!movimentacaoVisivel(m, conexoesAtivas)) return;
    if (m.pago !== true) return;
    if (!porDia[m.data]) return;
    const l = mapaLanc[m.lancamentoId] || {};
    if (l.tipo !== "Saida") return;
    if (ehMovimentacaoDeCartao({ ...m, categoria: l.categoria })) return;
    porDia[m.data].qtd += 1;
    porDia[m.data].valor += Number(m.valor) || 0;
  });
  return dias.map((d) => ({ data: d, ...porDia[d] }));
}

function svgGraficoLinha(pontos, campo, cor, formatador, titulo) {
  const w = 640, h = 170, padL = 8, padR = 8, padT = 20, padB = 24;
  const maxVal = Math.max(1, ...pontos.map((p) => p[campo]));
  const passoX = pontos.length > 1 ? (w - padL - padR) / (pontos.length - 1) : 0;
  const escalaY = (v) => padT + (h - padT - padB) * (1 - v / maxVal);
  const pathD = pontos.map((p, i) => `${i === 0 ? "M" : "L"} ${(padL + i * passoX).toFixed(1)} ${escalaY(p[campo]).toFixed(1)}`).join(" ");
  const xUltimo = padL + (pontos.length - 1) * passoX;
  const areaD = `${pathD} L ${xUltimo.toFixed(1)} ${h - padB} L ${padL} ${h - padB} Z`;
  const ultimo = pontos[pontos.length - 1];
  const pontosHtml = pontos.map((p, i) => {
    const x = padL + i * passoX, y = escalaY(p[campo]);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="11" fill="transparent" class="ponto-linha" data-tip="${dataBR(p.data)}: ${esc(formatador(p[campo]))}"></circle>`;
  }).join("");
  return (
    `<div class="linha-chart-titulo">${esc(titulo)}</div>` +
    `<svg viewBox="0 0 ${w} ${h}" class="linha-svg">` +
    `<line x1="${padL}" y1="${h - padB}" x2="${w - padR}" y2="${h - padB}" class="linha-eixo"></line>` +
    `<path d="${areaD}" fill="${cor}" opacity="0.1"></path>` +
    `<path d="${pathD}" fill="none" stroke="${cor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>` +
    `<circle cx="${xUltimo.toFixed(1)}" cy="${escalaY(ultimo[campo]).toFixed(1)}" r="4" fill="${cor}" stroke="var(--panel)" stroke-width="2"></circle>` +
    `<text x="${xUltimo.toFixed(1)}" y="${Math.max(12, escalaY(ultimo[campo]) - 10).toFixed(1)}" text-anchor="end" class="linha-label-final">${esc(formatador(ultimo[campo]))}</text>` +
    `<text x="${padL}" y="${h - 6}" class="linha-eixo-label">${dataBR(pontos[0].data)}</text>` +
    `<text x="${w - padR}" y="${h - 6}" text-anchor="end" class="linha-eixo-label">${dataBR(pontos[pontos.length - 1].data)}</text>` +
    pontosHtml +
    `</svg>`
  );
}

function renderGraficoCompras() {
  const el = document.getElementById("dash-grafico-compras");
  const pontos = computarComprasUltimos30Dias();
  const semDados = pontos.every((p) => p.qtd === 0);
  if (semDados) {
    el.innerHTML = '<div class="empty">Nenhuma compra nos últimos 30 dias.</div>';
    return;
  }
  el.innerHTML =
    `<div class="linhas-grid">` +
    `<div>${svgGraficoLinha(pontos, "qtd", CORES_CATEGORICAS[0], (v) => String(v), "Quantidade de compras por dia")}</div>` +
    `<div>${svgGraficoLinha(pontos, "valor", CORES_CATEGORICAS[1], (v) => moeda(v), "Valor gasto por dia")}</div>` +
    `</div>`;
  el.querySelectorAll(".ponto-linha").forEach((ponto) => {
    ponto.addEventListener("mousemove", (e) => mostrarTooltipViz(e, ponto.dataset.tip));
    ponto.addEventListener("mouseleave", esconderTooltipViz);
  });
}

document.getElementById("dash-filtro-de").addEventListener("change", (e) => {
  STATE.filtroDashDe = e.target.value;
  STATE.paginaDashTransacoes = 1;
  renderPainelPeriodoDash();
});
document.getElementById("dash-filtro-ate").addEventListener("change", (e) => {
  STATE.filtroDashAte = e.target.value;
  STATE.paginaDashTransacoes = 1;
  renderPainelPeriodoDash();
});
document.getElementById("dash-filtro-tipo").addEventListener("change", (e) => {
  STATE.filtroDashTipo = e.target.value;
  STATE.paginaDashTransacoes = 1;
  renderPainelPeriodoDash();
});
document.getElementById("dash-filtro-banco").addEventListener("change", (e) => {
  STATE.filtroDashBanco = e.target.value;
  STATE.paginaDashTransacoes = 1;
  renderPainelPeriodoDash();
});
document.getElementById("dash-filtro-categoria").addEventListener("change", (e) => {
  STATE.filtroDashCategoria = e.target.value;
  STATE.filtroDashCategoriasOutras = null;
  STATE.paginaDashTransacoes = 1;
  renderPainelPeriodoDash();
});
document.getElementById("btn-dash-limpar-selecao").addEventListener("click", () => {
  STATE.filtroDashCategoria = "";
  STATE.filtroDashCategoriasOutras = null;
  document.getElementById("dash-filtro-categoria").value = "";
  STATE.paginaDashTransacoes = 1;
  renderPainelPeriodoDash();
});

// Painel de período: filtros De/Até/Tipo/Banco/Categoria + KPIs do período +
// as duas roscas interativas + tabela de transações. Não mexe no filtro de
// "Mês" nem nas seções que já existiam antes dele.
function renderPainelPeriodoDash() {
  const listaPeriodo = movimentacoesNoPeriodo(STATE.filtroDashDe, STATE.filtroDashAte);
  preencherFiltrosPeriodoDash(listaPeriodo);
  const listaFiltrada = movimentacoesFiltradasDash();
  renderDashPeriodoKpis(listaFiltrada);
  renderGraficoCategoriasPeriodo("dash-grafico-categorias", agruparPorCategoria(listaFiltrada, "Saida"), "Total gasto", "Nenhum gasto no período selecionado.");
  renderGraficoCategoriasPeriodo("dash-grafico-entradas", agruparPorCategoria(listaFiltrada, "Entrada"), "Total recebido", "Nenhuma entrada no período selecionado.");
  renderTransacoesDash(transacoesListaDash(listaFiltrada));
  renderGraficoCompras();
}

function renderDashboard() {
  const mes = STATE.filtroDashMes || mesAtualISO();
  const d = calcularDashboard(mes);
  const geral = calcularIndicadoresGeraisDash();
  document.getElementById("kpi-grid").innerHTML =
    kpiCard("Saldo atual", moeda(d.saldoAtual), d.saldoAtual >= 0) +
    kpiCard("Renda do mês", moeda(d.entradasMes), true) +
    kpiCard("Total a pagar no mês", moeda(d.saidasMes), true) +
    kpiCard("Já pago no mês", moeda(d.saidasPagasMes), true) +
    kpiCard("Quanto posso gastar por dia", moeda(d.gastoPorDia) + ` <small>(${d.diasRestantes} dias)</small>`, d.gastoPorDia >= 0, {
      destaque: true,
      sub: d.metaGuardarMes > 0 ? `Já deixando ${moeda(d.metaGuardarMes)} reservado pra guardar este mês` : "Defina em Configurações quanto quer guardar este mês"
    }) +
    kpiCard("Saldo previsto", moeda(geral.saldoPrevisto), geral.saldoPrevisto >= 0) +
    kpiCard("% da renda gasta no mês", geral.percentualRendaGasta.toFixed(1) + "%", geral.percentualRendaGasta <= 100) +
    kpiCard("Gasto permitido até hoje", moeda(geral.gastoPermitidoAteHoje), geral.folgaAteHoje >= 0, {
      destaque: true,
      sub: geral.folgaAteHoje >= 0
        ? `Já gastou ${moeda(geral.saidasPagasMes)} — ainda tem ${moeda(geral.folgaAteHoje)} de folga`
        : `Já gastou ${moeda(geral.saidasPagasMes)} — ${moeda(Math.abs(geral.folgaAteHoje))} acima do previsto pra hoje`
    }) +
    kpiCard("Parcelas futuras no cartão", moeda(geral.parcelasCartaoFuturas), true);
  renderDashboardMovs(mes);
  renderGraficoCategorias(mes);
  renderEstimativaMeses();
  renderPainelPeriodoDash();
}

// Só as movimentações do mês escolhido — uma parcela futura (ex: mês que
// vem) só aparece aqui quando o mês dela chegar e virar o mês selecionado
// (o filtro já nasce no mês corrente de verdade a cada vez que o app abre).
function renderDashboardMovs(mes) {
  const mapaLanc = mapaLancamentos();
  const mapaCompra = {};
  STATE.comprasParceladas.forEach((c) => (mapaCompra[c.id] = c));
  const conexoesAtivas = conexoesAtivasParaPessoal();
  const doMes = STATE.movimentacoes
    .filter((m) => movimentacaoVisivel(m, conexoesAtivas))
    .filter((m) => String(m.data || "").slice(0, 7) === mes)
    .map((m) => {
      const l = mapaLanc[m.lancamentoId] || {};
      const compra = m.compraParceladaId ? mapaCompra[m.compraParceladaId] : null;
      return {
        ...m, nomeLancamento: l.nome || "(excluído)", tipo: l.tipo || "",
        descricaoCompra: compra ? compra.descricao : ""
      };
    });
  renderDashMovs(doMes);
}

document.getElementById("dash-filtro-mes").addEventListener("change", (e) => {
  STATE.filtroDashMes = e.target.value;
  renderDashboard();
});
document.getElementById("btn-dash-mes-atual").addEventListener("click", () => {
  STATE.filtroDashMes = mesAtualISO();
  document.getElementById("dash-filtro-mes").value = STATE.filtroDashMes;
  renderDashboard();
});

/* ══════════════ LANÇAMENTOS ══════════════ */

document.getElementById("btn-add-lancamento").addEventListener("click", async () => {
  const nome = document.getElementById("lanc-nome").value.trim();
  const tipo = document.getElementById("lanc-tipo").value;
  const categoria = document.getElementById("lanc-categoria").value.trim();
  if (!nome || !categoria) return mostrarToast("Preencha nome e categoria.", true);
  try {
    await addDoc(collection(db, "lancamentos"), { nome, tipo, categoria, createdAt: serverTimestamp() });
    mostrarToast("Lançamento cadastrado!");
    document.getElementById("lanc-nome").value = "";
    document.getElementById("lanc-categoria").value = "";
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
});

function abrirModalEdicaoLancamento(id) {
  const lanc = STATE.lancamentos.find((l) => l.id === id);
  if (!lanc) return mostrarToast("Lançamento não encontrado.", true);
  document.getElementById("edit-lanc-id").value = lanc.id;
  document.getElementById("edit-lanc-nome").value = lanc.nome;
  document.getElementById("edit-lanc-tipo").value = lanc.tipo;
  document.getElementById("edit-lanc-categoria").value = lanc.categoria;
  document.getElementById("modal-editar").classList.add("active");
}
function fecharModalEdicaoLancamento() {
  document.getElementById("modal-editar").classList.remove("active");
}
document.getElementById("btn-cancelar-edicao-lanc").addEventListener("click", fecharModalEdicaoLancamento);
document.getElementById("modal-editar").addEventListener("click", (e) => {
  if (e.target.id === "modal-editar") fecharModalEdicaoLancamento();
});

document.getElementById("btn-salvar-edicao-lanc").addEventListener("click", async () => {
  const id = document.getElementById("edit-lanc-id").value;
  const nome = document.getElementById("edit-lanc-nome").value.trim();
  const tipo = document.getElementById("edit-lanc-tipo").value;
  const categoria = document.getElementById("edit-lanc-categoria").value.trim();
  if (!nome) return mostrarToast("O nome não pode ficar em branco.", true);
  if (!categoria) return mostrarToast("A categoria não pode ficar em branco.", true);

  const atual = STATE.lancamentos.find((l) => l.id === id);
  if (!atual) return mostrarToast("Lançamento não encontrado.", true);

  const alteracoes = [];
  if (atual.nome !== nome) alteracoes.push({ campo: "Nome", antes: atual.nome, depois: nome });
  if (atual.tipo !== tipo) alteracoes.push({ campo: "Tipo", antes: atual.tipo, depois: tipo });
  if (atual.categoria !== categoria) alteracoes.push({ campo: "Categoria", antes: atual.categoria, depois: categoria });

  if (!alteracoes.length) {
    mostrarToast("Nenhuma alteração encontrada — os dados já eram esses.");
    fecharModalEdicaoLancamento();
    return;
  }

  try {
    await updateDoc(doc(db, "lancamentos", id), { nome, tipo, categoria });
    for (const a of alteracoes) {
      await addDoc(collection(db, "historico"), {
        lancamentoId: id, nomeLancamento: nome, campo: a.campo,
        valorAnterior: String(a.antes), valorNovo: String(a.depois),
        tipoAlteracao: "Edição", dataHora: serverTimestamp()
      });
    }
    mostrarToast(`Lançamento atualizado (${alteracoes.length} campo(s) alterado(s)).`);
    fecharModalEdicaoLancamento();
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
});

/* ══════════════ MOVIMENTAÇÕES ══════════════ */

// Lógica central de criar movimentação — usada tanto pelo formulário da
// aba Movimentações quanto pelo modal de Ação Rápida.
async function criarMovimentacao({ lancamentoId, data, valor, pago }) {
  if (!lancamentoId) { mostrarToast("Cadastre um lançamento primeiro.", true); return false; }
  if (!data || !valor) { mostrarToast("Preencha data e valor.", true); return false; }
  try {
    await addDoc(collection(db, "movimentacoes"), {
      lancamentoId, data, valor, pago, origem: "Manual", revisado: true, cartaoId: null, compraParceladaId: null, createdAt: serverTimestamp()
    });
    mostrarToast("Movimentação adicionada!");
    return true;
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
    return false;
  }
}

document.getElementById("btn-add-movimentacao").addEventListener("click", async () => {
  const ok = await criarMovimentacao({
    lancamentoId: document.getElementById("mov-lancamento").value,
    data: document.getElementById("mov-data").value,
    valor: Number(document.getElementById("mov-valor").value),
    pago: document.getElementById("mov-pago").value === "true"
  });
  if (ok) {
    document.getElementById("mov-valor").value = "";
  }
});

async function alternarPagamento(id, novoPago) {
  try {
    await updateDoc(doc(db, "movimentacoes", id), { pago: novoPago });
  } catch (err) {
    mostrarToast("Não foi possível atualizar: " + err.message, true);
  }
}

function abrirModalMovimentacao(id) {
  const mov = STATE.movimentacoes.find((m) => m.id === id);
  if (!mov) return mostrarToast("Movimentação não encontrada.", true);
  preencherSelectsLancamento();
  document.getElementById("edit-mov-id").value = mov.id;
  definirComboLancamento("edit-mov-lancamento", mov.lancamentoId);
  document.getElementById("edit-mov-data").value = mov.data;
  document.getElementById("edit-mov-valor").value = mov.valor;
  document.getElementById("edit-mov-pago").value = mov.pago ? "true" : "false";

  const infoEl = document.getElementById("edit-mov-info");
  if (mov.origem === "Open Finance") {
    const partes = [mov.previsao === true
      ? `Previsão de parcela futura (${mov.instituicao || "banco"}) — ainda não aconteceu de verdade`
      : `Importada do banco ${mov.instituicao || ""}`.trim()];
    if (mov.descricaoOrigem) partes.push(`descrição${mov.previsao === true ? " estimada" : " original"}: "${mov.descricaoOrigem}"`);
    if (mov.parcelaAtual) partes.push(`parcela ${mov.parcelaAtual}${mov.parcelaTotal ? "/" + mov.parcelaTotal : ""}`);
    if (mov.previsao === true) {
      partes.push("quando essa parcela realmente cair no banco, o sistema atualiza esta linha sozinho — não precisa apagar.");
    } else {
      partes.push(mov.revisado === true ? "já revisada." : "escolha o lançamento certo abaixo pra dizer do que se trata (a próxima transação parecida já entra categorizada sozinha).");
    }
    infoEl.textContent = partes.join(" — ");
    infoEl.classList.remove("hidden");
  } else {
    infoEl.textContent = "";
    infoEl.classList.add("hidden");
  }

  document.getElementById("modal-editar-mov").classList.add("active");
}
function fecharModalMovimentacao() {
  document.getElementById("modal-editar-mov").classList.remove("active");
}
document.getElementById("btn-cancelar-edicao-mov").addEventListener("click", fecharModalMovimentacao);
document.getElementById("modal-editar-mov").addEventListener("click", (e) => {
  if (e.target.id === "modal-editar-mov") fecharModalMovimentacao();
});

document.getElementById("btn-salvar-edicao-mov").addEventListener("click", async () => {
  const id = document.getElementById("edit-mov-id").value;
  const lancamentoId = document.getElementById("edit-mov-lancamento").value;
  const data = document.getElementById("edit-mov-data").value;
  const valor = Number(document.getElementById("edit-mov-valor").value);
  const pago = document.getElementById("edit-mov-pago").value === "true";

  if (!lancamentoId) return mostrarToast("Selecione um lançamento.", true);
  if (!data || !valor) return mostrarToast("Preencha data e valor.", true);

  const atual = STATE.movimentacoes.find((m) => m.id === id);
  if (!atual) return mostrarToast("Movimentação não encontrada.", true);
  const mapaLanc = mapaLancamentos();

  const nomeAntes = (mapaLanc[atual.lancamentoId] || {}).nome || "(excluído)";
  const nomeDepois = (mapaLanc[lancamentoId] || {}).nome || "(excluído)";
  const situacaoAntes = atual.pago ? "Pago" : "Não pago";
  const situacaoDepois = pago ? "Pago" : "Não pago";

  const alteracoes = [];
  if (nomeAntes !== nomeDepois) alteracoes.push({ campo: "Lançamento", antes: nomeAntes, depois: nomeDepois });
  if (atual.data !== data) alteracoes.push({ campo: "Data", antes: dataBR(atual.data), depois: dataBR(data) });
  if (Number(atual.valor) !== valor) alteracoes.push({ campo: "Valor", antes: moeda(atual.valor), depois: moeda(valor) });
  if (situacaoAntes !== situacaoDepois) alteracoes.push({ campo: "Situação", antes: situacaoAntes, depois: situacaoDepois });

  if (!alteracoes.length) {
    mostrarToast("Nenhuma alteração encontrada — os dados já eram esses.");
    fecharModalMovimentacao();
    return;
  }

  const dadosAtualizar = { lancamentoId, data, valor, pago };
  // Abrir o modal e salvar já conta como "revisado" pra transações vindas
  // do Open Finance — é o gesto de "olhei e disse do que se trata".
  if (atual.origem === "Open Finance" && atual.revisado !== true) {
    dadosAtualizar.revisado = true;
  }

  try {
    await updateDoc(doc(db, "movimentacoes", id), dadosAtualizar);
    for (const a of alteracoes) {
      await addDoc(collection(db, "historico"), {
        lancamentoId, nomeLancamento: nomeDepois, campo: a.campo,
        valorAnterior: String(a.antes), valorNovo: String(a.depois),
        tipoAlteracao: "Edição de movimentação", dataHora: serverTimestamp()
      });
    }
    // Se veio do Open Finance e o lançamento mudou, "aprende" a regra: da
    // próxima vez que cair uma transação com essa mesma chave (CNPJ do
    // estabelecimento, ou descrição quando não tem CNPJ), já entra
    // categorizada sozinha.
    if (atual.origem === "Open Finance" && atual.chaveCategorizador && atual.lancamentoId !== lancamentoId) {
      await garantirRegraCategorizacao(atual.chaveCategorizador, lancamentoId, atual.descricaoOrigem);
    }
    mostrarToast(`Movimentação atualizada (${alteracoes.length} campo(s) alterado(s)).`);
    fecharModalMovimentacao();
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
});

document.getElementById("btn-excluir-mov").addEventListener("click", async () => {
  const id = document.getElementById("edit-mov-id").value;
  if (!confirm("Excluir esta movimentação? Isso fica registrado no Histórico de Alterações.")) return;
  const atual = STATE.movimentacoes.find((m) => m.id === id);
  if (!atual) return;
  const mapaLanc = mapaLancamentos();
  const nomeLanc = (mapaLanc[atual.lancamentoId] || {}).nome || "(excluído)";
  const resumo = `${dataBR(atual.data)} — ${moeda(atual.valor)}`;
  try {
    await addDoc(collection(db, "historico"), {
      lancamentoId: atual.lancamentoId, nomeLancamento: nomeLanc, campo: "Movimentação",
      valorAnterior: resumo, valorNovo: "(excluída)", tipoAlteracao: "Exclusão", dataHora: serverTimestamp()
    });
    await deleteDoc(doc(db, "movimentacoes", id));
    mostrarToast("Movimentação excluída.");
    fecharModalMovimentacao();
  } catch (err) {
    mostrarToast("Não foi possível excluir: " + err.message, true);
  }
});

/* ══════════════ CARTÃO DE CRÉDITO ══════════════ */

document.getElementById("btn-add-cartao").addEventListener("click", async () => {
  const nome = document.getElementById("cartao-nome").value.trim();
  const limiteTotal = Number(document.getElementById("cartao-limite").value);
  const diaFechamento = Number(document.getElementById("cartao-fechamento").value);
  const diaVencimento = Number(document.getElementById("cartao-vencimento").value);
  if (!nome || !limiteTotal || !diaFechamento || !diaVencimento) return mostrarToast("Preencha todos os campos do cartão.", true);
  if (diaFechamento < 1 || diaFechamento > 31 || diaVencimento < 1 || diaVencimento > 31) {
    return mostrarToast("Dia de fechamento/vencimento inválido (1 a 31).", true);
  }
  try {
    await addDoc(collection(db, "cartoes"), { nome, limiteTotal, diaFechamento, diaVencimento, ativo: true, createdAt: serverTimestamp() });
    mostrarToast("Cartão cadastrado!");
    ["cartao-nome", "cartao-limite", "cartao-fechamento", "cartao-vencimento"].forEach((id) => (document.getElementById(id).value = ""));
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
});

// Escrita em lote (compra + todas as parcelas de uma vez): não depende de
// runTransaction porque não há dois usuários disputando o mesmo limite ao
// mesmo tempo neste sistema pessoal — a checagem de limite é informativa,
// não uma trava contra corrida. Usada tanto pelo formulário da aba Cartão
// de Crédito quanto pelo modal de Ação Rápida.
async function criarCompraParcelada({ cartaoId, lancamentoId, descricao, valorTotal, numParcelas, dataCompra }) {
  if (!cartaoId) { mostrarToast("Cadastre um cartão primeiro.", true); return false; }
  if (!lancamentoId) { mostrarToast("Cadastre um lançamento primeiro.", true); return false; }
  if (!descricao) { mostrarToast("Descreva a compra.", true); return false; }
  if (!valorTotal || !numParcelas || !dataCompra) { mostrarToast("Preencha valor, parcelas e data da compra.", true); return false; }
  if (numParcelas < 1 || numParcelas > 60) { mostrarToast("Número de parcelas inválido (1 a 60).", true); return false; }

  const cartao = STATE.cartoes.find((c) => c.id === cartaoId);
  if (!cartao) { mostrarToast("Cartão não encontrado.", true); return false; }

  const limiteDisponivel = (Number(cartao.limiteTotal) || 0) - calcularLimiteUtilizado(cartaoId);
  if (valorTotal > limiteDisponivel) {
    mostrarToast("Limite insuficiente nesse cartão. Disponível: " + moeda(limiteDisponivel), true);
    return false;
  }

  try {
    const batch = writeBatch(db);
    const compraRef = doc(collection(db, "comprasParceladas"));
    batch.set(compraRef, { cartaoId, lancamentoId, descricao, valorTotal, numParcelas, dataCompra, dataRegistro: serverTimestamp() });

    const valorParcela = arredondar2(valorTotal / numParcelas);
    const ciclo = calcularCicloInicial(dataCompra, Number(cartao.diaFechamento));

    for (let i = 0; i < numParcelas; i++) {
      const mesRef = new Date(ciclo.ano, ciclo.mes + i, 1);
      const vencimento = calcularProximoVencimento(cartao.diaVencimento, mesRef);
      const valorDaParcela = i === numParcelas - 1
        ? arredondar2(valorTotal - valorParcela * (numParcelas - 1))
        : valorParcela;
      const movRef = doc(collection(db, "movimentacoes"));
      batch.set(movRef, {
        lancamentoId, data: vencimento, valor: valorDaParcela, pago: false,
        origem: `Cartao ${i + 1}/${numParcelas}`, cartaoId, compraParceladaId: compraRef.id, revisado: true, createdAt: serverTimestamp()
      });
    }

    await batch.commit();
    mostrarToast(`${numParcelas} parcela(s) de ${moeda(valorParcela)} lançada(s) em Movimentações.`);
    return true;
  } catch (err) {
    mostrarToast("Não foi possível lançar a compra: " + err.message, true);
    return false;
  }
}

document.getElementById("btn-add-compra").addEventListener("click", async () => {
  const ok = await criarCompraParcelada({
    cartaoId: document.getElementById("compra-cartao").value,
    lancamentoId: document.getElementById("compra-lancamento").value,
    descricao: document.getElementById("compra-descricao").value.trim(),
    valorTotal: Number(document.getElementById("compra-valor").value),
    numParcelas: Number(document.getElementById("compra-parcelas").value),
    dataCompra: document.getElementById("compra-data").value
  });
  if (ok) {
    document.getElementById("compra-descricao").value = "";
    document.getElementById("compra-valor").value = "";
    document.getElementById("compra-parcelas").value = "1";
  }
});

/* ══════════════ CUSTOS RECORRENTES ══════════════ */

// Usada tanto pelo formulário da aba Custos Recorrentes quanto pelo modal
// de Ação Rápida.
async function criarRecorrente({ lancamentoId, valor, dataInicio, diaVencimento, ativo }) {
  if (!lancamentoId) { mostrarToast("Cadastre um lançamento primeiro.", true); return false; }
  if (!valor || !dataInicio || !diaVencimento) { mostrarToast("Preencha valor, data de início e dia de vencimento.", true); return false; }
  try {
    await addDoc(collection(db, "recorrentes"), { lancamentoId, valor, dataInicio, diaVencimento, ativo, ultimoMesLancado: "", createdAt: serverTimestamp() });
    mostrarToast("Custo recorrente cadastrado!");
    return true;
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
    return false;
  }
}

document.getElementById("btn-add-recorrente").addEventListener("click", () => {
  criarRecorrente({
    lancamentoId: document.getElementById("rec-lancamento").value,
    valor: Number(document.getElementById("rec-valor").value),
    dataInicio: document.getElementById("rec-inicio").value,
    diaVencimento: Number(document.getElementById("rec-dia").value),
    ativo: document.getElementById("rec-ativo").value === "true"
  });
});

async function alternarAtivoRecorrente(id, novoAtivo) {
  try {
    await updateDoc(doc(db, "recorrentes", id), { ativo: novoAtivo });
  } catch (err) {
    mostrarToast("Não foi possível atualizar: " + err.message, true);
  }
}

// Substitui o gatilho mensal do Apps Script (não existe "servidor" sem Cloud
// Functions): qualquer pessoa que abrir o app já dispara essa checagem uma
// vez, e lança os recorrentes que ainda não saíram este mês.
async function lancarRecorrentesPendentes(silencioso) {
  const hoje = new Date();
  const mesAtual = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
  const pendentes = STATE.recorrentes.filter((r) => r.ativo === true && r.ultimoMesLancado !== mesAtual);

  if (!pendentes.length) {
    if (!silencioso) mostrarToast("Nenhum custo recorrente pendente este mês.");
    return;
  }

  let lancados = 0;
  for (const r of pendentes) {
    try {
      const vencimento = calcularProximoVencimento(r.diaVencimento, hoje);
      await addDoc(collection(db, "movimentacoes"), {
        lancamentoId: r.lancamentoId, data: vencimento, valor: Number(r.valor),
        pago: false, origem: "Recorrente", revisado: true, cartaoId: null, compraParceladaId: null, createdAt: serverTimestamp()
      });
      await updateDoc(doc(db, "recorrentes", r.id), { ultimoMesLancado: mesAtual });
      lancados++;
    } catch (err) {
      mostrarToast("Erro ao lançar recorrente: " + err.message, true);
    }
  }
  if (lancados > 0) {
    mostrarToast(`${lancados} custo(s) recorrente(s) lançado(s)${silencioso ? " automaticamente" : ""} em Movimentações.`);
  }
}

document.getElementById("btn-lancar-pendentes").addEventListener("click", () => lancarRecorrentesPendentes(false));

function tentarAutoLancarRecorrentes() {
  if (jaVerificouRecorrentesPendentes || !recorrentesCarregados) return;
  jaVerificouRecorrentesPendentes = true;
  lancarRecorrentesPendentes(true).catch(() => {});
}

/* ══════════════ AÇÃO RÁPIDA (botão + na barra inferior) ══════════════ */

document.querySelectorAll("#qa-tabs .qa-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#qa-tabs .qa-tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".qa-form").forEach((f) => f.classList.add("hidden"));
    document.getElementById(`qa-form-${btn.dataset.qaTipo}`).classList.remove("hidden");
  });
});

function abrirModalAcaoRapida() {
  preencherSelectsLancamento();
  preencherSelectCartoes();

  document.querySelectorAll("#qa-tabs .qa-tab").forEach((b, i) => b.classList.toggle("active", i === 0));
  document.querySelectorAll(".qa-form").forEach((f, i) => f.classList.toggle("hidden", i !== 0));

  document.getElementById("qa-mov-data").valueAsDate = new Date();
  document.getElementById("qa-mov-valor").value = "";
  document.getElementById("qa-mov-pago").value = "false";

  document.getElementById("qa-compra-data").valueAsDate = new Date();
  document.getElementById("qa-compra-descricao").value = "";
  document.getElementById("qa-compra-valor").value = "";
  document.getElementById("qa-compra-parcelas").value = "1";

  document.getElementById("qa-rec-inicio").valueAsDate = new Date();
  document.getElementById("qa-rec-valor").value = "";
  document.getElementById("qa-rec-dia").value = "";

  document.getElementById("modal-acao-rapida").classList.add("active");
}
function fecharModalAcaoRapida() {
  document.getElementById("modal-acao-rapida").classList.remove("active");
}
document.getElementById("btn-acao-rapida").addEventListener("click", abrirModalAcaoRapida);
document.getElementById("btn-cancelar-acao-rapida").addEventListener("click", fecharModalAcaoRapida);
document.getElementById("modal-acao-rapida").addEventListener("click", (e) => {
  if (e.target.id === "modal-acao-rapida") fecharModalAcaoRapida();
});

document.getElementById("btn-salvar-acao-rapida").addEventListener("click", async () => {
  const tipoAtivo = document.querySelector("#qa-tabs .qa-tab.active").dataset.qaTipo;
  let ok = false;

  if (tipoAtivo === "movimentacao") {
    ok = await criarMovimentacao({
      lancamentoId: document.getElementById("qa-mov-lancamento").value,
      data: document.getElementById("qa-mov-data").value,
      valor: Number(document.getElementById("qa-mov-valor").value),
      pago: document.getElementById("qa-mov-pago").value === "true"
    });
  } else if (tipoAtivo === "compra") {
    ok = await criarCompraParcelada({
      cartaoId: document.getElementById("qa-compra-cartao").value,
      lancamentoId: document.getElementById("qa-compra-lancamento").value,
      descricao: document.getElementById("qa-compra-descricao").value.trim(),
      valorTotal: Number(document.getElementById("qa-compra-valor").value),
      numParcelas: Number(document.getElementById("qa-compra-parcelas").value),
      dataCompra: document.getElementById("qa-compra-data").value
    });
  } else if (tipoAtivo === "recorrente") {
    ok = await criarRecorrente({
      lancamentoId: document.getElementById("qa-rec-lancamento").value,
      valor: Number(document.getElementById("qa-rec-valor").value),
      dataInicio: document.getElementById("qa-rec-inicio").value,
      diaVencimento: Number(document.getElementById("qa-rec-dia").value),
      ativo: true
    });
  }

  if (ok) fecharModalAcaoRapida();
});

// Abre sozinho na primeira vez que o app carrega NESTA sessão (aba/janela
// aberta agora) — sessionStorage sobrevive a um F5 ou "puxar pra
// atualizar" na mesma aba, mas começa vazio de novo numa aba/sessão nova,
// que é exatamente o que "só ao entrar, não ao atualizar" pede. Só dispara
// depois que os lançamentos carregarem pelo menos uma vez, senão o modal
// abriria com os selects vazios.
const CHAVE_SESSAO_ACAO_RAPIDA = "finleo_acao_rapida_sessao";
function tentarAbrirAcaoRapidaAutomatica() {
  if (!lancamentosCarregados) return;
  if (sessionStorage.getItem(CHAVE_SESSAO_ACAO_RAPIDA)) return;
  sessionStorage.setItem(CHAVE_SESSAO_ACAO_RAPIDA, "1");
  abrirModalAcaoRapida();
}

/* ══════════════ PLANOS (metas de economia) ══════════════ */

function calcularPlanoInfo(p) {
  const valorAlvo = Number(p.valorAlvo) || 0;
  const valorAcumulado = Number(p.valorAcumulado) || 0;
  const falta = arredondar2(Math.max(valorAlvo - valorAcumulado, 0));
  const pct = valorAlvo > 0 ? Math.min(100, (valorAcumulado / valorAlvo) * 100) : 0;
  const concluido = valorAlvo > 0 && valorAcumulado >= valorAlvo;
  const aporteMensal = Number(p.aportePlanejadoMensal) || 0;

  let previsaoTexto = "Defina uma meta mensal ou use o simulador abaixo.";
  if (concluido) {
    previsaoTexto = "Meta alcançada! 🎉";
  } else if (aporteMensal > 0) {
    const meses = Math.ceil(falta / aporteMensal);
    const dataPrevista = new Date();
    dataPrevista.setMonth(dataPrevista.getMonth() + meses);
    previsaoTexto = `≈ ${meses} ${meses === 1 ? "mês" : "meses"} (${dataPrevista.toLocaleDateString("pt-BR", { month: "short", year: "numeric" })})`;
  }
  return { valorAlvo, valorAcumulado, falta, pct, concluido, aporteMensal, previsaoTexto };
}

function renderPlanosKpis() {
  let totalAlvo = 0, totalAcumulado = 0;
  STATE.planos.forEach((p) => {
    totalAlvo += Number(p.valorAlvo) || 0;
    totalAcumulado += Number(p.valorAcumulado) || 0;
  });
  const totalFalta = Math.max(arredondar2(totalAlvo - totalAcumulado), 0);
  document.getElementById("planos-kpi-grid").innerHTML =
    kpiCard("Total das metas", moeda(totalAlvo), true) +
    kpiCard("Já guardado", moeda(totalAcumulado), true) +
    kpiCard("Falta guardar", moeda(totalFalta), totalFalta === 0);
}

function renderPlanos() {
  const grid = document.getElementById("planos-grid");
  renderPlanosKpis();
  if (!STATE.planos.length) {
    grid.innerHTML = '<div class="empty">Nenhum plano cadastrado ainda. Clique em "+ Novo plano" pra começar.</div>';
    return;
  }
  const ordenados = [...STATE.planos].sort((a, b) => tsParaMillis(b.createdAt) - tsParaMillis(a.createdAt));
  grid.innerHTML = ordenados.map((p) => {
    const info = calcularPlanoInfo(p);
    return (
      `<div class="plano-card">` +
      `<div class="plano-header">` +
      `<div class="plano-icone">${esc(p.icone || "🎯")}</div>` +
      `<div class="plano-titulo"><h3>${esc(p.nome)}</h3>` +
      `<span class="stamp ${info.concluido ? "pago" : "andamento"}">${info.concluido ? "CONCLUÍDO" : "EM ANDAMENTO"}</span></div>` +
      `<button class="btn-small" data-editar-plano="${p.id}">Editar</button>` +
      `</div>` +
      (p.descricao ? `<p class="plano-descricao">${esc(p.descricao)}</p>` : "") +
      `<div class="plano-progresso">` +
      `<div class="plano-progresso-barra"><div class="plano-progresso-fill" style="width:${info.pct}%"></div></div>` +
      `<div class="plano-progresso-legenda"><span class="pct">${info.pct.toFixed(0)}%</span><span>${moeda(info.valorAcumulado)} de ${moeda(info.valorAlvo)}</span></div>` +
      `</div>` +
      `<div class="plano-stats">` +
      `<div><span class="label">Falta</span><span class="valor">${moeda(info.falta)}</span></div>` +
      `<div><span class="label">Meta/mês</span><span class="valor">${info.aporteMensal > 0 ? moeda(info.aporteMensal) : "—"}</span></div>` +
      `<div><span class="label">Previsão</span><span class="valor" style="font-size:11px;">${info.previsaoTexto}</span></div>` +
      `</div>` +
      `<div class="plano-simulador">` +
      `<div class="sim-titulo">Simulador — quero investir mais</div>` +
      `<div class="field"><label>Guardando por mês (R$)</label>` +
      `<input type="number" step="0.01" class="sim-mensal" data-plano="${p.id}" data-falta="${info.falta}" value="${info.aporteMensal || ""}" placeholder="Ex: 200"></div>` +
      `<div class="sim-resultado" data-sim-tempo="${p.id}"></div>` +
      `<div class="field"><label>Quero conseguir em quantos meses</label>` +
      `<input type="number" step="1" min="1" class="sim-meses" data-plano="${p.id}" data-falta="${info.falta}" placeholder="Ex: 6"></div>` +
      `<div class="sim-resultado" data-sim-valor="${p.id}"></div>` +
      `</div>` +
      `<div class="plano-footer"><button class="btn btn-primary" data-abrir-aporte="${p.id}">Registrar aporte / retirada</button></div>` +
      `</div>`
    );
  }).join("");

  grid.querySelectorAll("[data-editar-plano]").forEach((btn) => {
    btn.addEventListener("click", () => abrirModalPlano(btn.dataset.editarPlano));
  });
  grid.querySelectorAll("[data-abrir-aporte]").forEach((btn) => {
    btn.addEventListener("click", () => abrirModalAporte(btn.dataset.abrirAporte));
  });
  grid.querySelectorAll(".sim-mensal").forEach((input) => {
    input.addEventListener("input", () => atualizarSimuladorTempo(input));
    atualizarSimuladorTempo(input);
  });
  grid.querySelectorAll(".sim-meses").forEach((input) => {
    input.addEventListener("input", () => atualizarSimuladorValor(input));
  });
}

function atualizarSimuladorTempo(input) {
  const falta = Number(input.dataset.falta) || 0;
  const valorMensal = Number(input.value);
  const out = document.querySelector(`[data-sim-tempo="${input.dataset.plano}"]`);
  if (!out) return;
  if (falta <= 0) { out.innerHTML = "Meta já alcançada."; return; }
  if (!valorMensal || valorMensal <= 0) { out.innerHTML = ""; return; }
  const meses = Math.ceil(falta / valorMensal);
  const dataPrevista = new Date();
  dataPrevista.setMonth(dataPrevista.getMonth() + meses);
  out.innerHTML =
    `Nesse ritmo: <strong>≈ ${meses} ${meses === 1 ? "mês" : "meses"}</strong> ` +
    `(previsão: ${dataPrevista.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}) — ` +
    `<button type="button" class="sim-usar" data-usar-mensal="${input.dataset.plano}" data-valor="${valorMensal}">usar como minha meta mensal</button>`;
  const btn = out.querySelector("[data-usar-mensal]");
  if (btn) btn.addEventListener("click", () => salvarMetaMensalPlano(btn.dataset.usarMensal, Number(btn.dataset.valor)));
}

function atualizarSimuladorValor(input) {
  const falta = Number(input.dataset.falta) || 0;
  const meses = Number(input.value);
  const out = document.querySelector(`[data-sim-valor="${input.dataset.plano}"]`);
  if (!out) return;
  if (falta <= 0) { out.innerHTML = "Meta já alcançada."; return; }
  if (!meses || meses <= 0) { out.innerHTML = ""; return; }
  const valorNecessario = arredondar2(falta / meses);
  out.innerHTML =
    `Você precisa guardar <strong>${moeda(valorNecessario)}/mês</strong> — ` +
    `<button type="button" class="sim-usar" data-usar-mensal="${input.dataset.plano}" data-valor="${valorNecessario}">usar como minha meta mensal</button>`;
  const btn = out.querySelector("[data-usar-mensal]");
  if (btn) btn.addEventListener("click", () => salvarMetaMensalPlano(btn.dataset.usarMensal, Number(btn.dataset.valor)));
}

async function salvarMetaMensalPlano(planoId, valor) {
  try {
    await updateDoc(doc(db, "planos", planoId), { aportePlanejadoMensal: valor });
    mostrarToast("Meta mensal atualizada!");
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
}

function abrirModalPlano(id) {
  const editando = !!id;
  document.getElementById("modal-plano-titulo").textContent = editando ? "Editar plano" : "Novo plano";
  document.getElementById("btn-excluir-plano").classList.toggle("hidden", !editando);
  if (editando) {
    const p = STATE.planos.find((x) => x.id === id);
    if (!p) return mostrarToast("Plano não encontrado.", true);
    document.getElementById("plano-id").value = p.id;
    document.getElementById("plano-icone").value = p.icone || "🎯";
    document.getElementById("plano-nome").value = p.nome;
    document.getElementById("plano-descricao").value = p.descricao || "";
    document.getElementById("plano-valor-alvo").value = p.valorAlvo;
    document.getElementById("plano-aporte-mensal").value = p.aportePlanejadoMensal || "";
  } else {
    document.getElementById("plano-id").value = "";
    document.getElementById("plano-icone").value = "🎯";
    document.getElementById("plano-nome").value = "";
    document.getElementById("plano-descricao").value = "";
    document.getElementById("plano-valor-alvo").value = "";
    document.getElementById("plano-aporte-mensal").value = "";
  }
  document.getElementById("modal-plano").classList.add("active");
}
function fecharModalPlano() {
  document.getElementById("modal-plano").classList.remove("active");
}
document.getElementById("btn-novo-plano").addEventListener("click", () => abrirModalPlano(null));
document.getElementById("btn-cancelar-plano").addEventListener("click", fecharModalPlano);
document.getElementById("modal-plano").addEventListener("click", (e) => {
  if (e.target.id === "modal-plano") fecharModalPlano();
});

document.getElementById("btn-salvar-plano").addEventListener("click", async () => {
  const id = document.getElementById("plano-id").value;
  const icone = document.getElementById("plano-icone").value;
  const nome = document.getElementById("plano-nome").value.trim();
  const descricao = document.getElementById("plano-descricao").value.trim();
  const valorAlvo = Number(document.getElementById("plano-valor-alvo").value);
  const aportePlanejadoMensal = Number(document.getElementById("plano-aporte-mensal").value) || 0;
  if (!nome) return mostrarToast("Dê um nome pro plano.", true);
  if (!valorAlvo || valorAlvo <= 0) return mostrarToast("Informe quanto o plano vai custar.", true);
  try {
    if (id) {
      await updateDoc(doc(db, "planos", id), { icone, nome, descricao, valorAlvo, aportePlanejadoMensal });
      mostrarToast("Plano atualizado!");
    } else {
      await addDoc(collection(db, "planos"), {
        icone, nome, descricao, valorAlvo, aportePlanejadoMensal, valorAcumulado: 0, createdAt: serverTimestamp()
      });
      mostrarToast("Plano criado!");
    }
    fecharModalPlano();
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
});

document.getElementById("btn-excluir-plano").addEventListener("click", async () => {
  const id = document.getElementById("plano-id").value;
  if (!id) return;
  if (!confirm("Excluir este plano? O histórico de aportes dele também será perdido.")) return;
  try {
    await deleteDoc(doc(db, "planos", id));
    mostrarToast("Plano excluído.");
    fecharModalPlano();
  } catch (err) {
    mostrarToast("Não foi possível excluir: " + err.message, true);
  }
});

function abrirModalAporte(planoId) {
  const p = STATE.planos.find((x) => x.id === planoId);
  if (!p) return mostrarToast("Plano não encontrado.", true);
  document.getElementById("aporte-plano-id").value = planoId;
  document.getElementById("aporte-plano-nome").textContent = `${p.icone || "🎯"} ${p.nome}`;
  document.getElementById("aporte-tipo").value = "Aporte";
  document.getElementById("aporte-valor").value = "";
  document.getElementById("aporte-data").valueAsDate = new Date();
  document.getElementById("modal-aporte-plano").classList.add("active");
}
function fecharModalAporte() {
  document.getElementById("modal-aporte-plano").classList.remove("active");
}
document.getElementById("btn-cancelar-aporte").addEventListener("click", fecharModalAporte);
document.getElementById("modal-aporte-plano").addEventListener("click", (e) => {
  if (e.target.id === "modal-aporte-plano") fecharModalAporte();
});

document.getElementById("btn-salvar-aporte").addEventListener("click", async () => {
  const planoId = document.getElementById("aporte-plano-id").value;
  const tipo = document.getElementById("aporte-tipo").value;
  const valor = Number(document.getElementById("aporte-valor").value);
  const data = document.getElementById("aporte-data").value;
  if (!valor || valor <= 0) return mostrarToast("Informe um valor válido.", true);
  if (!data) return mostrarToast("Informe a data.", true);

  const p = STATE.planos.find((x) => x.id === planoId);
  if (!p) return mostrarToast("Plano não encontrado.", true);
  if (tipo === "Retirada" && valor > (Number(p.valorAcumulado) || 0)) {
    return mostrarToast(`Não dá pra retirar mais do que já foi guardado (${moeda(p.valorAcumulado)}).`, true);
  }

  try {
    const batch = writeBatch(db);
    const delta = tipo === "Aporte" ? valor : -valor;
    batch.update(doc(db, "planos", planoId), { valorAcumulado: increment(delta) });
    const aporteRef = doc(collection(db, "planos", planoId, "aportes"));
    batch.set(aporteRef, { tipo, valor, data, timestamp: serverTimestamp() });
    await batch.commit();
    mostrarToast(tipo === "Aporte" ? "Aporte registrado!" : "Retirada registrada!");
    fecharModalAporte();
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
});

/* ══════════════ LISTA DE COMPRAS ══════════════
 *
 * Lembretes/planejamento de compras futuras — não é uma movimentação (não
 * mexe em saldo nenhum). Cada item é "Pontual" (compra só uma vez; ao
 * marcar como comprado vai pro histórico com status "Comprado") ou
 * "Recorrente" (se repete; ao marcar como comprado NUNCA é removido nem
 * muda de status — só reagenda "proximaCompra" pro próximo período e
 * continua aparecendo como pendente). "Cancelado" existe pros dois tipos e
 * também vai pro histórico, com um botão "Reativar" pra voltar a pendente.
 */

function preencherFiltroCategoriaCompras() {
  const sel = document.getElementById("lc-filtro-categoria");
  const atual = sel.value;
  const categorias = [...new Set(STATE.listaCompras.map((i) => i.categoria).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">Todas as categorias</option>' + categorias.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  sel.value = categorias.includes(atual) ? atual : "";
  document.getElementById("dl-lc-categoria").innerHTML = categorias.map((c) => `<option value="${esc(c)}"></option>`).join("");
}

function filtrarItensCompra(lista) {
  return lista.filter((i) => {
    if (STATE.filtroLCTipo && i.tipoCompra !== STATE.filtroLCTipo) return false;
    if (STATE.filtroLCCategoria && (i.categoria || "") !== STATE.filtroLCCategoria) return false;
    if (STATE.filtroLCStatus && i.status !== STATE.filtroLCStatus) return false;
    return true;
  });
}

function ordenarItensCompra(lista) {
  const arr = [...lista];
  if (STATE.filtroLCOrdenar === "valor") arr.sort((a, b) => (Number(b.valorEstimado) || 0) - (Number(a.valorEstimado) || 0));
  else if (STATE.filtroLCOrdenar === "nome") arr.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  else arr.sort((a, b) => tsParaMillis(b.createdAt) - tsParaMillis(a.createdAt));
  return arr;
}

function renderListaComprasKpis(pendentes) {
  const valorEstimadoTotal = pendentes.reduce((s, i) => s + (Number(i.valorEstimado) || 0), 0);
  const totalRecorrentes = pendentes.filter((i) => i.tipoCompra === "Recorrente").length;
  document.getElementById("lc-kpi-grid").innerHTML =
    kpiCard("Itens pendentes", String(pendentes.length), true) +
    kpiCard("Valor estimado (pendentes)", moeda(valorEstimadoTotal), true) +
    kpiCard("Recorrentes ativos", String(totalRecorrentes), true);
}

function renderListaCompras() {
  preencherFiltroCategoriaCompras();
  const filtradas = ordenarItensCompra(filtrarItensCompra(STATE.listaCompras));

  const todosPendentes = STATE.listaCompras.filter((i) => i.status === "Pendente");
  renderListaComprasKpis(todosPendentes);

  const recorrentes = filtradas.filter((i) => i.tipoCompra === "Recorrente" && i.status === "Pendente");
  const pontuais = filtradas.filter((i) => i.tipoCompra === "Pontual" && i.status === "Pendente");
  const historico = filtradas
    .filter((i) => i.status !== "Pendente")
    .sort((a, b) => tsParaMillis(b.createdAt) - tsParaMillis(a.createdAt));

  const bodyRec = document.getElementById("lc-recorrentes-body");
  bodyRec.innerHTML = recorrentes.length ? recorrentes.map((i) => (
    `<tr class="linha-clicavel" data-abrir-item-compra="${i.id}">` +
    `<td>${esc(i.nome)}${i.descricao ? `<span class="sublabel">${esc(i.descricao)}</span>` : ""}</td>` +
    `<td>${esc(i.categoria || "—")}</td>` +
    `<td class="num">${i.valorEstimado ? moeda(i.valorEstimado) : "—"}</td>` +
    `<td>${rotuloFrequenciaCompra(i.recorrenciaFrequencia, i.recorrenciaIntervaloDias)}</td>` +
    `<td>${i.ultimaCompra ? dataBR(i.ultimaCompra) : "—"}</td>` +
    `<td>${i.proximaCompra ? dataBR(i.proximaCompra) : "—"}</td>` +
    `<td><button class="btn-small" data-marcar-comprado="${i.id}">Marcar comprado</button></td></tr>`
  )).join("") : '<tr><td colspan="7" class="empty">Nenhuma compra recorrente pendente.</td></tr>';

  const bodyPont = document.getElementById("lc-pontuais-body");
  bodyPont.innerHTML = pontuais.length ? pontuais.map((i) => (
    `<tr class="linha-clicavel" data-abrir-item-compra="${i.id}">` +
    `<td>${esc(i.nome)}${i.descricao ? `<span class="sublabel">${esc(i.descricao)}</span>` : ""}</td>` +
    `<td>${esc(i.categoria || "—")}</td>` +
    `<td class="num">${i.valorEstimado ? moeda(i.valorEstimado) : "—"}</td>` +
    `<td>${fmtDataHora(i.createdAt)}</td>` +
    `<td><button class="btn-small" data-marcar-comprado="${i.id}">Marcar comprado</button></td></tr>`
  )).join("") : '<tr><td colspan="5" class="empty">Nenhuma compra pontual pendente.</td></tr>';

  const bodyHist = document.getElementById("lc-historico-body");
  bodyHist.innerHTML = historico.length ? historico.map((i) => (
    `<tr class="linha-clicavel" data-abrir-item-compra="${i.id}">` +
    `<td>${esc(i.nome)}</td>` +
    `<td><span class="badge-tipo ${i.tipoCompra}">${esc(i.tipoCompra)}</span></td>` +
    `<td>${esc(i.categoria || "—")}</td>` +
    `<td class="num">${i.valorEstimado ? moeda(i.valorEstimado) : "—"}</td>` +
    `<td><span class="stamp ${i.status === "Comprado" ? "pago" : "inativo"}">${i.status === "Comprado" ? "COMPRADO" : "CANCELADO"}</span></td>` +
    `<td>${i.ultimaCompra ? dataBR(i.ultimaCompra) : "—"}</td>` +
    `<td><button class="btn-small" data-reativar-item="${i.id}">Reativar</button></td></tr>`
  )).join("") : '<tr><td colspan="7" class="empty">Nenhum item no histórico ainda.</td></tr>';

  document.querySelectorAll("[data-abrir-item-compra]").forEach((tr) => {
    tr.addEventListener("click", () => abrirModalEditarItemCompra(tr.dataset.abrirItemCompra));
  });
  document.querySelectorAll("[data-marcar-comprado]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      marcarItemCompraComprado(btn.dataset.marcarComprado);
    });
  });
  document.querySelectorAll("[data-reativar-item]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      reativarItemCompra(btn.dataset.reativarItem);
    });
  });
}

["lc-filtro-tipo", "lc-filtro-categoria", "lc-filtro-status", "lc-filtro-ordenar"].forEach((id) => {
  document.getElementById(id).addEventListener("change", (e) => {
    if (id === "lc-filtro-tipo") STATE.filtroLCTipo = e.target.value;
    if (id === "lc-filtro-categoria") STATE.filtroLCCategoria = e.target.value;
    if (id === "lc-filtro-status") STATE.filtroLCStatus = e.target.value;
    if (id === "lc-filtro-ordenar") STATE.filtroLCOrdenar = e.target.value;
    renderListaCompras();
  });
});

// Mostra/esconde os campos de recorrência (frequência / intervalo em dias)
// conforme o tipo de compra escolhido, tanto no form de novo item quanto no
// modal de edição.
function alternarCamposRecorrencia(prefixo) {
  const tipo = document.getElementById(`${prefixo}-tipo`).value;
  document.getElementById(`${prefixo}-campos-recorrencia`).classList.toggle("hidden", tipo !== "Recorrente");
}
function alternarCampoIntervalo(prefixo) {
  const freq = document.getElementById(`${prefixo}-frequencia`).value;
  document.getElementById(`${prefixo}-campo-intervalo`).classList.toggle("hidden", freq !== "personalizada");
}
document.getElementById("lc-tipo").addEventListener("change", () => alternarCamposRecorrencia("lc"));
document.getElementById("lc-frequencia").addEventListener("change", () => alternarCampoIntervalo("lc"));
document.getElementById("edit-lc-tipo").addEventListener("change", () => alternarCamposRecorrencia("edit-lc"));
document.getElementById("edit-lc-frequencia").addEventListener("change", () => alternarCampoIntervalo("edit-lc"));
alternarCamposRecorrencia("lc"); // estado inicial do form (tipo padrão = Pontual, então já começa escondido)

document.getElementById("btn-add-item-compra").addEventListener("click", async () => {
  const btn = document.getElementById("btn-add-item-compra");
  const nome = document.getElementById("lc-nome").value.trim();
  const categoria = document.getElementById("lc-categoria").value.trim();
  const valorEstimado = Number(document.getElementById("lc-valor").value) || 0;
  const tipoCompra = document.getElementById("lc-tipo").value;
  const descricao = document.getElementById("lc-descricao").value.trim();
  const frequencia = document.getElementById("lc-frequencia").value;
  const intervaloDias = Number(document.getElementById("lc-intervalo-dias").value) || 0;
  if (!nome) return mostrarToast("Dê um nome pro item.", true);
  if (tipoCompra === "Recorrente" && frequencia === "personalizada" && intervaloDias <= 0) {
    return mostrarToast("Informe a cada quantos dias esse item se repete.", true);
  }
  // Evita duplo clique enviar o item duas vezes, e dá retorno visual
  // imediato — antes o botão continuava clicável durante o "await
  // addDoc", então um segundo clique (ou uma conexão lenta/instável)
  // podia dar a falsa impressão de que nada tinha acontecido.
  if (btn.disabled) return;
  btn.disabled = true;
  const textoOriginal = btn.textContent;
  btn.textContent = "Salvando...";
  if (navigator.onLine === false) {
    mostrarToast("Sem conexão com a internet agora — o item só entra na lista quando a conexão voltar.", true);
  }
  try {
    const dados = { nome, descricao, valorEstimado, categoria, tipoCompra, status: "Pendente", ultimaCompra: null, proximaCompra: null, createdAt: serverTimestamp() };
    if (tipoCompra === "Recorrente") {
      dados.recorrenciaFrequencia = frequencia;
      dados.recorrenciaIntervaloDias = frequencia === "personalizada" ? intervaloDias : null;
    }
    await addDoc(collection(db, "listaCompras"), dados);
    mostrarToast("Item adicionado à lista de compras!");
    document.getElementById("lc-nome").value = "";
    document.getElementById("lc-categoria").value = "";
    document.getElementById("lc-valor").value = "";
    document.getElementById("lc-descricao").value = "";
    document.getElementById("lc-tipo").value = "Pontual";
    document.getElementById("lc-frequencia").value = "mensal";
    document.getElementById("lc-intervalo-dias").value = "";
    alternarCamposRecorrencia("lc");
    alternarCampoIntervalo("lc");
  } catch (err) {
    // Loga o erro completo no console (F12 > Console) — se o problema
    // continuar, o texto exato ali (ex: "Missing or insufficient
    // permissions") ajuda a achar a causa real bem mais rápido.
    console.error("Falha ao adicionar item na lista de compras:", err);
    mostrarToast("Não foi possível salvar: " + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = textoOriginal;
  }
});

// Marca um item como comprado. Pontual: vira status "Comprado" e vai pro
// histórico. Recorrente: NUNCA muda de status — só registra "ultimaCompra"
// e recalcula "proximaCompra" pro próximo período, continuando pendente.
async function marcarItemCompraComprado(id) {
  const item = STATE.listaCompras.find((i) => i.id === id);
  if (!item) return mostrarToast("Item não encontrado.", true);
  const hoje = formatarDataISO(new Date());
  try {
    if (item.tipoCompra === "Recorrente") {
      const proxima = calcularProximaDataCompra(item.recorrenciaFrequencia, item.recorrenciaIntervaloDias, hoje);
      await updateDoc(doc(db, "listaCompras", id), { ultimaCompra: hoje, proximaCompra: proxima });
      mostrarToast(`Comprado! Reagendado para ${dataBR(proxima)}.`);
    } else {
      await updateDoc(doc(db, "listaCompras", id), { status: "Comprado", ultimaCompra: hoje });
      mostrarToast("Item marcado como comprado!");
    }
  } catch (err) {
    mostrarToast("Não foi possível atualizar: " + err.message, true);
  }
}

async function reativarItemCompra(id) {
  try {
    await updateDoc(doc(db, "listaCompras", id), { status: "Pendente" });
    mostrarToast("Item reativado — voltou pra lista de pendentes.");
  } catch (err) {
    mostrarToast("Não foi possível reativar: " + err.message, true);
  }
}

function abrirModalEditarItemCompra(id) {
  const i = STATE.listaCompras.find((x) => x.id === id);
  if (!i) return mostrarToast("Item não encontrado.", true);
  document.getElementById("edit-lc-id").value = i.id;
  document.getElementById("edit-lc-nome").value = i.nome;
  document.getElementById("edit-lc-categoria").value = i.categoria || "";
  document.getElementById("edit-lc-valor").value = i.valorEstimado || "";
  document.getElementById("edit-lc-tipo").value = i.tipoCompra;
  document.getElementById("edit-lc-frequencia").value = i.recorrenciaFrequencia || "mensal";
  document.getElementById("edit-lc-intervalo-dias").value = i.recorrenciaIntervaloDias || "";
  document.getElementById("edit-lc-descricao").value = i.descricao || "";
  document.getElementById("edit-lc-status").value = i.status;
  alternarCamposRecorrencia("edit-lc");
  alternarCampoIntervalo("edit-lc");
  document.getElementById("modal-editar-item-compra").classList.add("active");
}
function fecharModalEditarItemCompra() {
  document.getElementById("modal-editar-item-compra").classList.remove("active");
}
document.getElementById("btn-cancelar-edicao-item-compra").addEventListener("click", fecharModalEditarItemCompra);
document.getElementById("modal-editar-item-compra").addEventListener("click", (e) => {
  if (e.target.id === "modal-editar-item-compra") fecharModalEditarItemCompra();
});

document.getElementById("btn-salvar-edicao-item-compra").addEventListener("click", async () => {
  const id = document.getElementById("edit-lc-id").value;
  const nome = document.getElementById("edit-lc-nome").value.trim();
  const categoria = document.getElementById("edit-lc-categoria").value.trim();
  const valorEstimado = Number(document.getElementById("edit-lc-valor").value) || 0;
  const tipoCompra = document.getElementById("edit-lc-tipo").value;
  const frequencia = document.getElementById("edit-lc-frequencia").value;
  const intervaloDias = Number(document.getElementById("edit-lc-intervalo-dias").value) || 0;
  const descricao = document.getElementById("edit-lc-descricao").value.trim();
  const status = document.getElementById("edit-lc-status").value;
  if (!nome) return mostrarToast("Dê um nome pro item.", true);
  if (tipoCompra === "Recorrente" && frequencia === "personalizada" && intervaloDias <= 0) {
    return mostrarToast("Informe a cada quantos dias esse item se repete.", true);
  }
  try {
    const dados = { nome, categoria, valorEstimado, tipoCompra, descricao, status };
    dados.recorrenciaFrequencia = tipoCompra === "Recorrente" ? frequencia : null;
    dados.recorrenciaIntervaloDias = tipoCompra === "Recorrente" && frequencia === "personalizada" ? intervaloDias : null;
    await updateDoc(doc(db, "listaCompras", id), dados);
    mostrarToast("Item atualizado!");
    fecharModalEditarItemCompra();
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
});

document.getElementById("btn-excluir-item-compra").addEventListener("click", async () => {
  const id = document.getElementById("edit-lc-id").value;
  if (!confirm("Excluir este item da lista de compras?")) return;
  try {
    await deleteDoc(doc(db, "listaCompras", id));
    mostrarToast("Item excluído.");
    fecharModalEditarItemCompra();
  } catch (err) {
    mostrarToast("Não foi possível excluir: " + err.message, true);
  }
});

/* ══════════════ CONEXÕES BANCÁRIAS (Open Finance via Pluggy — só leitura) ══════════════
 *
 * Escopo desta integração: importar transações/saldos do banco PRA DENTRO
 * do app, como movimentações normais. Não existe (e não deve ser criado)
 * nenhum caminho de código aqui que inicie pagamento, transferência, PIX ou
 * qualquer outra ação que mexa em dinheiro de verdade — é leitura, ponto.
 *
 * O app.js nunca guarda nem vê clientId/clientSecret da Pluggy: ele só
 * conversa com o Code.gs (Apps Script Web App, URL em PLUGGY_PROXY_URL),
 * que é quem tem as credenciais (Script Properties) e fala com a API da
 * Pluggy. O widget "Pluggy Connect" (carregado no index.html) é quem
 * mostra a tela de login do banco — dentro do iframe controlado pela
 * própria Pluggy, este app nunca vê usuário/senha do banco.
 */

// Chama o proxy (Code.gs) com uma ação e devolve a resposta já validada.
async function chamarProxyPluggy(body) {
  if (!PLUGGY_PROXY_URL || PLUGGY_PROXY_URL.startsWith("COLE_AQUI")) {
    throw new Error("Configure PLUGGY_PROXY_URL em firebase-init.js primeiro (veja o README).");
  }
  // Lê como texto e só depois tenta JSON: quando o Apps Script não está
  // implantado direito ele devolve uma PÁGINA HTML (login/erro do Google), e
  // chamar r.json() direto gerava o erro cru "Unexpected token '<'".
  let resp;
  try {
    const r = await fetch(PLUGGY_PROXY_URL, { method: "POST", body: JSON.stringify(body) });
    const texto = await r.text();
    try {
      resp = JSON.parse(texto);
    } catch (e) {
      const erro = new Error('Integração bancária indisponível: o Apps Script respondeu uma página em vez de dados. Reimplante o Code.gs como Aplicativo da Web (acesso "Qualquer pessoa") e confira a URL em firebase-init.js.');
      erro.proxyIndisponivel = true;
      throw erro;
    }
  } catch (err) {
    if (err.proxyIndisponivel) throw err;
    const erro = new Error("Não consegui falar com o serviço de integração bancária (sem internet ou bloqueado). Tente de novo em instantes.");
    erro.proxyIndisponivel = true;
    throw erro;
  }
  if (!resp || resp.ok === false) {
    throw new Error((resp && resp.erro) || "Erro na integração bancária.");
  }
  return resp;
}

function renderConexoes() {
  const grid = document.getElementById("conexoes-grid");
  if (!grid) return;
  if (!STATE.conexoesBancarias.length) {
    grid.innerHTML = '<div class="empty">Nenhum banco conectado ainda. Clique em "+ Conectar novo banco" pra começar.</div>';
    return;
  }
  const ordenadas = [...STATE.conexoesBancarias].sort((a, b) => tsParaMillis(b.createdAt) - tsParaMillis(a.createdAt));
  grid.innerHTML = ordenadas.map((c) => {
    const statusClasse = c.status === "conectado" ? "conectado" : (c.status === "reconexao_necessaria" ? "reconexao" : "erro");
    const statusTexto = c.status === "conectado" ? "CONECTADO" : (c.status === "reconexao_necessaria" ? "RECONEXÃO NECESSÁRIA" : "ERRO");
    const ultimaSinc = c.ultimaSincronizacao ? fmtDataHora(c.ultimaSincronizacao) : "nunca sincronizado";
    const incluido = c.ativoParaPessoal !== false;
    return (
      `<div class="conexao-card${incluido ? "" : " conexao-oculta"}">` +
      `<div class="conexao-topo"><h3>${esc(c.instituicao || "Banco")}</h3><span class="stamp ${statusClasse}">${statusTexto}</span></div>` +
      `<div class="conexao-info">Última sincronização: ${esc(ultimaSinc)}</div>` +
      `<label class="conexao-toggle"><input type="checkbox" data-alternar-inclusao-pessoal="${c.id}" data-novo-valor="${!incluido}" ${incluido ? "checked" : ""}> Incluir no uso pessoal (Dashboard e Movimentações)</label>` +
      `<button class="btn btn-primary" data-sincronizar-conexao="${c.id}">🔄 Sincronizar agora</button>` +
      `</div>`
    );
  }).join("");
  grid.querySelectorAll("[data-sincronizar-conexao]").forEach((btn) => {
    btn.addEventListener("click", () => sincronizarConexao(btn.dataset.sincronizarConexao));
  });
  grid.querySelectorAll("[data-alternar-inclusao-pessoal]").forEach((chk) => {
    chk.addEventListener("change", async () => {
      try {
        await updateDoc(doc(db, "conexoesBancarias", chk.dataset.alternarInclusaoPessoal), { ativoParaPessoal: chk.dataset.novoValor === "true" });
      } catch (err) {
        mostrarToast("Não foi possível salvar: " + err.message, true);
      }
    });
  });
}

// Cartões descobertos via Open Finance — só leitura (espelho do que o banco
// reporta a cada sincronização). Diferente do cadastro manual de cartões
// (aba "Cartão de Crédito" acima), aqui não existe dia de
// fechamento/vencimento fixo escolhido pelo usuário nem controle de
// parcelas feito pelo app — quem calcula tudo isso é o próprio banco.
function renderCartoesOpenFinance() {
  const grid = document.getElementById("cartoes-of-grid");
  if (grid) {
    if (!STATE.cartoesOpenFinance.length) {
      grid.innerHTML = '<div class="empty">Nenhum cartão encontrado via Open Finance ainda — sincronize uma conexão bancária que tenha cartão de crédito.</div>';
    } else {
      const ordenados = [...STATE.cartoesOpenFinance].sort((a, b) => (a.instituicao || "").localeCompare(b.instituicao || "", "pt-BR"));
      grid.innerHTML = ordenados.map((c) => {
        const pctUtilizado = c.limiteTotal > 0 ? Math.min(100, Math.max(0, (c.limiteUtilizado / c.limiteTotal) * 100)) : 0;
        const diaFechamento = diaFechamentoEfetivoOF(c);
        const diaVencimento = diaVencimentoEfetivoOF(c);
        const rotuloFechamento = diaFechamento ? `dia ${diaFechamento}${c.diaFechamentoManual ? " (configurado por você)" : ""}` : "não informado";
        const rotuloVencimento = diaVencimento ? `dia ${diaVencimento}${c.diaVencimentoManual ? " (configurado por você)" : ""}` : "não informado";
        return (
          `<div class="conexao-card">` +
          `<div class="conexao-topo"><h3>${esc(c.instituicao)} — ${esc(c.nome)}</h3>${c.bandeira ? `<span class="badge-tipo Saida">${esc(c.bandeira)}</span>` : ""}</div>` +
          `<div class="plano-progresso-barra"><div class="plano-progresso-fill" style="width:${pctUtilizado}%"></div></div>` +
          `<div class="plano-progresso-legenda"><span class="pct">${pctUtilizado.toFixed(0)}% utilizado</span><span>${moeda(c.limiteUtilizado)} de ${moeda(c.limiteTotal)}</span></div>` +
          `<div class="conexao-info" style="margin-top:10px;">Disponível: <strong>${moeda(c.limiteDisponivel)}</strong></div>` +
          `<div class="conexao-info">Fechamento: ${rotuloFechamento} · Vencimento: ${rotuloVencimento}</div>` +
          `<div class="conexao-info">Atualizado em: ${c.ultimaSincronizacao ? fmtDataHora(c.ultimaSincronizacao) : "—"}</div>` +
          `<button class="btn-small" style="margin-top:8px;" data-configurar-ciclo="${c.id}">✏️ Configurar dia de fechamento/vencimento</button>` +
          `</div>`
        );
      }).join("");
      grid.querySelectorAll("[data-configurar-ciclo]").forEach((btn) => {
        btn.addEventListener("click", () => abrirModalConfigurarCicloOF(btn.dataset.configurarCiclo));
      });
    }
  }
  // Também aparecem como opção no formulário "Nova compra parcelada" — sem
  // isso, um cartão Open Finance novo só ficaria selecionável depois de
  // abrir alguma outra tela que chame preencherSelectCartoes() por acaso.
  preencherSelectCartoes();
}

// Garante que existe um lançamento genérico "Importado do banco" pro tipo
// pedido (Entrada ou Saída) — reaproveita se já existe um com esse nome E
// esse tipo, senão cria. É pra onde vão transações importadas sem categoria
// própria; o usuário edita a movimentação normalmente depois pra recategorizar.
async function garantirLancamentoImportado(tipo) {
  const nome = "Importado do banco";
  const existente = STATE.lancamentos.find((l) => l.nome === nome && l.tipo === tipo);
  if (existente) return existente.id;
  const ref = await addDoc(collection(db, "lancamentos"), {
    nome, tipo, categoria: "Open Finance (a revisar)", createdAt: serverTimestamp()
  });
  return ref.id;
}

// Chave usada pra "lembrar" como uma transação foi categorizada da última
// vez. Prioridade:
//   1) CNPJ do estabelecimento (compra no cartão/débito — o mais confiável);
//   2) documento (CPF/CNPJ) de quem está do outro lado do Pix — pra "entrada"
//      é quem PAGOU, pra "saída" é quem RECEBEU;
//   3) nome dessa mesma contraparte, quando o banco não manda o documento;
//   4) descrição normalizada, como último recurso.
// O passo 2/3 existe por causa do Pix: a Pluggy muitas vezes manda uma
// descrição genérica tipo "Pix recebido" sem nome nenhum — usar só a
// descrição faria a regra aprendida pra UMA pessoa (ex: "cigarro") valer
// pra Pix de QUALQUER pessoa. Nome/documento de quem pagou ou recebeu é o
// que de fato identifica "o Pix daquela pessoa".
function chaveCategorizador(t) {
  if (t.merchant && t.merchant.cnpj) return "cnpj:" + t.merchant.cnpj;
  const pd = t.paymentData || {};
  const contraparte = Number(t.amount) < 0 ? pd.receiver : pd.payer;
  if (contraparte) {
    const doc = contraparte.documentNumber || contraparte.document || contraparte.cpfCnpj;
    if (doc) return "doc:" + String(doc).replace(/\D/g, "");
    if (contraparte.name && contraparte.name.trim()) return "pessoa:" + normalizarTexto(contraparte.name);
  }
  const desc = String(t.description || t.descriptionRaw || "").trim().toUpperCase();
  return desc ? "desc:" + desc : null;
}

// Cria ou atualiza a regra "essa chave sempre vira esse lançamento" — chamado
// tanto durante a sincronização (pra aplicar regras já existentes) quanto
// quando o usuário categoriza manualmente uma transação importada (pra
// aprender a regra nova). "descricaoExemplo" é só texto de apoio pra
// reconhecer a regra depois na planilha administrativa.
async function garantirRegraCategorizacao(chave, lancamentoId, descricaoExemplo) {
  if (!chave || !lancamentoId) return;
  const existente = STATE.regrasCategorizacaoOF.find((r) => r.chave === chave);
  if (existente) {
    if (existente.lancamentoId === lancamentoId) return;
    await updateDoc(doc(db, "regrasCategorizacaoOF", existente.id), { lancamentoId, descricaoExemplo: descricaoExemplo || existente.descricaoExemplo, atualizadoEm: serverTimestamp() });
  } else {
    await addDoc(collection(db, "regrasCategorizacaoOF"), { chave, lancamentoId, descricaoExemplo: descricaoExemplo || "", atualizadoEm: serverTimestamp() });
  }
}

// Procura uma movimentação PENDENTE (não paga, ainda não vinda do banco —
// ou seja, lançada manualmente ou por um custo recorrente) do mesmo
// lançamento, com data próxima da transação real (até 7 dias de diferença).
// É o que evita duplicar: em vez de criar uma segunda linha quando o Pix da
// conta de energia cai no banco, o sistema atualiza a que você já tinha
// lançado. "pendentesConsumidos" evita casar duas transações novas com o
// mesmo pendente na mesma sincronização.
function encontrarPendenteParaConciliar(lancamentoId, dataTransacaoStr, pendentesConsumidos) {
  const dataTransacao = parseDataLocal(dataTransacaoStr);
  let melhor = null;
  let menorDiferenca = 8; // dias — fora dessa janela não conta como conciliável
  STATE.movimentacoes.forEach((m) => {
    if (m.origem === "Open Finance") return;
    if (m.pago === true) return;
    if (m.lancamentoId !== lancamentoId) return;
    if (pendentesConsumidos.has(m.id)) return;
    const diferencaDias = Math.abs((parseDataLocal(m.data) - dataTransacao) / 86400000);
    if (diferencaDias <= 7 && diferencaDias < menorDiferenca) {
      melhor = m;
      menorDiferenca = diferencaDias;
    }
  });
  return melhor;
}

// Tira o "N/M" do final da descrição (ex: "SHOPEE *AGAUTO 12/12" vira
// "SHOPEE *AGAUTO") — usado pra agrupar as parcelas da mesma compra, já
// que a Pluggy não manda um identificador único de compra parcelada.
function baseDescricaoParcela(descricao) {
  // Bancos às vezes mandam a mesma compra com espaçamento diferente entre
  // as parcelas (ex: "Shopee *Agauto 11/12" vs "SHOPEE      *AGAUTO
  // 12/12") — colapsa espaços múltiplos em um só antes de comparar, senão
  // o agrupamento não reconhece que é a mesma compra.
  return String(descricao || "")
    .replace(/\s*\d{1,2}\s*\/\s*\d{1,2}\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

// Chave que agrupa todas as parcelas da MESMA compra parcelada: mesma
// conta + mesma descrição-base + mesmo valor de parcela + mesmo total de
// parcelas. Diferente de chaveCategorizador (que muda a cada parcela
// porque o texto "N/M" muda).
function chaveGrupoParcelamento(t, meta) {
  const base = baseDescricaoParcela(t.description || t.descriptionRaw);
  if (!base) return null;
  return [t.accountId, base, Math.abs(arredondar2(Number(t.amount) || 0)), meta.totalInstallments].join("|");
}

// Procura uma "previsão" (parcela futura já criada por uma sincronização
// anterior, ainda não confirmada pelo banco) que corresponda exatamente a
// esse número de parcela dessa compra — é o caso mais preciso de
// conciliação (usa o agrupamento de parcelamento, não o lançamento).
function encontrarPrevisaoParaConciliar(grupoParcelamento, parcelaAtual, pendentesConsumidos) {
  return STATE.movimentacoes.find((m) =>
    m.previsao === true && m.grupoParcelamento === grupoParcelamento &&
    m.parcelaAtual === parcelaAtual && !pendentesConsumidos.has(m.id)
  ) || null;
}

// Gera as parcelas FUTURAS (ainda não pagas) de uma compra parcelada
// detectada no Open Finance — o banco só manda a transação que já
// aconteceu, então sem isso as parcelas seguintes nunca apareceriam em
// Movimentações antes de acontecerem de verdade (diferente do cadastro
// manual de cartão, que já cria todas de uma vez). Cada previsão vira uma
// movimentação PENDENTE normal; quando a parcela real chegar num sync
// futuro, encontrarPrevisaoParaConciliar() casa com ela em vez de duplicar.
// "dataBaseParaProjecao" é opcional — quando o cartão tem ciclo (fechamento/
// vencimento) configurado, as parcelas futuras somam meses a partir da data
// de VENCIMENTO da parcela atual (não da data da compra), pra ficarem
// consistentes com a parcela real. Sem isso (comportamento de sempre),
// projeta a partir da data da própria compra.
function gerarPrevisoesFuturas(batch, t, meta, grupoParcelamento, lancamentoId, conexaoId, conexao, contaTipo, jaExistentesOuCriadas, dataBaseParaProjecao) {
  const valorParcela = Math.abs(arredondar2(Number(t.amount) || 0));
  const base = baseDescricaoParcela(t.description || t.descriptionRaw);
  const dataBaseTransacao = parseDataLocal(dataBaseParaProjecao || String(t.date || "").slice(0, 10));
  for (let n = meta.installmentNumber + 1; n <= meta.totalInstallments; n++) {
    const marcador = grupoParcelamento + "#" + n;
    if (jaExistentesOuCriadas.has(marcador)) continue;
    jaExistentesOuCriadas.add(marcador);
    const dataFutura = new Date(dataBaseTransacao);
    dataFutura.setMonth(dataFutura.getMonth() + (n - meta.installmentNumber));
    // Mesma ideia do ID determinístico acima: evita duplicar a previsão se
    // duas sincronizações rodarem em paralelo.
    const idPrevisao = "prev_" + marcador.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 300);
    const movRef = doc(db, "movimentacoes", idPrevisao);
    batch.set(movRef, {
      lancamentoId, data: formatarDataISO(dataFutura), valor: valorParcela, pago: false,
      origem: "Open Finance", cartaoId: null, compraParceladaId: null,
      pluggyTransactionId: null, conexaoId, instituicao: conexao.instituicao || "Banco", contaTipo,
      revisado: true, previsao: true, descricaoOrigem: `${base} ${n}/${meta.totalInstallments}`,
      chaveCategorizador: null, grupoParcelamento, parcelaAtual: n, parcelaTotal: meta.totalInstallments,
      valorTotalCompra: meta.totalAmount != null ? Number(meta.totalAmount) : null, createdAt: serverTimestamp()
    });
  }
}

// Cria ou atualiza o registro do cartão em cartoesOpenFinance a partir dos
// dados que a própria Pluggy devolve pra uma conta type "CREDIT" — é só
// leitura/espelho do banco, por isso não tem os campos de dia de
// fechamento/vencimento fixos do cadastro manual de cartões (aqui a data
// de fechamento/vencimento já vem calculada pelo banco a cada sincronização).
async function sincronizarCartaoOpenFinance(conexaoId, conexao, conta) {
  const cd = conta.creditData || {};
  const limiteTotal = Number(cd.creditLimit) || 0;
  const limiteUtilizado = Number(conta.balance) || 0;
  const limiteDisponivel = cd.availableCreditLimit != null ? Number(cd.availableCreditLimit) : arredondar2(limiteTotal - limiteUtilizado);
  const dados = {
    conexaoId, instituicao: conexao.instituicao || "Banco", accountId: conta.id,
    nome: conta.marketingName || conta.name || "Cartão", bandeira: cd.brand || "",
    limiteTotal, limiteUtilizado, limiteDisponivel,
    dataFechamento: cd.balanceCloseDate || null, dataVencimento: cd.balanceDueDate || null,
    ultimaSincronizacao: serverTimestamp()
  };
  const existente = STATE.cartoesOpenFinance.find((c) => c.accountId === conta.id);
  if (existente) {
    await updateDoc(doc(db, "cartoesOpenFinance", existente.id), dados);
    return { ...existente, ...dados, id: existente.id };
  } else {
    const ref = await addDoc(collection(db, "cartoesOpenFinance"), dados);
    return { ...dados, id: ref.id, diaFechamentoManual: null, diaVencimentoManual: null };
  }
}

// Descobre o dia de fechamento/vencimento efetivo de um cartão Open
// Finance: prioriza o que o USUÁRIO configurou manualmente (mais
// confiável, já que o banco costuma não informar isso via Open Finance);
// senão, tenta extrair o dia a partir da última data que o banco mandou;
// sem nenhum dos dois, devolve null (não dá pra calcular vencimento).
function diaFechamentoEfetivoOF(cartaoOF) {
  if (!cartaoOF) return null;
  if (cartaoOF.diaFechamentoManual) return Number(cartaoOF.diaFechamentoManual);
  if (cartaoOF.dataFechamento) return parseDataLocal(cartaoOF.dataFechamento).getDate();
  return null;
}
function diaVencimentoEfetivoOF(cartaoOF) {
  if (!cartaoOF) return null;
  if (cartaoOF.diaVencimentoManual) return Number(cartaoOF.diaVencimentoManual);
  if (cartaoOF.dataVencimento) return parseDataLocal(cartaoOF.dataVencimento).getDate();
  return null;
}

// A data que entra em Movimentações pra uma compra no cartão Open Finance é
// a data de VENCIMENTO da fatura que ela cai (mesma regra do cadastro
// manual de cartões) — não a data em que a compra aconteceu. Assim, quando
// você paga a fatura, todas as compras daquele ciclo aparecem juntas na
// mesma data, e "a pagar" reflete o que você realmente vai desembolsar e
// quando. Devolve null se não der pra calcular (sem dia de vencimento
// conhecido, nem informado pelo banco nem cadastrado manualmente) — nesse
// caso quem chama usa a data real da transação como já fazia antes.
function calcularVencimentoCartaoOF(cartaoOF, dataTransacaoStr) {
  const diaVencimento = diaVencimentoEfetivoOF(cartaoOF);
  if (!diaVencimento) return null;
  const diaFechamento = diaFechamentoEfetivoOF(cartaoOF);
  let ano, mes; // mes 0-indexado, já apontando pro ciclo/fatura certo
  if (diaFechamento) {
    const ciclo = calcularCicloInicial(dataTransacaoStr, diaFechamento);
    ano = ciclo.ano; mes = ciclo.mes;
  } else {
    // Sem dia de fechamento conhecido: assume que a compra sempre cai na
    // fatura do mês seguinte (mais seguro que supor "deste mês").
    const d = parseDataLocal(dataTransacaoStr);
    ano = d.getFullYear(); mes = d.getMonth() + 1;
  }
  return calcularProximoVencimento(diaVencimento, new Date(ano, mes, 1));
}

function abrirModalConfigurarCicloOF(id) {
  const c = STATE.cartoesOpenFinance.find((x) => x.id === id);
  if (!c) return mostrarToast("Cartão não encontrado.", true);
  document.getElementById("config-ciclo-of-id").value = c.id;
  document.getElementById("config-ciclo-of-fechamento").value = diaFechamentoEfetivoOF(c) || "";
  document.getElementById("config-ciclo-of-vencimento").value = diaVencimentoEfetivoOF(c) || "";
  document.getElementById("modal-configurar-ciclo-of").classList.add("active");
}
function fecharModalConfigurarCicloOF() {
  document.getElementById("modal-configurar-ciclo-of").classList.remove("active");
}
document.getElementById("btn-cancelar-config-ciclo-of").addEventListener("click", fecharModalConfigurarCicloOF);
document.getElementById("modal-configurar-ciclo-of").addEventListener("click", (e) => {
  if (e.target.id === "modal-configurar-ciclo-of") fecharModalConfigurarCicloOF();
});

document.getElementById("btn-salvar-config-ciclo-of").addEventListener("click", async () => {
  const id = document.getElementById("config-ciclo-of-id").value;
  const diaFechamentoManual = Number(document.getElementById("config-ciclo-of-fechamento").value) || null;
  const diaVencimentoManual = Number(document.getElementById("config-ciclo-of-vencimento").value) || null;
  if (diaVencimentoManual && (diaVencimentoManual < 1 || diaVencimentoManual > 31)) {
    return mostrarToast("Dia de vencimento inválido.", true);
  }
  if (diaFechamentoManual && (diaFechamentoManual < 1 || diaFechamentoManual > 31)) {
    return mostrarToast("Dia de fechamento inválido.", true);
  }
  try {
    await updateDoc(doc(db, "cartoesOpenFinance", id), { diaFechamentoManual, diaVencimentoManual });
    const cartaoAtualizado = { ...STATE.cartoesOpenFinance.find((x) => x.id === id), diaFechamentoManual, diaVencimentoManual };
    fecharModalConfigurarCicloOF();
    const qtd = await recalcularDatasCartaoOF(cartaoAtualizado);
    mostrarToast(qtd ? `Ciclo salvo — ${qtd} movimentação(ões) tiveram a data de vencimento recalculada.` : "Ciclo salvo.");
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
});

// Recalcula, com base no dia de fechamento/vencimento (manual ou vindo do
// banco), a data de vencimento das movimentações de cartão JÁ importadas
// dessa instituição — sem isso, configurar o ciclo só corrigiria as
// próximas sincronizações, deixando o que já está lançado com a data
// antiga (errada). Só toca em transações reais (não em previsões futuras,
// que serão corrigidas naturalmente quando a compra real chegar).
async function recalcularDatasCartaoOF(cartaoOF) {
  const snap = await getDocs(query(
    collection(db, "movimentacoes"),
    where("contaTipo", "==", "cartao"),
    where("origem", "==", "Open Finance"),
    where("instituicao", "==", cartaoOF.instituicao)
  ));
  const batch = writeBatch(db);
  let mudancas = 0;
  snap.docs.forEach((d) => {
    const m = d.data();
    if (m.previsao === true) return;
    const dataBase = m.dataTransacaoReal || m.data;
    const novaData = calcularVencimentoCartaoOF(cartaoOF, dataBase);
    if (novaData && novaData !== m.data) {
      batch.update(doc(db, "movimentacoes", d.id), { data: novaData, dataTransacaoReal: dataBase });
      mudancas++;
    }
  });
  if (mudancas) await batch.commit();
  return mudancas;
}

// Mantém o "pago"/"pendente" de todas as transações de cartão de uma
// instituição em dia sozinho: percorre TODAS as transações de cartão
// daquele banco (vindas do Open Finance) em ordem cronológica e aplica a
// regra que qualquer cartão de crédito usa na prática — cada
// pagamento/estorno (crédito) quita as compras mais antigas em aberto
// primeiro (FIFO), até esgotar o valor do crédito. O que sobrar em aberto é
// a dívida atual real. Só mexe em transações de cartão via Open Finance —
// compras parceladas cadastradas manualmente continuam com o controle
// manual de sempre.
async function aplicarFifoCartao(instituicao) {
  const [movsSnap, lancSnap] = await Promise.all([
    getDocs(query(collection(db, "movimentacoes"), where("contaTipo", "==", "cartao"), where("origem", "==", "Open Finance"), where("instituicao", "==", instituicao))),
    getDocs(collection(db, "lancamentos"))
  ]);
  const mapaLanc = {};
  lancSnap.docs.forEach((d) => (mapaLanc[d.id] = d.data()));

  const todas = movsSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((m) => m.previsao !== true)
    .map((m) => ({ ...m, tipoReal: (mapaLanc[m.lancamentoId] || {}).tipo }))
    // Mesma data: crédito processa antes do débito (não muda o resultado na
    // prática, só deixa o comportamento previsível).
    .sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : (a.tipoReal === "Entrada" ? -1 : 1)));

  const filaDebitos = [];
  const paraPago = new Set();
  todas.forEach((m) => {
    if (m.tipoReal === "Entrada") {
      paraPago.add(m.id);
      let restante = arredondar2(Number(m.valor) || 0);
      while (restante > 0.005 && filaDebitos.length) {
        const proximo = filaDebitos[0];
        if (proximo.valor <= restante + 0.005) {
          paraPago.add(proximo.id);
          restante = arredondar2(restante - proximo.valor);
          filaDebitos.shift();
        } else {
          break; // cobre só parcialmente — não dá pra "meio pagar" uma transação
        }
      }
    } else {
      filaDebitos.push({ id: m.id, valor: Number(m.valor) || 0 });
    }
  });

  const batch = writeBatch(db);
  let mudancas = 0;
  todas.forEach((m) => {
    const deveFicarPago = paraPago.has(m.id);
    if (m.pago !== deveFicarPago) {
      batch.update(doc(db, "movimentacoes", m.id), { pago: deveFicarPago });
      mudancas++;
    }
  });
  if (mudancas) await batch.commit();
  return mudancas;
}

// Aviso de "proxy fora do ar" no auto-sync: uma vez por sessão, pra não empilhar
// um toast por banco conectado toda vez que o app abre.
let avisoProxyMostrado = false;

async function sincronizarConexao(conexaoId, automatica = false) {
  const conexao = STATE.conexoesBancarias.find((c) => c.id === conexaoId);
  if (!conexao) return mostrarToast("Conexão não encontrada.", true);
  try {
    mostrarToast(`Sincronizando ${conexao.instituicao || "banco"}...`);

    const respContas = await chamarProxyPluggy({ action: "listAccounts", itemId: conexao.itemId });
    const contas = respContas.accounts || [];
    if (!contas.length) {
      await updateDoc(doc(db, "conexoesBancarias", conexaoId), { ultimaSincronizacao: serverTimestamp(), status: "conectado" });
      mostrarToast("Nenhuma conta encontrada nesta conexão.");
      return;
    }

    // Cartões de crédito da conexão: atualiza limite/fatura ANTES das
    // transações, independente de ter transação nova ou não. Guarda o
    // cartão mesclado (dados do banco + config manual de ciclo) por
    // accountId, pra calcular a data de vencimento de cada transação logo
    // abaixo.
    const mapaCartaoOFPorConta = {};
    for (const conta of contas) {
      if (conta.type === "CREDIT") mapaCartaoOFPorConta[conta.id] = await sincronizarCartaoOpenFinance(conexaoId, conexao, conta);
    }

    const hoje = new Date();
    const de = new Date(hoje);
    de.setDate(de.getDate() - 90);
    const dataDe = formatarDataISO(de);
    const dataAte = formatarDataISO(hoje);

    // "cartao" vem do type "CREDIT" que a Pluggy devolve pra cartão de
    // crédito — é só uma etiqueta pra filtrar em Movimentações, não tem
    // nenhuma relação com o cadastro manual de cartões (fatura, parcelas
    // etc.) — são dois jeitos independentes de registrar gasto no cartão.
    let todasTransacoes = [];
    for (const conta of contas) {
      const contaTipo = conta.type === "CREDIT" ? "cartao" : "banco";
      const respTrans = await chamarProxyPluggy({ action: "listTransactions", accountId: conta.id, from: dataDe, to: dataAte });
      (respTrans.transactions || []).forEach((t) => { t._contaTipo = contaTipo; });
      todasTransacoes = todasTransacoes.concat(respTrans.transactions || []);
    }

    const jaImportadas = new Set(STATE.movimentacoes.map((m) => m.pluggyTransactionId).filter(Boolean));
    const novas = todasTransacoes.filter((t) => t.id && !jaImportadas.has(t.id));

    if (!novas.length) {
      await updateDoc(doc(db, "conexoesBancarias", conexaoId), { ultimaSincronizacao: serverTimestamp(), status: "conectado" });
      // Reaplica o FIFO mesmo sem transação nova — mantém a situação de
      // pagamento do cartão corrigida sozinha se algo tiver mudado (ex:
      // edição manual) desde a última sincronização.
      if (contas.some((c) => c.type === "CREDIT")) await aplicarFifoCartao(conexao.instituicao);
      mostrarToast("Tudo em dia — nenhuma transação nova.");
      return;
    }

    // Cria (ou reaproveita) os lançamentos genéricos ANTES do lote, pra já
    // ter o ID deles na hora de gravar as movimentações.
    const lancEntradaId = await garantirLancamentoImportado("Entrada");
    const lancSaidaId = await garantirLancamentoImportado("Saida");
    const mapaRegras = {};
    STATE.regrasCategorizacaoOF.forEach((r) => (mapaRegras[r.chave] = r.lancamentoId));
    const pendentesConsumidos = new Set();
    // Marcadores "grupo#parcela" das previsões que já existem no banco de
    // dados — evita recriar a mesma parcela futura a cada sincronização.
    // Marca toda parcela (prevista OU já real) que já existe no banco de
    // dados pra essa compra — cobre tanto "não recriar a mesma previsão
    // de novo" quanto "não prever uma parcela que já chegou de verdade
    // numa sincronização anterior".
    const marcadoresParcelaExistentes = new Set();
    STATE.movimentacoes.forEach((m) => {
      if (m.grupoParcelamento && m.parcelaAtual != null) marcadoresParcelaExistentes.add(m.grupoParcelamento + "#" + m.parcelaAtual);
    });
    // Também marca as parcelas que já vêm como transação REAL nesta mesma
    // sincronização — sem isso, se duas parcelas da mesma compra chegarem
    // juntas (ex: depois de ficar muito tempo sem sincronizar), a mais
    // antiga geraria uma previsão pra parcela que a mais nova já está
    // trazendo de verdade, duplicando.
    novas.forEach((t) => {
      const m = t.creditCardMetadata;
      if (m && m.installmentNumber != null && m.totalInstallments) {
        const g = chaveGrupoParcelamento(t, m);
        if (g) marcadoresParcelaExistentes.add(g + "#" + m.installmentNumber);
      }
    });

    // Reconhecimento de padrões: cria (uma vez) os lançamentos das categorias
    // sugeridas ANTES do lote, pra já ter o ID na hora de gravar.
    const mapaSugestoes = new Map();
    for (const t of novas) {
      const ch = chaveCategorizador(t);
      if (ch && mapaRegras[ch]) continue; // regra aprendida tem prioridade
      const sug = sugerirClassificacao(textoDaTransacao(t), Number(t.amount) < 0 ? "Saida" : "Entrada", t.category);
      if (sug) mapaSugestoes.set(t.id, await garantirLancamentoSugerido(sug));
    }

    let qtdAutoCategorizadas = 0;
    let qtdConciliadas = 0;
    let qtdPrevisoesGeradas = 0;
    const batch = writeBatch(db);
    novas.forEach((t) => {
      const valor = Number(t.amount) || 0;
      const tipo = valor < 0 ? "Saida" : "Entrada";
      const chave = chaveCategorizador(t);
      // Prioridade: regra que você ensinou > padrão reconhecido (Uber, iFood,
      // transferência entre contas suas...) > genérico "a revisar".
      const lancamentoIdRegra = (chave ? mapaRegras[chave] : null) || mapaSugestoes.get(t.id) || null;

      const meta = t.creditCardMetadata;
      const ehParcelaDeCartao = !!(meta && meta.installmentNumber != null && meta.totalInstallments);
      const grupoParcelamento = ehParcelaDeCartao ? chaveGrupoParcelamento(t, meta) : null;
      const dadosParcela = ehParcelaDeCartao ? {
        parcelaAtual: meta.installmentNumber, parcelaTotal: meta.totalInstallments,
        valorTotalCompra: meta.totalAmount != null ? Number(meta.totalAmount) : null
      } : { parcelaAtual: null, parcelaTotal: null, valorTotalCompra: null };

      const dataTransacao = String(t.date || dataAte).slice(0, 10);
      // Pra cartão, o que entra em Movimentações é a data de VENCIMENTO da
      // fatura (mesma regra do cadastro manual de cartões) — não a data em
      // que a compra aconteceu. Assim, pagar a fatura = tudo daquele ciclo
      // aparece junto na mesma data. Guarda a data real da transação à
      // parte (dataTransacaoReal), só pra referência (mostrada como
      // sublabel). Sem dia de vencimento conhecido (cartão sem ciclo
      // configurado nem informado pelo banco), continua igual a sempre foi:
      // usa a data real da transação.
      const cartaoOF = t._contaTipo === "cartao" ? mapaCartaoOFPorConta[t.accountId] : null;
      const vencimentoCalculado = cartaoOF ? calcularVencimentoCartaoOF(cartaoOF, dataTransacao) : null;
      const dataParaMovimentacao = vencimentoCalculado || dataTransacao;

      // Conciliação tem duas formas, da mais precisa pra mais genérica:
      // 1) Essa parcela já tinha sido PREVISTA numa sincronização anterior
      //    (mesmo grupo de compra + mesmo número de parcela) — casa exato.
      // 2) Sem previsão, mas já existe uma regra pra esse estabelecimento —
      //    procura um lançamento pendente (manual ou recorrente) do mesmo
      //    lançamento, com data próxima (até 7 dias), e ATUALIZA ele em vez
      //    de criar outro. Não exige valor igual de propósito — contas como
      //    energia variam de mês a mês; o valor real do banco substitui o
      //    estimado.
      const previsaoCorrespondente = grupoParcelamento
        ? encontrarPrevisaoParaConciliar(grupoParcelamento, meta.installmentNumber, pendentesConsumidos)
        : null;
      const pendente = previsaoCorrespondente || (lancamentoIdRegra
        ? encontrarPendenteParaConciliar(lancamentoIdRegra, dataTransacao, pendentesConsumidos)
        : null);
      if (lancamentoIdRegra) qtdAutoCategorizadas++;

      // Se veio de uma previsão, mantém o lançamento que ela já tinha
      // (herdado da parcela anterior da mesma compra) — senão usa a regra
      // ou cai no genérico de sempre.
      const lancamentoId = (previsaoCorrespondente && previsaoCorrespondente.lancamentoId)
        || lancamentoIdRegra || (tipo === "Saida" ? lancSaidaId : lancEntradaId);

      // "Revisado" só quando já sabemos com confiança do que se trata: veio
      // de uma previsão (herda a categorização já feita na parcela
      // anterior), casou por regra aprendida, ou conciliou com algo que
      // você mesmo já tinha categorizado na mão. Caindo no genérico (sem
      // nenhum desses três), continua "A REVISAR" como sempre foi.
      const jaCategorizadaComConfianca = !!(previsaoCorrespondente || lancamentoIdRegra || pendente);

      // "Pago" significa coisas diferentes pra conta bancária e pra cartão:
      // numa conta, a transação já ter acontecido no extrato JÁ é o
      // dinheiro tendo saído — pago de verdade. No cartão, a compra
      // "acontecer" só quer dizer que ela entrou na fatura; continua em
      // aberto até você realmente pagar a fatura. Por isso cartão sempre
      // entra como PENDENTE aqui (igual o cadastro manual sempre fez),
      // mesmo já tendo acontecido de verdade — você marca como pago
      // quando pagar a fatura.
      const jaPago = t._contaTipo !== "cartao";

      const dadosOpenFinance = {
        origem: "Open Finance", pluggyTransactionId: t.id, conexaoId: conexaoId, instituicao: conexao.instituicao || "Banco",
        contaTipo: t._contaTipo || "banco", revisado: jaCategorizadaComConfianca, previsao: false, descricaoOrigem: t.description || t.descriptionRaw || "",
        dataTransacaoReal: dataTransacao, chaveCategorizador: chave, grupoParcelamento, ...dadosParcela
      };

      if (pendente) {
        pendentesConsumidos.add(pendente.id);
        qtdConciliadas++;
        batch.update(doc(db, "movimentacoes", pendente.id), {
          lancamentoId, pago: jaPago, data: dataParaMovimentacao, valor: Math.abs(arredondar2(valor)), ...dadosOpenFinance
        });
      } else {
        // ID determinístico (baseado no ID da transação na Pluggy) em vez de
        // um ID automático — assim, se duas sincronizações rodarem quase ao
        // mesmo tempo (ex: duas abas abertas), as duas escrevem no MESMO
        // documento em vez de criar duplicata. É o que corrige de vez a
        // condição de corrida que a checagem "já existe no STATE local" não
        // pegava quando as sincronizações eram simultâneas.
        const movRef = doc(db, "movimentacoes", "of_" + t.id);
        batch.set(movRef, {
          lancamentoId, data: dataParaMovimentacao, valor: Math.abs(arredondar2(valor)), pago: jaPago,
          cartaoId: null, compraParceladaId: null, ...dadosOpenFinance, createdAt: serverTimestamp()
        });
      }

      // Compra parcelada com parcelas ainda por vir: gera as previstas que
      // ainda não existem, pra aparecerem como PENDENTE em Movimentações já
      // agora, em vez de só quando cada uma acontecer de verdade. Usa a
      // data de vencimento (não a da compra) como base pra somar os meses,
      // senão as parcelas futuras cairiam no dia da compra, não no dia
      // certo da fatura.
      if (ehParcelaDeCartao && meta.totalInstallments > meta.installmentNumber) {
        qtdPrevisoesGeradas += meta.totalInstallments - meta.installmentNumber;
        gerarPrevisoesFuturas(batch, t, meta, grupoParcelamento, lancamentoId, conexaoId, conexao, t._contaTipo || "cartao", marcadoresParcelaExistentes, dataParaMovimentacao);
      }
    });
    batch.update(doc(db, "conexoesBancarias", conexaoId), { ultimaSincronizacao: serverTimestamp(), status: "conectado" });
    await batch.commit();

    // Reaplica o FIFO do cartão depois de gravar tudo — cobre tanto
    // pagamentos novos quitando compras antigas quanto ajustes que a
    // sincronização acabou de fazer.
    const temCartao = contas.some((c) => c.type === "CREDIT");
    const qtdFifoAjustadas = temCartao ? await aplicarFifoCartao(conexao.instituicao) : 0;

    const partesResumo = [];
    if (qtdConciliadas) partesResumo.push(`${qtdConciliadas} conciliada(s) com lançamento(s) pendente(s)`);
    if (qtdAutoCategorizadas - qtdConciliadas > 0) partesResumo.push(`${qtdAutoCategorizadas - qtdConciliadas} categorizada(s) automaticamente por regra`);
    if (qtdPrevisoesGeradas) partesResumo.push(`${qtdPrevisoesGeradas} parcela(s) futura(s) prevista(s)`);
    if (qtdFifoAjustadas) partesResumo.push(`${qtdFifoAjustadas} situação(ões) de pagamento do cartão ajustada(s) automaticamente`);
    const sufixo = partesResumo.length ? ` (${partesResumo.join(", ")})` : "";
    mostrarToast(`${novas.length} transação(ões) importada(s) de ${conexao.instituicao || "banco"}${sufixo}. Recategorize em Movimentações se quiser.`);
  } catch (err) {
    if (err.proxyIndisponivel) {
      // O problema é o serviço intermediário, não o banco: não marca a
      // conexão como ERRO (ela continua válida assim que o proxy voltar).
      if (!automatica || !avisoProxyMostrado) mostrarToast(err.message, true);
      avisoProxyMostrado = true;
      return;
    }
    mostrarToast("Não foi possível sincronizar: " + err.message, true);
    try { await updateDoc(doc(db, "conexoesBancarias", conexaoId), { status: "erro" }); } catch (err2) { /* ignora falha secundária */ }
  }
}

const btnConectarBanco = document.getElementById("btn-conectar-banco");
if (btnConectarBanco) {
  btnConectarBanco.addEventListener("click", async () => {
    try {
      const resp = await chamarProxyPluggy({ action: "connectToken" });
      if (!resp.connectToken) throw new Error("Token de conexão não recebido.");
      if (typeof window.PluggyConnect === "undefined") {
        throw new Error("Widget da Pluggy Connect não carregou — confira o <script> no index.html.");
      }
      const pluggyConnect = new window.PluggyConnect({
        connectToken: resp.connectToken,
        // Sandbox da Pluggy (plano gratuito) só conecta a bancos de teste —
        // troque pra false só depois de migrar pra uma conta de produção
        // (veja o README, seção "Conexões Bancárias").
        includeSandbox: true,
        onSuccess: async (itemData) => {
          try {
            const item = (itemData && itemData.item) || {};
            const instituicao = (item.connector && item.connector.name) || "Banco conectado";
            const ref = await addDoc(collection(db, "conexoesBancarias"), {
              itemId: item.id, instituicao, status: "conectado", ultimaSincronizacao: null,
              ativoParaPessoal: true, createdAt: serverTimestamp()
            });
            mostrarToast("Banco conectado! Importando as transações...");
            await sincronizarConexao(ref.id);
          } catch (err) {
            mostrarToast("Banco conectado, mas não foi possível salvar a conexão: " + err.message, true);
          }
        },
        onError: () => mostrarToast("Não foi possível conectar o banco. Tente novamente.", true)
      });
      pluggyConnect.init();
    } catch (err) {
      mostrarToast("Não foi possível iniciar a conexão bancária: " + err.message, true);
    }
  });
}

/* ══════════════ CONFIGURAÇÕES ══════════════ */

document.getElementById("btn-salvar-config").addEventListener("click", async () => {
  const rendaMensal = Number(document.getElementById("cfg-renda").value) || 0;
  const saldoInicial = Number(document.getElementById("cfg-saldo").value) || 0;
  const metaGuardarMes = Number(document.getElementById("cfg-meta-guardar").value) || 0;
  try {
    await setDoc(doc(db, "config", "geral"), { rendaMensal, saldoInicial, metaGuardarMes }, { merge: true });
    mostrarToast("Configurações salvas!");
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
});

/* ══════════════ ZERAR / ARQUIVAR CONTROLE FINANCEIRO ══════════════ */

// Zerar aqui NUNCA é "sumir com o dado": cada registro apagado é copiado
// antes pra coleção "arquivo", com o id da limpeza (resetId) que o gerou.
// Assim dá pra recomeçar do zero e ainda consultar o passado no botão
// "Ver dados arquivados". O "historico" continua intocado — as regras do
// Firestore nem deixam apagar de lá.
const COLECOES_RESET = [
  { checkbox: "reset-movimentacoes", colecao: "movimentacoes", rotulo: "Movimentações", stateKey: "movimentacoes", porData: true },
  { checkbox: "reset-compras", colecao: "comprasParceladas", rotulo: "Compras parceladas", stateKey: "comprasParceladas" },
  { checkbox: "reset-recorrentes", colecao: "recorrentes", rotulo: "Custos recorrentes", stateKey: "recorrentes" },
  { checkbox: "reset-listaCompras", colecao: "listaCompras", rotulo: "Lista de compras", stateKey: "listaCompras" },
  { checkbox: "reset-planos", colecao: "planos", rotulo: "Planos", stateKey: "planos" },
  { checkbox: "reset-dinheiroExtra", colecao: "dinheiroExtra", rotulo: "Dinheiro extra", stateKey: "dinheiroExtra" },
  { checkbox: "reset-cartoes", colecao: "cartoes", rotulo: "Cartões", stateKey: "cartoes" },
  { checkbox: "reset-lancamentos", colecao: "lancamentos", rotulo: "Lançamentos", stateKey: "lancamentos" }
];

function statusReset(texto) {
  document.getElementById("reset-status").textContent = texto;
}

document.getElementById("btn-zerar-sistema").addEventListener("click", async () => {
  const confirmacao = document.getElementById("reset-confirmacao").value.trim().toUpperCase();
  if (confirmacao !== "ZERAR") {
    return mostrarToast('Digite ZERAR no campo de confirmação para prosseguir.', true);
  }

  const ateData = document.getElementById("reset-ate-data").value;
  const zerarConfig = document.getElementById("reset-config").checked;
  const escolhidas = COLECOES_RESET.filter((c) => document.getElementById(c.checkbox).checked);
  if (!escolhidas.length && !zerarConfig) return mostrarToast("Marque pelo menos uma coisa para zerar.", true);

  // Monta o que será apagado, respeitando o corte por data quando houver.
  const plano = escolhidas.map((c) => {
    let itens = STATE[c.stateKey] || [];
    if (ateData && c.porData) itens = itens.filter((m) => String(m.data || "") <= ateData);
    return { ...c, itens };
  }).filter((c) => c.itens.length);

  const total = plano.reduce((s, c) => s + c.itens.length, 0);
  if (!total && !zerarConfig) return mostrarToast("Nada a apagar com essas opções.", true);

  const resumo = plano.map((c) => `${c.itens.length} ${c.rotulo.toLowerCase()}`).join(", ");
  const textoData = ateData ? ` com data até ${dataBR(ateData)}` : "";
  if (!confirm(`Isso vai arquivar e apagar: ${resumo || "(só as configurações)"}${textoData}.\n\nOs dados continuam consultáveis em "Ver dados arquivados". Confirmar?`)) return;

  const btn = document.getElementById("btn-zerar-sistema");
  btn.disabled = true;
  statusReset("Arquivando…");

  const resetId = "reset_" + Date.now();
  const quando = new Date().toISOString();

  try {
    let feitos = 0;
    for (const c of plano) {
      // 1) Copia pro arquivo, 2) apaga da coleção original. Em lotes de 200
      // registros (cada um gasta 2 operações e o writeBatch aceita 500).
      for (let i = 0; i < c.itens.length; i += 200) {
        const fatia = c.itens.slice(i, i + 200);
        const batch = writeBatch(db);
        fatia.forEach((item) => {
          const { id, ...dados } = item;
          batch.set(doc(collection(db, "arquivo")), {
            resetId, arquivadoEm: quando, colecaoOrigem: c.colecao,
            idOriginal: id, dados: JSON.parse(JSON.stringify(dados))
          });
          batch.delete(doc(db, c.colecao, id));
        });
        await batch.commit();
        feitos += fatia.length;
        statusReset(`Arquivando… ${feitos} de ${total}`);
      }
    }

    if (zerarConfig) {
      await setDoc(doc(db, "config", "geral"), { rendaMensal: 0, saldoInicial: 0, metaGuardarMes: 0 }, { merge: true });
    }

    // Ficha da limpeza, pro filtro do modal de arquivo.
    await setDoc(doc(db, "resets", resetId), {
      quando, total, ateData: ateData || null, zerouConfig: zerarConfig,
      resumo: resumo || "só as configurações",
      colecoes: plano.map((c) => c.colecao)
    });

    // Registro permanente no Histórico (que nunca é apagado).
    await addDoc(collection(db, "historico"), {
      nomeLancamento: "Sistema", campo: "Zerar controle financeiro",
      valorAnterior: resumo || "configurações", valorNovo: `arquivado em ${resetId}`,
      tipoAlteracao: "Reset", dataHora: serverTimestamp()
    });

    document.getElementById("reset-confirmacao").value = "";
    statusReset(`Pronto — ${total} registro(s) arquivado(s) e removido(s) em ${new Date().toLocaleString("pt-BR")}.`);
    mostrarToast(`Sistema zerado. ${total} registro(s) guardado(s) no arquivo.`);
  } catch (err) {
    statusReset("");
    mostrarToast("Não foi possível zerar: " + err.message, true);
  } finally {
    btn.disabled = false;
  }
});

/* ══════════════ CONSULTA AO ARQUIVO ══════════════ */

// O arquivo não fica em memória o tempo todo (pode ser grande e não entra em
// nenhum cálculo) — é lido sob demanda, só quando o modal abre.
// Retenção: itens arquivados (e a ficha de cada limpeza) valem por 90 dias e
// depois são APAGADOS DE VEZ, pra não inchar o banco. Roda sozinho ao abrir o
// app (site estático, sem servidor) e também antes de abrir "Ver dados
// arquivados". Datas ficam em ISO, então a comparação por texto é segura.
const DIAS_RETENCAO_ARQUIVO = 90;

async function limparArquivoAntigo() {
  const corte = new Date(Date.now() - DIAS_RETENCAO_ARQUIVO * 86400000).toISOString();
  let apagados = 0;
  try {
    for (const alvo of [{ nome: "arquivo", campo: "arquivadoEm" }, { nome: "resets", campo: "quando" }]) {
      const snap = await getDocs(query(collection(db, alvo.nome), where(alvo.campo, "<", corte)));
      for (let i = 0; i < snap.docs.length; i += 400) {
        const batch = writeBatch(db);
        snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
      apagados += snap.docs.length;
    }
    if (apagados) {
      arquivoCarregado = arquivoCarregado.filter((a) => String(a.arquivadoEm || "") >= corte);
      console.log(`[arquivo] ${apagados} registro(s) com mais de ${DIAS_RETENCAO_ARQUIVO} dias apagado(s) permanentemente.`);
    }
  } catch (err) {
    console.warn("[arquivo] não foi possível limpar registros antigos:", err.message);
  }
}
setTimeout(limparArquivoAntigo, 5000);

let arquivoCarregado = [];
let resetsCarregados = [];

async function abrirModalArquivo() {
  document.getElementById("modal-arquivo").classList.add("active");
  document.getElementById("arquivo-body").innerHTML = '<tr><td colspan="7" class="empty">Carregando…</td></tr>';
  try {
    await limparArquivoAntigo();
    const [snapArquivo, snapResets] = await Promise.all([
      getDocs(collection(db, "arquivo")),
      getDocs(collection(db, "resets"))
    ]);
    arquivoCarregado = snapArquivo.docs.map((d) => ({ id: d.id, ...d.data() }));
    resetsCarregados = snapResets.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(b.quando).localeCompare(String(a.quando)));

    const sel = document.getElementById("arquivo-filtro-reset");
    sel.innerHTML = '<option value="">Todas as limpezas</option>' +
      resetsCarregados.map((r) => {
        const quando = r.quando ? new Date(r.quando).toLocaleString("pt-BR") : r.id;
        return `<option value="${esc(r.id)}">${esc(quando)} — ${esc(r.resumo || "")}</option>`;
      }).join("");

    renderArquivo();
  } catch (err) {
    document.getElementById("arquivo-body").innerHTML =
      `<tr><td colspan="7" class="empty">Não foi possível ler o arquivo: ${esc(err.message)}</td></tr>`;
  }
}

function itensArquivoFiltrados() {
  const filtro = document.getElementById("arquivo-filtro-reset").value;
  const lista = filtro ? arquivoCarregado.filter((a) => a.resetId === filtro) : arquivoCarregado;
  // Mais recente primeiro; dentro da mesma limpeza, pela data do registro.
  return [...lista].sort((a, b) =>
    String(b.arquivadoEm || "").localeCompare(String(a.arquivadoEm || "")) ||
    String((b.dados || {}).data || "").localeCompare(String((a.dados || {}).data || ""))
  );
}

// Nome amigável de um registro arquivado: usa o lançamento quando ele ainda
// existe, senão cai pra descrição original do banco ou pro nome do item.
function descricaoArquivo(item) {
  const d = item.dados || {};
  const l = d.lancamentoId ? mapaLancamentos()[d.lancamentoId] : null;
  return l ? l.nome : (d.nome || d.descricao || d.descricaoOrigem || "(sem descrição)");
}

const ROTULO_COLECAO = {
  movimentacoes: "Movimentação", comprasParceladas: "Compra parcelada", recorrentes: "Recorrente",
  listaCompras: "Lista de compras", planos: "Plano", dinheiroExtra: "Dinheiro extra", cartoes: "Cartão", lancamentos: "Lançamento"
};

function renderArquivo() {
  const itens = itensArquivoFiltrados();
  document.getElementById("arquivo-contador").textContent = `${itens.length} registro(s)`;
  const body = document.getElementById("arquivo-body");
  if (!itens.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">Nenhum dado arquivado ainda.</td></tr>';
    return;
  }
  // Teto de exibição: o resto sai no CSV, pra não travar a tela com milhares
  // de linhas de uma vez.
  body.innerHTML = itens.slice(0, 500).map((a) => {
    const d = a.dados || {};
    const quando = a.arquivadoEm ? new Date(a.arquivadoEm).toLocaleDateString("pt-BR") : "—";
    const situacao = typeof d.pago === "boolean"
      ? `<span class="stamp ${d.pago ? "pago" : "pendente"}">${d.pago ? "PAGO" : "PENDENTE"}</span>` : "—";
    return `<tr><td>${esc(quando)}</td><td>${esc(ROTULO_COLECAO[a.colecaoOrigem] || a.colecaoOrigem)}</td>` +
      `<td>${d.data ? dataBR(d.data) : "—"}</td><td>${esc(descricaoArquivo(a))}</td>` +
      `<td class="num">${d.valor != null ? moeda(d.valor) : (d.valorTotal != null ? moeda(d.valorTotal) : "—")}</td>` +
      `<td>${situacao}</td><td>${esc(a.arquivadoEm ? new Date(new Date(a.arquivadoEm).getTime() + DIAS_RETENCAO_ARQUIVO * 86400000).toLocaleDateString("pt-BR") : "—")}</td></tr>`;
  }).join("") + (itens.length > 500
    ? `<tr><td colspan="7" class="empty">Mostrando os 500 mais recentes de ${itens.length}. Use "Baixar arquivo em CSV" para ver tudo.</td></tr>`
    : "");
}

/* ══════════════ RESETAR TUDO (inclui o Histórico) ══════════════ */

// Mesma lógica de arquivar-antes-de-apagar do "Zerar controle financeiro",
// mas sem checkboxes: apaga TODAS as coleções de uma vez, sem corte por
// data, e inclui o Histórico — que o botão acima nunca apaga. É o botão
// "começar do zero de verdade".
const COLECOES_RESET_TUDO = [
  { colecao: "movimentacoes", stateKey: "movimentacoes", rotulo: "Movimentações" },
  { colecao: "comprasParceladas", stateKey: "comprasParceladas", rotulo: "Compras parceladas" },
  { colecao: "recorrentes", stateKey: "recorrentes", rotulo: "Custos recorrentes" },
  { colecao: "listaCompras", stateKey: "listaCompras", rotulo: "Lista de compras" },
  { colecao: "planos", stateKey: "planos", rotulo: "Planos" },
  { colecao: "dinheiroExtra", stateKey: "dinheiroExtra", rotulo: "Dinheiro extra" },
  { colecao: "cartoes", stateKey: "cartoes", rotulo: "Cartões" },
  { colecao: "lancamentos", stateKey: "lancamentos", rotulo: "Lançamentos" },
  { colecao: "historico", stateKey: "historico", rotulo: "Histórico de Alterações" }
];

document.getElementById("btn-resetar-tudo").addEventListener("click", async () => {
  const confirmacao = document.getElementById("resettudo-confirmacao").value.trim().toUpperCase();
  if (confirmacao !== "RESETAR TUDO") {
    return mostrarToast("Digite RESETAR TUDO no campo de confirmação para prosseguir.", true);
  }
  if (!confirm('Isso vai apagar TUDO — todas as movimentações, compras, recorrentes, lista de compras, planos, cartões, lançamentos, configurações e o Histórico de Alterações — pra você começar do zero. Os dados continuam consultáveis em "Ver dados arquivados". Confirmar?')) return;

  const btn = document.getElementById("btn-resetar-tudo");
  btn.disabled = true;
  const statusEl = document.getElementById("resettudo-status");
  statusEl.textContent = "Arquivando…";

  const resetId = "reset_total_" + Date.now();
  const quando = new Date().toISOString();
  const totalGeral = COLECOES_RESET_TUDO.reduce((s, c) => s + (STATE[c.stateKey] || []).length, 0);

  try {
    let feitos = 0;
    for (const c of COLECOES_RESET_TUDO) {
      const itens = STATE[c.stateKey] || [];
      for (let i = 0; i < itens.length; i += 200) {
        const fatia = itens.slice(i, i + 200);
        const batch = writeBatch(db);
        fatia.forEach((item) => {
          const { id, ...dados } = item;
          batch.set(doc(collection(db, "arquivo")), {
            resetId, arquivadoEm: quando, colecaoOrigem: c.colecao,
            idOriginal: id, dados: JSON.parse(JSON.stringify(dados))
          });
          batch.delete(doc(db, c.colecao, id));
        });
        await batch.commit();
        feitos += fatia.length;
        statusEl.textContent = `Arquivando… ${feitos} de ${totalGeral}`;
      }
    }

    await setDoc(doc(db, "config", "geral"), { rendaMensal: 0, saldoInicial: 0, metaGuardarMes: 0 }, { merge: true });

    await setDoc(doc(db, "resets", resetId), {
      quando, total: totalGeral, ateData: null, zerouConfig: true, tipo: "total",
      resumo: "reset total — tudo, incluindo o Histórico",
      colecoes: COLECOES_RESET_TUDO.map((c) => c.colecao)
    });

    // Primeiro (e único) registro da nova base — marca o dia em que
    // recomeçou. Vem depois de apagar o histórico antigo de propósito.
    await addDoc(collection(db, "historico"), {
      nomeLancamento: "Sistema", campo: "Reset total",
      valorAnterior: `${totalGeral} registro(s) de todas as coleções`,
      valorNovo: `arquivado em ${resetId} — nova base a partir de agora`,
      tipoAlteracao: "Reset total", dataHora: serverTimestamp()
    });

    document.getElementById("resettudo-confirmacao").value = "";
    statusEl.textContent = `Pronto — sistema resetado por completo em ${new Date().toLocaleString("pt-BR")}. ${totalGeral} registro(s) arquivado(s).`;
    mostrarToast("Sistema resetado! Base limpa a partir de agora.");
  } catch (err) {
    statusEl.textContent = "";
    mostrarToast("Não foi possível resetar: " + err.message, true);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("btn-ver-arquivo").addEventListener("click", abrirModalArquivo);
document.getElementById("arquivo-filtro-reset").addEventListener("change", renderArquivo);
document.getElementById("btn-fechar-arquivo").addEventListener("click", () => {
  document.getElementById("modal-arquivo").classList.remove("active");
});
document.getElementById("modal-arquivo").addEventListener("click", (e) => {
  if (e.target.id === "modal-arquivo") document.getElementById("modal-arquivo").classList.remove("active");
});

document.getElementById("btn-baixar-arquivo").addEventListener("click", async () => {
  if (!arquivoCarregado.length) {
    try {
      const snap = await getDocs(collection(db, "arquivo"));
      arquivoCarregado = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    } catch (err) {
      return mostrarToast("Não foi possível ler o arquivo: " + err.message, true);
    }
  }
  if (!arquivoCarregado.length) return mostrarToast("Não há nada arquivado ainda.");

  const linhas = [["Arquivado em", "Limpeza", "Tipo", "Data", "Descrição", "Valor", "Situação", "Banco"]];
  arquivoCarregado.forEach((a) => {
    const d = a.dados || {};
    linhas.push([
      a.arquivadoEm ? new Date(a.arquivadoEm).toLocaleString("pt-BR") : "",
      a.resetId || "", ROTULO_COLECAO[a.colecaoOrigem] || a.colecaoOrigem || "",
      d.data || "", descricaoArquivo(a),
      d.valor != null ? d.valor : (d.valorTotal != null ? d.valorTotal : ""),
      typeof d.pago === "boolean" ? (d.pago ? "Pago" : "Pendente") : "",
      d.instituicao || ""
    ]);
  });
  // Ponto e vírgula + BOM: é o que o Excel em português abre sem bagunçar.
  const csv = "\uFEFF" + linhas.map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `arquivo-financeiro-${formatarDataISO(new Date())}.csv`;
  link.click();
  URL.revokeObjectURL(url);
});

/* ══════════════ RECONHECIMENTO AUTOMÁTICO DE CATEGORIA ══════════════ */

// Regras em ordem: a primeira que casar vence (por isso "Mercado Livre"
// vem antes de "Mercado"). Casa por palavra inteira, sem acento/maiúscula.
// Ordem importa: "UBER EATS" (Alimentação) e "AMAZON PRIME" (Assinaturas) precisam vir
// antes de "UBER" (Transporte) e "AMAZON" (Compras).
const REGRAS_CATEGORIA = [
  { tipo: "Saida", nome: "Assinaturas", categoria: "Assinaturas", padroes: ["NETFLIX", "SPOTIFY", "AMAZON PRIME", "PRIME VIDEO", "DISNEY", "HBO MAX", "HBO", "YOUTUBE", "APPLE COM BILL", "GOOGLE ONE", "DEEZER", "GLOBOPLAY", "PARAMOUNT", "CRUNCHYROLL"] },
  { tipo: "Saida", nome: "Compras online", categoria: "Compras", padroes: ["MERCADO LIVRE", "MERCADOLIVRE", "AMAZON", "SHOPEE", "MAGALU", "MAGAZINE LUIZA", "SHEIN", "ALIEXPRESS", "AMERICANAS", "KABUM", "CASAS BAHIA"] },
  { tipo: "Saida", nome: "Alimentação", categoria: "Alimentação", padroes: ["IFOOD", "I FOOD", "RAPPI", "UBER EATS", "UBEREATS", "MCDONALDS", "MCDONALD", "BURGER KING", "SUBWAY", "OUTBACK", "RESTAURANTE", "LANCHONETE", "PADARIA", "PIZZARIA", "PIZZA", "ACAI", "SORVETERIA", "CAFETERIA", "SUPERMERCADO", "MERCADO", "MERCADINHO", "ATACADAO", "ASSAI", "CARREFOUR", "PAO DE ACUCAR", "HAMBURGUERIA", "HORTIFRUTI", "ACOUGUE"] },
  { tipo: "Saida", nome: "Transporte", categoria: "Transporte", padroes: ["UBER", "UBER TRIP", "99 POP", "99POP", "99 TAXI", "CABIFY", "INDRIVE", "IN DRIVE", "POSTO", "SHELL", "IPIRANGA", "PETROBRAS", "ESTACIONAMENTO", "PEDAGIO", "SEM PARAR", "CONECTCAR", "VELOE", "BILHETE UNICO", "CPTM", "TAXI"] },
  { tipo: "Saida", nome: "Saúde", categoria: "Saúde", padroes: ["FARMACIA", "DROGARIA", "DROGASIL", "DROGA RAIA", "PAGUE MENOS", "HOSPITAL", "CLINICA", "LABORATORIO", "ODONTO", "DENTISTA", "UNIMED"] },
  { tipo: "Saida", nome: "Contas da casa", categoria: "Moradia", padroes: ["ENEL", "LIGHT", "CEMIG", "SABESP", "COPASA", "CLARO", "VIVO", "TIM", "OI FIBRA", "NET CLARO", "ALUGUEL", "CONDOMINIO", "ENERGIA", "AGUA", "INTERNET"] },
  { tipo: "Saida", nome: "Educação", categoria: "Educação", padroes: ["UDEMY", "ALURA", "ESCOLA", "FACULDADE", "CURSO", "UNIVERSIDADE"] },
  { tipo: "Entrada", nome: "Salário", categoria: "Salário", padroes: ["SALARIO", "FOLHA DE PAGAMENTO", "PAGAMENTO DE SALARIO"] },
  { tipo: "Entrada", nome: "Reembolso", categoria: "Reembolso", padroes: ["REEMBOLSO", "ESTORNO", "CASHBACK"] }
];

// Categorias que o próprio banco (Pluggy) manda, usadas só quando nenhum
// padrão acima casou. Comparação por trecho, em minúsculas.
const DICAS_CATEGORIA_BANCO = [
  { trechos: ["ride", "taxi", "transport", "fuel", "parking", "toll"], regra: "Transporte" },
  { trechos: ["restaurant", "eating", "food", "grocer", "supermarket", "delivery"], regra: "Alimentação" },
  { trechos: ["pharmac", "health", "medical"], regra: "Saúde" },
  { trechos: ["subscription", "streaming"], regra: "Assinaturas" },
  { trechos: ["shopping", "online purchase"], regra: "Compras online" }
];

function normalizarTexto(v) {
  return String(v || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

// Seus nomes como aparecem nos Pix. Padrão: o nome que você informou.
function nomesProprios() {
  const cfg = STATE.config && STATE.config.nomesProprios;
  if (Array.isArray(cfg)) return cfg;
  if (typeof cfg === "string" && cfg.trim()) return cfg.split(",").map((x) => x.trim()).filter(Boolean);
  return ["LEONARDO DA SILVA LINS"];
}

function textoDaTransacao(t) {
  const pd = t.paymentData || {};
  const nomes = [t.description, t.descriptionRaw, t.merchant && (t.merchant.name || t.merchant.businessName),
    pd.receiver && pd.receiver.name, pd.payer && pd.payer.name];
  return nomes.filter(Boolean).join(" ");
}

// Devolve { chave, nome, categoria, tipo } ou null (→ vai pra revisão).
// "tipo" aqui é o tipo do LANÇAMENTO a usar: Entrada, Saida ou Transferencia.
function sugerirClassificacao(texto, tipoMov, categoriaBanco) {
  const t = " " + normalizarTexto(texto) + " ";
  if (t.trim() === "") return null;

  // 1) Mandou de uma conta sua pra outra conta sua: não é ganho nem gasto.
  const meus = nomesProprios().map(normalizarTexto).filter(Boolean);
  if (meus.some((n) => t.includes(" " + n + " ")) || /same person/i.test(String(categoriaBanco || ""))) {
    return { chave: "transferencia-propria", nome: "Transferência entre minhas contas", categoria: "Transferência", tipo: "Transferencia" };
  }

  // 2) Padrões conhecidos.
  const regra = REGRAS_CATEGORIA.find((r) => r.tipo === tipoMov && r.padroes.some((p) => t.includes(" " + normalizarTexto(p) + " ")));
  if (regra) return { chave: regra.nome + "|" + regra.tipo, nome: regra.nome, categoria: regra.categoria, tipo: regra.tipo };

  // 3) Dica da categoria que o banco mandou (só pra saídas).
  if (tipoMov === "Saida" && categoriaBanco) {
    const cat = String(categoriaBanco).toLowerCase();
    const dica = DICAS_CATEGORIA_BANCO.find((d) => d.trechos.some((x) => cat.includes(x)));
    const r = dica && REGRAS_CATEGORIA.find((x) => x.nome === dica.regra && x.tipo === "Saida");
    if (r) return { chave: r.nome + "|" + r.tipo, nome: r.nome, categoria: r.categoria, tipo: r.tipo };
  }
  return null; // não reconheceu → fica "A REVISAR"
}

// Reaproveita um lançamento existente (mesmo nome+tipo, senão mesma
// categoria+tipo) ou cria um novo — assim a rosca agrupa tudo junto.
const lancamentosSugeridosCriados = new Map();
async function garantirLancamentoSugerido(sug) {
  const achado = STATE.lancamentos.find((l) => l.nome === sug.nome && l.tipo === sug.tipo)
    || STATE.lancamentos.find((l) => l.categoria === sug.categoria && l.tipo === sug.tipo);
  if (achado) return achado.id;
  const cacheKey = sug.nome + "|" + sug.tipo;
  if (lancamentosSugeridosCriados.has(cacheKey)) return lancamentosSugeridosCriados.get(cacheKey);
  const ref = await addDoc(collection(db, "lancamentos"), { nome: sug.nome, tipo: sug.tipo, categoria: sug.categoria, createdAt: serverTimestamp() });
  lancamentosSugeridosCriados.set(cacheKey, ref.id);
  return ref.id;
}

document.getElementById("btn-salvar-nomes").addEventListener("click", async () => {
  const lista = document.getElementById("cfg-nomes-proprios").value.split(",").map((x) => x.trim()).filter(Boolean);
  try {
    await setDoc(doc(db, "config", "geral"), { nomesProprios: lista }, { merge: true });
    mostrarToast("Nomes salvos!");
  } catch (err) { mostrarToast("Não foi possível salvar: " + err.message, true); }
});

// Reaplica o reconhecimento nas movimentações do banco que ainda estão "a
// revisar" e caíram no lançamento genérico.
document.getElementById("btn-reclassificar").addEventListener("click", async () => {
  const status = document.getElementById("reclassificar-status");
  const mapa = mapaLancamentos();
  const alvo = STATE.movimentacoes.filter((m) => m.origem === "Open Finance" && m.previsao !== true && m.revisado !== true
    && (mapa[m.lancamentoId] || {}).nome === "Importado do banco");
  if (!alvo.length) { status.textContent = "Nada a reclassificar."; return; }
  status.textContent = "Reclassificando…";
  try {
    const decisoes = [];
    for (const m of alvo) {
      const tipoMov = (mapa[m.lancamentoId] || {}).tipo === "Entrada" ? "Entrada" : "Saida";
      const sug = sugerirClassificacao(m.descricaoOrigem, tipoMov, null);
      if (sug) decisoes.push({ id: m.id, lancamentoId: await garantirLancamentoSugerido(sug) });
    }
    for (let i = 0; i < decisoes.length; i += 400) {
      const batch = writeBatch(db);
      decisoes.slice(i, i + 400).forEach((d) => batch.update(doc(db, "movimentacoes", d.id), { lancamentoId: d.lancamentoId, revisado: true }));
      await batch.commit();
    }
    status.textContent = `${decisoes.length} reconhecida(s); ${alvo.length - decisoes.length} continuam para você revisar.`;
  } catch (err) { status.textContent = ""; mostrarToast("Não foi possível reclassificar: " + err.message, true); }
});

/* ══════════════ DINHEIRO EXTRA ══════════════ */

function renderDinheiroExtra() {
  const hoje = formatarDataISO(new Date());
  const todos = STATE.dinheiroExtra;
  const soma = (f) => todos.filter(f).reduce((a, e) => a + (Number(e.valor) || 0), 0);
  const aReceber = soma((e) => e.recebido !== true);
  const recebido = soma((e) => e.recebido === true);
  const atrasado = soma((e) => e.recebido !== true && String(e.data || "") < hoje);
  document.getElementById("extra-kpi-grid").innerHTML =
    kpiCard("A receber", moeda(aReceber), true) + kpiCard("Já entrou", moeda(recebido), true) +
    kpiCard("Atrasado (data passou)", moeda(atrasado), atrasado === 0);

  const filtro = document.getElementById("extra-filtro").value;
  const lista = todos
    .filter((e) => !filtro || (filtro === "recebido" ? e.recebido === true : e.recebido !== true))
    .sort((a, b) => String(a.data || "").localeCompare(String(b.data || "")));
  const body = document.getElementById("extra-body");
  if (!lista.length) { body.innerHTML = '<tr><td colspan="5" class="empty">Nenhum dinheiro extra cadastrado.</td></tr>'; return; }
  body.innerHTML = lista.map((e) => {
    const atrasada = e.recebido !== true && String(e.data || "") < hoje;
    const stamp = e.recebido === true ? '<span class="stamp pago" data-alternar-extra="' + e.id + '">JÁ ENTROU</span>'
      : atrasada ? '<span class="stamp pendente" data-alternar-extra="' + e.id + '">ATRASADO</span>'
      : '<span class="stamp andamento" data-alternar-extra="' + e.id + '">A RECEBER</span>';
    return `<tr class="${atrasada ? "linha-atrasada" : ""}"><td>${dataBR(e.data)}</td><td>${esc(e.descricao)}</td>` +
      `<td class="num">${moeda(e.valor)}</td><td>${stamp}</td>` +
      `<td><button class="btn btn-small" data-editar-extra="${e.id}">Editar</button></td></tr>`;
  }).join("");
}

document.getElementById("extra-filtro").addEventListener("change", renderDinheiroExtra);
document.getElementById("extra-body").addEventListener("click", async (ev) => {
  const alt = ev.target.closest("[data-alternar-extra]");
  if (alt) {
    const e = STATE.dinheiroExtra.find((x) => x.id === alt.dataset.alternarExtra);
    if (!e) return;
    try { await updateDoc(doc(db, "dinheiroExtra", e.id), { recebido: e.recebido !== true }); }
    catch (err) { mostrarToast("Não foi possível atualizar: " + err.message, true); }
    return;
  }
  const ed = ev.target.closest("[data-editar-extra]");
  if (ed) abrirModalExtra(ed.dataset.editarExtra);
});

document.getElementById("btn-add-extra").addEventListener("click", async () => {
  const descricao = document.getElementById("extra-descricao").value.trim();
  const valor = Number(document.getElementById("extra-valor").value);
  const data = document.getElementById("extra-data").value;
  const recebido = document.getElementById("extra-recebido").value === "true";
  if (!descricao || !valor || valor <= 0 || !data) return mostrarToast("Preencha descrição, valor e data prevista.", true);
  try {
    await addDoc(collection(db, "dinheiroExtra"), { descricao, valor, data, recebido, createdAt: serverTimestamp() });
    ["extra-descricao", "extra-valor"].forEach((id) => (document.getElementById(id).value = ""));
    mostrarToast("Dinheiro extra adicionado!");
  } catch (err) { mostrarToast("Não foi possível salvar: " + err.message, true); }
});

function abrirModalExtra(id) {
  const e = STATE.dinheiroExtra.find((x) => x.id === id);
  if (!e) return;
  document.getElementById("edit-extra-id").value = e.id;
  document.getElementById("edit-extra-descricao").value = e.descricao;
  document.getElementById("edit-extra-valor").value = e.valor;
  document.getElementById("edit-extra-data").value = e.data;
  document.getElementById("edit-extra-recebido").value = e.recebido === true ? "true" : "false";
  document.getElementById("modal-extra").classList.add("active");
}
const fecharModalExtra = () => document.getElementById("modal-extra").classList.remove("active");
document.getElementById("btn-cancelar-extra").addEventListener("click", fecharModalExtra);
document.getElementById("modal-extra").addEventListener("click", (e) => { if (e.target.id === "modal-extra") fecharModalExtra(); });
document.getElementById("btn-salvar-extra").addEventListener("click", async () => {
  const id = document.getElementById("edit-extra-id").value;
  const descricao = document.getElementById("edit-extra-descricao").value.trim();
  const valor = Number(document.getElementById("edit-extra-valor").value);
  const data = document.getElementById("edit-extra-data").value;
  const recebido = document.getElementById("edit-extra-recebido").value === "true";
  if (!descricao || !valor || valor <= 0 || !data) return mostrarToast("Preencha descrição, valor e data prevista.", true);
  try { await updateDoc(doc(db, "dinheiroExtra", id), { descricao, valor, data, recebido }); fecharModalExtra(); mostrarToast("Salvo!"); }
  catch (err) { mostrarToast("Não foi possível salvar: " + err.message, true); }
});
document.getElementById("btn-excluir-extra").addEventListener("click", async () => {
  const id = document.getElementById("edit-extra-id").value;
  if (!confirm("Excluir este dinheiro extra?")) return;
  try { await deleteDoc(doc(db, "dinheiroExtra", id)); fecharModalExtra(); mostrarToast("Excluído."); }
  catch (err) { mostrarToast("Não foi possível excluir: " + err.message, true); }
});

/* ══════════════ APARÊNCIA (cores do app) ══════════════ */

const TEMA_PADRAO = { bg: "#F6F4EE", panel: "#FFFFFF", sidebar: "#FFFFFF", ink: "#211C10", accent: "#F5C400" };
const TEMA_PRESETS = {
  dourado: TEMA_PADRAO,
  escuro: { bg: "#0B0B0B", panel: "#161616", sidebar: "#101010", ink: "#F5EFD8", accent: "#FFD21F" },
  neon: { bg: "#050706", panel: "#0D1210", sidebar: "#080C0A", ink: "#E9FFF2", accent: "#39FF14" },
  azul: { bg: "#F4F7FB", panel: "#FFFFFF", sidebar: "#FFFFFF", ink: "#14213D", accent: "#2563EB" }
};
let temaAtual = { ...TEMA_PADRAO };

function luminanciaHex(hex) {
  const n = parseInt(String(hex).replace("#", ""), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function aplicarTema(t) {
  const r = document.documentElement;
  r.style.setProperty("--bg", t.bg);
  r.style.setProperty("--panel", t.panel);
  r.style.setProperty("--ink", t.ink);
  r.style.setProperty("--accent", t.accent);
  r.style.setProperty("--sidebar-bg", t.sidebar);
  r.style.setProperty("--on-accent", luminanciaHex(t.accent) > 0.4 ? "#1A1400" : "#FFFFFF");
  const menuClaro = luminanciaHex(t.sidebar) > 0.4;
  r.style.setProperty("--sidebar-ink", menuClaro ? "#4A4432" : "#D9D9D9");
  r.style.setProperty("--sidebar-accent", menuClaro ? `color-mix(in srgb, ${t.accent} 52%, #211C10)` : t.accent);
  r.style.colorScheme = luminanciaHex(t.bg) < 0.25 ? "dark" : "light";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", t.sidebar);
  [["tema-bg", "bg"], ["tema-panel", "panel"], ["tema-sidebar", "sidebar"], ["tema-ink", "ink"], ["tema-accent", "accent"]]
    .forEach(([id, k]) => { const el = document.getElementById(id); if (el) el.value = t[k]; });
}

function salvarTema(t) {
  temaAtual = { ...t };
  aplicarTema(temaAtual);
  try { localStorage.setItem("finleo-tema", JSON.stringify(temaAtual)); } catch (e) { /* navegador sem storage */ }
}

(function iniciarTema() {
  try {
    const salvo = JSON.parse(localStorage.getItem("finleo-tema") || "null");
    if (salvo && salvo.bg && salvo.accent) temaAtual = { ...TEMA_PADRAO, ...salvo };
  } catch (e) { /* usa o padrão */ }
  aplicarTema(temaAtual);
})();

[["tema-bg", "bg"], ["tema-panel", "panel"], ["tema-sidebar", "sidebar"], ["tema-ink", "ink"], ["tema-accent", "accent"]].forEach(([id, k]) => {
  document.getElementById(id).addEventListener("input", (e) => salvarTema({ ...temaAtual, [k]: e.target.value }));
});
document.querySelectorAll("[data-tema-preset]").forEach((b) => b.addEventListener("click", () => salvarTema(TEMA_PRESETS[b.dataset.temaPreset])));
document.getElementById("btn-tema-restaurar").addEventListener("click", () => salvarTema(TEMA_PADRAO));

/* ══════════════ LISTENERS EM TEMPO REAL ══════════════ */

function iniciarListeners() {
  onSnapshot(query(collection(db, "lancamentos"), orderBy("nome")), (snap) => {
    STATE.lancamentos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAll();
    lancamentosCarregados = true;
    tentarAbrirAcaoRapidaAutomatica();
  }, (err) => mostrarToast("Erro ao carregar lançamentos: " + err.message, true));

  onSnapshot(query(collection(db, "movimentacoes"), orderBy("data", "desc")), (snap) => {
    STATE.movimentacoes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAll();
  }, (err) => mostrarToast("Erro ao carregar movimentações: " + err.message, true));

  onSnapshot(collection(db, "cartoes"), (snap) => {
    STATE.cartoes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderCartoes();
    renderComprasParceladas();
    renderParcelasCartao();
    renderDashboard();
  }, (err) => mostrarToast("Erro ao carregar cartões: " + err.message, true));

  onSnapshot(collection(db, "comprasParceladas"), (snap) => {
    STATE.comprasParceladas = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderComprasParceladas();
    renderParcelasCartao();
    renderMovimentacoes();
    renderContasAPagar();
  }, (err) => mostrarToast("Erro ao carregar compras parceladas: " + err.message, true));

  onSnapshot(collection(db, "recorrentes"), (snap) => {
    STATE.recorrentes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    recorrentesCarregados = true;
    renderRecorrentes();
    tentarAutoLancarRecorrentes();
  }, (err) => mostrarToast("Erro ao carregar recorrentes: " + err.message, true));

  onSnapshot(collection(db, "historico"), (snap) => {
    STATE.historico = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderHistorico();
  }, (err) => mostrarToast("Erro ao carregar histórico: " + err.message, true));

  onSnapshot(collection(db, "dinheiroExtra"), (snap) => {
    STATE.dinheiroExtra = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderDinheiroExtra();
    renderDashboard();
  }, (err) => mostrarToast("Erro ao carregar dinheiro extra: " + err.message, true));

  onSnapshot(collection(db, "planos"), (snap) => {
    STATE.planos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderPlanos();
  }, (err) => mostrarToast("Erro ao carregar planos: " + err.message, true));

  onSnapshot(collection(db, "listaCompras"), (snap) => {
    STATE.listaCompras = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderListaCompras();
  }, (err) => mostrarToast("Erro ao carregar lista de compras: " + err.message, true));

  onSnapshot(collection(db, "conexoesBancarias"), (snap) => {
    STATE.conexoesBancarias = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderConexoes();
    renderMovimentacoes();
    renderDashboard();
    renderContasAPagar();
    // Sincroniza cada conexão automaticamente uma vez por sessão (assim que
    // o app abre), sem precisar clicar em "Sincronizar agora" — a guarda
    // por Set evita loop, já que a própria sincronização reescreve o
    // documento e dispara este listener de novo.
    STATE.conexoesBancarias.forEach((c) => {
      if (!conexoesAutoSincronizadasNestaSessao.has(c.id)) {
        conexoesAutoSincronizadasNestaSessao.add(c.id);
        sincronizarConexao(c.id, true);
      }
    });
  }, (err) => mostrarToast("Erro ao carregar conexões bancárias: " + err.message, true));

  onSnapshot(collection(db, "cartoesOpenFinance"), (snap) => {
    STATE.cartoesOpenFinance = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderCartoesOpenFinance();
  }, (err) => mostrarToast("Erro ao carregar cartões (Open Finance): " + err.message, true));

  onSnapshot(collection(db, "regrasCategorizacaoOF"), (snap) => {
    STATE.regrasCategorizacaoOF = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }, (err) => mostrarToast("Erro ao carregar regras de categorização: " + err.message, true));

  onSnapshot(collection(db, "feriados"), (snap) => {
    STATE.feriados = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderRecorrentes();
  }, (err) => mostrarToast("Erro ao carregar feriados: " + err.message, true));

  onSnapshot(doc(db, "config", "geral"), (snap) => {
    STATE.config = snap.exists() ? snap.data() : { rendaMensal: 0, saldoInicial: 0, metaGuardarMes: 0 };
    document.getElementById("cfg-renda").value = STATE.config.rendaMensal || 0;
    document.getElementById("cfg-saldo").value = STATE.config.saldoInicial || 0;
    document.getElementById("cfg-meta-guardar").value = STATE.config.metaGuardarMes || 0;
    document.getElementById("cfg-nomes-proprios").value = nomesProprios().join(", ");
    renderDashboard();
  }, (err) => mostrarToast("Erro ao carregar configurações: " + err.message, true));
}

/* ══════════════ INÍCIO ══════════════ */

document.getElementById("mov-data").valueAsDate = new Date();
document.getElementById("rec-inicio").valueAsDate = new Date();
document.getElementById("compra-data").valueAsDate = new Date();

const hojeInicial = new Date();
const mesInicial = `${hojeInicial.getFullYear()}-${String(hojeInicial.getMonth() + 1).padStart(2, "0")}`;
document.getElementById("mov-filtro-mes-de").value = mesInicial;
document.getElementById("mov-filtro-mes-ate").value = mesInicial;
STATE.filtroMovMesDe = mesInicial;
STATE.filtroMovMesAte = mesInicial;
document.getElementById("cp-filtro-mes").value = mesInicial;
STATE.filtroCPMes = mesInicial;
document.getElementById("dash-filtro-mes").value = mesInicial;
STATE.filtroDashMes = mesInicial;

iniciarBuscaLancamento();
iniciarListeners();
