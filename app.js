// Financeiro Leonardo — lógica do app. Firestore no lugar do Apps Script:
// onSnapshot mantém tudo em tempo real, sem precisar recarregar a página.
// Regras de negócio (vencimento em dia útil, cálculo do dashboard, limite do
// cartão) foram trazidas do Code.gs original e agora rodam aqui no navegador.

import { db } from "./firebase-init.js";
import {
  collection, addDoc, updateDoc, deleteDoc, setDoc, doc,
  onSnapshot, query, orderBy, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

const STATE = {
  lancamentos: [],
  movimentacoes: [],
  cartoes: [],
  comprasParceladas: [],
  recorrentes: [],
  historico: [],
  feriados: [],
  config: { rendaMensal: 0, saldoInicial: 0 },
  filtroMovMes: ""
};

let recorrentesCarregados = false;
let jaVerificouRecorrentesPendentes = false;

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

// Em qual mês cai a primeira fatura de uma compra parcelada: se foi feita
// antes do dia de fechamento, entra na fatura que fecha no mês seguinte; se
// foi no dia de fechamento ou depois, pula mais um mês.
function calcularCicloInicial(dataCompraStr, diaFechamento) {
  const d = parseDataLocal(dataCompraStr);
  const mes = d.getMonth() + (d.getDate() < diaFechamento ? 1 : 2);
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

function calcularDashboard() {
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

  STATE.movimentacoes.forEach((m) => {
    const l = mapaLanc[m.lancamentoId] || {};
    const valor = Number(m.valor) || 0;
    const ehSaida = l.tipo === "Saida";
    const dataAnoMes = String(m.data || "").slice(0, 7);

    if (m.pago === true) {
      saldoAtual += ehSaida ? -valor : valor;
      if (ehSaida && dataAnoMes === anoMes) saidasPagasMes += valor;
    } else {
      if (ehSaida) saidasNaoPagas += valor;
      else entradasNaoPagas += valor;
      if (m.cartaoId) parcelasCartaoFuturas += valor;
    }
  });

  const saldoPrevisto = saldoAtual - saidasNaoPagas + entradasNaoPagas;

  const diaAtual = hoje.getDate();
  const ultimoDiaMes = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getDate();
  const diasRestantes = ultimoDiaMes - diaAtual + 1;
  const gastoSugerido = diasRestantes > 0 ? saldoAtual / diasRestantes : 0;

  const percentualRendaGasta = rendaMensal > 0 ? (saidasPagasMes / rendaMensal) * 100 : 0;
  const gastoPermitidoAteHoje = rendaMensal > 0 ? (rendaMensal / ultimoDiaMes) * diaAtual : 0;

  return { saldoAtual, saldoPrevisto, gastoSugerido, percentualRendaGasta, gastoPermitidoAteHoje, diasRestantes, parcelasCartaoFuturas };
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

function renderAll() {
  renderLancamentos();
  renderMovimentacoes();
  renderCartoes();
  renderComprasParceladas();
  renderParcelasCartao();
  renderRecorrentes();
  renderHistorico();
  renderDashboard();
}

function renderLancamentos() {
  const body = document.getElementById("lancs-body");
  if (!STATE.lancamentos.length) {
    body.innerHTML = '<tr><td colspan="4" class="empty">Nenhum lançamento cadastrado ainda.</td></tr>';
  } else {
    body.innerHTML = STATE.lancamentos.map((l) => (
      `<tr><td>${esc(l.nome)}</td><td><span class="badge-tipo ${l.tipo}">${l.tipo === "Entrada" ? "Entrada" : "Saída"}</span></td>` +
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

function preencherSelectsLancamento() {
  const opcoes = STATE.lancamentos.map((l) => (
    `<option value="${l.id}">${esc(l.nome)} (${l.tipo === "Entrada" ? "Entrada" : "Saída"} — ${esc(l.categoria)})</option>`
  )).join("");
  ["mov-lancamento", "rec-lancamento", "compra-lancamento", "edit-mov-lancamento", "edit-rec-lancamento"].forEach((id) => {
    const sel = document.getElementById(id);
    const valorAtual = sel.value;
    sel.innerHTML = opcoes;
    if (pendingSelecaoLancamento && pendingSelecaoLancamento.selectId === id && STATE.lancamentos.some((l) => l.id === pendingSelecaoLancamento.lancamentoId)) {
      sel.value = pendingSelecaoLancamento.lancamentoId;
      pendingSelecaoLancamento = null;
    } else if (valorAtual) {
      sel.value = valorAtual;
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
  if (!STATE.filtroMovMes) return lista;
  return lista.filter((m) => String(m.data || "").slice(0, 7) === STATE.filtroMovMes);
}

function renderMovKpis(filtradas) {
  let totalPago = 0, totalNaoPago = 0, qtdPago = 0, qtdNaoPago = 0;
  filtradas.forEach((m) => {
    if (m.pago) { totalPago += Number(m.valor) || 0; qtdPago++; }
    else { totalNaoPago += Number(m.valor) || 0; qtdNaoPago++; }
  });
  document.getElementById("mov-kpi-grid").innerHTML =
    kpiCard("Pago no período", moeda(totalPago) + ` <small>(${qtdPago})</small>`, true) +
    kpiCard("A pagar no período", moeda(totalNaoPago) + ` <small>(${qtdNaoPago})</small>`, totalNaoPago === 0);
}

function renderMovimentacoes() {
  const mapaLanc = mapaLancamentos();
  const enriquecidas = STATE.movimentacoes.map((m) => {
    const l = mapaLanc[m.lancamentoId] || {};
    return { ...m, nomeLancamento: l.nome || "(excluído)", tipo: l.tipo || "", categoria: l.categoria || "" };
  });

  const filtradas = filtrarPorMes(enriquecidas);

  const body = document.getElementById("movs-body");
  if (!filtradas.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">${STATE.filtroMovMes ? "Nenhuma movimentação neste mês." : "Nenhuma movimentação registrada ainda."}</td></tr>`;
  } else {
    body.innerHTML = filtradas.map((m) => (
      `<tr class="linha-clicavel" data-abrir-mov="${m.id}">` +
      `<td>${dataBR(m.data)}</td><td>${esc(m.nomeLancamento)}</td>` +
      `<td><span class="badge-tipo ${m.tipo}">${m.tipo === "Entrada" ? "Entrada" : (m.tipo ? "Saída" : "")}</span></td>` +
      `<td>${esc(m.categoria)}</td><td>${esc(m.responsavel || "—")}</td><td class="num">${moeda(m.valor)}</td>` +
      `<td><span class="stamp ${m.pago ? "pago" : "pendente"}" data-alternar-pagamento="${m.id}" data-novo-pago="${!m.pago}">${m.pago ? "PAGO" : "PENDENTE"}</span></td></tr>`
    )).join("");
    document.querySelectorAll("[data-abrir-mov]").forEach((tr) => {
      tr.addEventListener("click", () => abrirModalMovimentacao(tr.dataset.abrirMov));
    });
    document.querySelectorAll("[data-alternar-pagamento]").forEach((stamp) => {
      stamp.addEventListener("click", (e) => {
        e.stopPropagation();
        alternarPagamento(stamp.dataset.alternarPagamento, stamp.dataset.novoPago === "true");
      });
    });
  }

  renderMovKpis(filtradas);
  renderDashMovs(enriquecidas.slice(0, 8));
}

document.getElementById("mov-filtro-mes").addEventListener("change", (e) => {
  STATE.filtroMovMes = e.target.value;
  renderMovimentacoes();
});
document.getElementById("btn-mov-todos-meses").addEventListener("click", () => {
  STATE.filtroMovMes = "";
  document.getElementById("mov-filtro-mes").value = "";
  renderMovimentacoes();
});

function renderDashMovs(movs) {
  const body = document.getElementById("dash-movs-body");
  if (!movs.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">Nenhuma movimentação registrada ainda.</td></tr>';
    return;
  }
  body.innerHTML = movs.map((m) => (
    `<tr><td>${dataBR(m.data)}</td><td>${esc(m.nomeLancamento)}</td>` +
    `<td><span class="badge-tipo ${m.tipo}">${m.tipo === "Entrada" ? "Entrada" : (m.tipo ? "Saída" : "")}</span></td>` +
    `<td class="num">${moeda(m.valor)}</td>` +
    `<td><span class="stamp ${m.pago ? "pago" : "pendente"}">${m.pago ? "PAGO" : "PENDENTE"}</span></td></tr>`
  )).join("");
}

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
  const sel = document.getElementById("compra-cartao");
  if (!STATE.cartoes.length) {
    sel.innerHTML = '<option value="">Cadastre um cartão primeiro</option>';
    return;
  }
  sel.innerHTML = STATE.cartoes.map((c) => {
    const disponivel = (Number(c.limiteTotal) || 0) - calcularLimiteUtilizado(c.id);
    return `<option value="${c.id}">${esc(c.nome)} (disponível ${moeda(disponivel)})</option>`;
  }).join("");
}

// Lista "achatada" de todo gasto já lançado no cartão (cada parcela de cada
// compra), pra corrigir rapidinho um erro de valor/data/responsável sem
// precisar ir até Movimentações e procurar. Reaproveita o mesmo modal de
// edição de movimentação (com o mesmo registro em Histórico).
function renderParcelasCartao() {
  const body = document.getElementById("parcelas-cartao-body");
  if (!body) return;
  const mapaCartao = {};
  STATE.cartoes.forEach((c) => (mapaCartao[c.id] = c));
  const mapaCompra = {};
  STATE.comprasParceladas.forEach((c) => (mapaCompra[c.id] = c));

  const parcelas = STATE.movimentacoes.filter((m) => m.cartaoId);
  if (!parcelas.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">Nenhum gasto lançado no cartão ainda.</td></tr>';
    return;
  }
  const ordenadas = [...parcelas].sort((a, b) => (a.data < b.data ? 1 : -1));
  body.innerHTML = ordenadas.map((m) => {
    const compra = mapaCompra[m.compraParceladaId];
    const descricao = compra ? compra.descricao : "(compra excluída)";
    const cartaoNome = (mapaCartao[m.cartaoId] || {}).nome || "(excluído)";
    return (
      `<tr class="linha-clicavel" data-abrir-mov="${m.id}"><td>${dataBR(m.data)}</td><td>${esc(descricao)}</td>` +
      `<td>${esc(cartaoNome)}</td><td>${esc(m.responsavel || "—")}</td><td class="num">${moeda(m.valor)}</td>` +
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
  const mapaCartao = {};
  STATE.cartoes.forEach((c) => (mapaCartao[c.id] = c));

  const body = document.getElementById("compras-body");
  if (!STATE.comprasParceladas.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">Nenhuma compra parcelada registrada ainda.</td></tr>';
    return;
  }
  const ordenadas = [...STATE.comprasParceladas].sort((a, b) => (a.dataCompra < b.dataCompra ? 1 : -1));
  body.innerHTML = ordenadas.map((c) => {
    const numParcelas = Number(c.numParcelas) || 1;
    const valorTotal = Number(c.valorTotal) || 0;
    const valorParcela = arredondar2(valorTotal / numParcelas);
    return (
      `<tr class="linha-clicavel" data-abrir-compra="${c.id}"><td>${esc(c.descricao)}</td><td>${esc(c.responsavel || "—")}</td><td>${esc((mapaCartao[c.cartaoId] || {}).nome || "(excluído)")}</td>` +
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
  document.getElementById("edit-compra-id").value = c.id;
  document.getElementById("edit-compra-descricao").value = c.descricao;
  document.getElementById("edit-compra-responsavel").value = c.responsavel || "";
  document.getElementById("edit-compra-valor").value = c.valorTotal;
  const numParcelas = Number(c.numParcelas) || 1;
  const naoPagas = STATE.movimentacoes.filter((m) => m.compraParceladaId === id && m.pago !== true);
  document.getElementById("edit-compra-hint-valor").textContent = naoPagas.length
    ? `Em caso de erro no valor, corrija aqui: o ajuste é distribuído entre as ${naoPagas.length} parcela(s) de ${numParcelas} ainda não pagas (as já pagas não mudam, pois já viraram histórico).`
    : "Todas as parcelas dessa compra já foram pagas — o valor total não pode mais ser ajustado aqui.";
  document.getElementById("edit-compra-valor").disabled = !naoPagas.length;
  document.getElementById("modal-editar-compra").classList.add("active");
}
function fecharModalEditarCompra() {
  document.getElementById("modal-editar-compra").classList.remove("active");
}
document.getElementById("btn-cancelar-edicao-compra").addEventListener("click", fecharModalEditarCompra);
document.getElementById("modal-editar-compra").addEventListener("click", (e) => {
  if (e.target.id === "modal-editar-compra") fecharModalEditarCompra();
});

document.getElementById("btn-salvar-edicao-compra").addEventListener("click", async () => {
  const id = document.getElementById("edit-compra-id").value;
  const descricao = document.getElementById("edit-compra-descricao").value.trim();
  const responsavel = document.getElementById("edit-compra-responsavel").value.trim();
  const valorTotal = Number(document.getElementById("edit-compra-valor").value);
  if (!descricao) return mostrarToast("A descrição não pode ficar em branco.", true);
  if (!valorTotal || valorTotal <= 0) return mostrarToast("Informe um valor total válido.", true);

  const atual = STATE.comprasParceladas.find((x) => x.id === id);
  if (!atual) return mostrarToast("Compra não encontrada.", true);

  const parcelas = STATE.movimentacoes.filter((m) => m.compraParceladaId === id);
  const pagas = parcelas.filter((m) => m.pago === true);
  const naoPagas = [...parcelas.filter((m) => m.pago !== true)].sort((a, b) => (a.data < b.data ? -1 : 1));
  const somaPagas = pagas.reduce((s, m) => s + (Number(m.valor) || 0), 0);

  const valorTotalAtual = arredondar2(Number(atual.valorTotal) || 0);
  const valorMudou = valorTotalAtual !== arredondar2(valorTotal);

  if (valorMudou) {
    if (!naoPagas.length) {
      return mostrarToast("Não dá pra ajustar o valor: todas as parcelas dessa compra já foram pagas.", true);
    }
    if (arredondar2(valorTotal - somaPagas) < 0) {
      return mostrarToast(`Valor total não pode ser menor que o já pago (${moeda(somaPagas)}).`, true);
    }
  }

  const alteracoes = [];
  if (atual.descricao !== descricao) alteracoes.push({ campo: "Descrição", antes: atual.descricao, depois: descricao });
  if ((atual.responsavel || "") !== responsavel) alteracoes.push({ campo: "Responsável", antes: atual.responsavel || "—", depois: responsavel || "—" });
  if (valorMudou) alteracoes.push({ campo: "Valor total", antes: moeda(valorTotalAtual), depois: moeda(valorTotal) });

  if (!alteracoes.length) {
    mostrarToast("Nenhuma alteração encontrada — os dados já eram esses.");
    fecharModalEditarCompra();
    return;
  }

  try {
    const batch = writeBatch(db);

    const dadosCompra = { descricao, responsavel };
    if (valorMudou) dadosCompra.valorTotal = valorTotal;
    batch.update(doc(db, "comprasParceladas", id), dadosCompra);

    // O ajuste de valor recai só sobre as parcelas ainda não pagas — as já
    // pagas viraram histórico e não são mexidas. Responsável é só um dado
    // informativo, então esse sim é atualizado em todas as parcelas.
    const novosValores = {};
    if (valorMudou) {
      const restante = arredondar2(valorTotal - somaPagas);
      const valorPorParcela = arredondar2(restante / naoPagas.length);
      naoPagas.forEach((m, i) => {
        novosValores[m.id] = i === naoPagas.length - 1
          ? arredondar2(restante - valorPorParcela * (naoPagas.length - 1))
          : valorPorParcela;
      });
    }
    parcelas.forEach((m) => {
      const dadosMov = {};
      if ((m.responsavel || "") !== responsavel) dadosMov.responsavel = responsavel;
      if (novosValores[m.id] !== undefined) dadosMov.valor = novosValores[m.id];
      if (Object.keys(dadosMov).length) batch.update(doc(db, "movimentacoes", m.id), dadosMov);
    });

    const mapaLanc = mapaLancamentos();
    const nomeLanc = (mapaLanc[atual.lancamentoId] || {}).nome || "(excluído)";
    alteracoes.forEach((a) => {
      const histRef = doc(collection(db, "historico"));
      batch.set(histRef, {
        lancamentoId: atual.lancamentoId, nomeLancamento: `${nomeLanc} (compra: ${descricao})`, campo: a.campo,
        valorAnterior: String(a.antes), valorNovo: String(a.depois),
        tipoAlteracao: "Edição de compra no cartão", dataHora: serverTimestamp()
      });
    });

    await batch.commit();
    mostrarToast(`Compra atualizada (${alteracoes.length} campo(s) alterado(s)).`);
    fecharModalEditarCompra();
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
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
  document.getElementById("edit-rec-lancamento").value = r.lancamentoId;
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

function kpiCard(label, value, positivo) {
  return (
    `<div class="kpi-card ${positivo ? "positive" : "negative"}">` +
    `<div class="label">${label}</div>` +
    `<div class="value num">${value}</div></div>`
  );
}

function renderDashboard() {
  const d = calcularDashboard();
  document.getElementById("kpi-grid").innerHTML =
    kpiCard("Saldo atual", moeda(d.saldoAtual), d.saldoAtual >= 0) +
    kpiCard("Saldo previsto", moeda(d.saldoPrevisto), d.saldoPrevisto >= 0) +
    kpiCard("Gasto sugerido / dia", moeda(d.gastoSugerido) + ` <small>(${d.diasRestantes} dias)</small>`, d.gastoSugerido >= 0) +
    kpiCard("% da renda gasta no mês", d.percentualRendaGasta.toFixed(1) + "%", d.percentualRendaGasta <= 100) +
    kpiCard("Gasto permitido até hoje", moeda(d.gastoPermitidoAteHoje), true) +
    kpiCard("Parcelas futuras no cartão", moeda(d.parcelasCartaoFuturas), true);
}

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

document.getElementById("btn-add-movimentacao").addEventListener("click", async () => {
  const lancamentoId = document.getElementById("mov-lancamento").value;
  const data = document.getElementById("mov-data").value;
  const valor = Number(document.getElementById("mov-valor").value);
  const pago = document.getElementById("mov-pago").value === "true";
  const responsavel = document.getElementById("mov-responsavel").value.trim();
  if (!lancamentoId) return mostrarToast("Cadastre um lançamento primeiro.", true);
  if (!data || !valor) return mostrarToast("Preencha data e valor.", true);
  try {
    await addDoc(collection(db, "movimentacoes"), {
      lancamentoId, data, valor, pago, responsavel, origem: "Manual", cartaoId: null, compraParceladaId: null, createdAt: serverTimestamp()
    });
    mostrarToast("Movimentação adicionada!");
    document.getElementById("mov-valor").value = "";
    document.getElementById("mov-responsavel").value = "";
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
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
  document.getElementById("edit-mov-lancamento").value = mov.lancamentoId;
  document.getElementById("edit-mov-data").value = mov.data;
  document.getElementById("edit-mov-valor").value = mov.valor;
  document.getElementById("edit-mov-pago").value = mov.pago ? "true" : "false";
  document.getElementById("edit-mov-responsavel").value = mov.responsavel || "";
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
  const responsavel = document.getElementById("edit-mov-responsavel").value.trim();

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
  if ((atual.responsavel || "") !== responsavel) alteracoes.push({ campo: "Responsável", antes: atual.responsavel || "—", depois: responsavel || "—" });

  if (!alteracoes.length) {
    mostrarToast("Nenhuma alteração encontrada — os dados já eram esses.");
    fecharModalMovimentacao();
    return;
  }

  try {
    await updateDoc(doc(db, "movimentacoes", id), { lancamentoId, data, valor, pago, responsavel });
    for (const a of alteracoes) {
      await addDoc(collection(db, "historico"), {
        lancamentoId, nomeLancamento: nomeDepois, campo: a.campo,
        valorAnterior: String(a.antes), valorNovo: String(a.depois),
        tipoAlteracao: "Edição de movimentação", dataHora: serverTimestamp()
      });
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
// não uma trava contra corrida.
document.getElementById("btn-add-compra").addEventListener("click", async () => {
  const cartaoId = document.getElementById("compra-cartao").value;
  const lancamentoId = document.getElementById("compra-lancamento").value;
  const descricao = document.getElementById("compra-descricao").value.trim();
  const responsavel = document.getElementById("compra-responsavel").value.trim();
  const valorTotal = Number(document.getElementById("compra-valor").value);
  const numParcelas = Number(document.getElementById("compra-parcelas").value);
  const dataCompra = document.getElementById("compra-data").value;

  if (!cartaoId) return mostrarToast("Cadastre um cartão primeiro.", true);
  if (!lancamentoId) return mostrarToast("Cadastre um lançamento primeiro.", true);
  if (!descricao) return mostrarToast("Descreva a compra.", true);
  if (!valorTotal || !numParcelas || !dataCompra) return mostrarToast("Preencha valor, parcelas e data da compra.", true);
  if (numParcelas < 1 || numParcelas > 60) return mostrarToast("Número de parcelas inválido (1 a 60).", true);

  const cartao = STATE.cartoes.find((c) => c.id === cartaoId);
  if (!cartao) return mostrarToast("Cartão não encontrado.", true);

  const limiteDisponivel = (Number(cartao.limiteTotal) || 0) - calcularLimiteUtilizado(cartaoId);
  if (valorTotal > limiteDisponivel) {
    return mostrarToast("Limite insuficiente nesse cartão. Disponível: " + moeda(limiteDisponivel), true);
  }

  try {
    const batch = writeBatch(db);
    const compraRef = doc(collection(db, "comprasParceladas"));
    batch.set(compraRef, { cartaoId, lancamentoId, descricao, responsavel, valorTotal, numParcelas, dataCompra, dataRegistro: serverTimestamp() });

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
        lancamentoId, data: vencimento, valor: valorDaParcela, pago: false, responsavel,
        origem: `Cartao ${i + 1}/${numParcelas}`, cartaoId, compraParceladaId: compraRef.id, createdAt: serverTimestamp()
      });
    }

    await batch.commit();
    mostrarToast(`${numParcelas} parcela(s) de ${moeda(valorParcela)} lançada(s) em Movimentações.`);
    document.getElementById("compra-descricao").value = "";
    document.getElementById("compra-responsavel").value = "";
    document.getElementById("compra-valor").value = "";
    document.getElementById("compra-parcelas").value = "1";
  } catch (err) {
    mostrarToast("Não foi possível lançar a compra: " + err.message, true);
  }
});

/* ══════════════ CUSTOS RECORRENTES ══════════════ */

document.getElementById("btn-add-recorrente").addEventListener("click", async () => {
  const lancamentoId = document.getElementById("rec-lancamento").value;
  const valor = Number(document.getElementById("rec-valor").value);
  const dataInicio = document.getElementById("rec-inicio").value;
  const diaVencimento = Number(document.getElementById("rec-dia").value);
  const ativo = document.getElementById("rec-ativo").value === "true";
  if (!lancamentoId) return mostrarToast("Cadastre um lançamento primeiro.", true);
  if (!valor || !dataInicio || !diaVencimento) return mostrarToast("Preencha valor, data de início e dia de vencimento.", true);
  try {
    await addDoc(collection(db, "recorrentes"), { lancamentoId, valor, dataInicio, diaVencimento, ativo, ultimoMesLancado: "", createdAt: serverTimestamp() });
    mostrarToast("Custo recorrente cadastrado!");
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
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
        pago: false, origem: "Recorrente", cartaoId: null, compraParceladaId: null, createdAt: serverTimestamp()
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

/* ══════════════ CONFIGURAÇÕES ══════════════ */

document.getElementById("btn-salvar-config").addEventListener("click", async () => {
  const rendaMensal = Number(document.getElementById("cfg-renda").value) || 0;
  const saldoInicial = Number(document.getElementById("cfg-saldo").value) || 0;
  try {
    await setDoc(doc(db, "config", "geral"), { rendaMensal, saldoInicial }, { merge: true });
    mostrarToast("Configurações salvas!");
  } catch (err) {
    mostrarToast("Não foi possível salvar: " + err.message, true);
  }
});

/* ══════════════ LISTENERS EM TEMPO REAL ══════════════ */

function iniciarListeners() {
  onSnapshot(query(collection(db, "lancamentos"), orderBy("nome")), (snap) => {
    STATE.lancamentos = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAll();
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

  onSnapshot(collection(db, "feriados"), (snap) => {
    STATE.feriados = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderRecorrentes();
  }, (err) => mostrarToast("Erro ao carregar feriados: " + err.message, true));

  onSnapshot(doc(db, "config", "geral"), (snap) => {
    STATE.config = snap.exists() ? snap.data() : { rendaMensal: 0, saldoInicial: 0 };
    document.getElementById("cfg-renda").value = STATE.config.rendaMensal || 0;
    document.getElementById("cfg-saldo").value = STATE.config.saldoInicial || 0;
    renderDashboard();
  }, (err) => mostrarToast("Erro ao carregar configurações: " + err.message, true));
}

/* ══════════════ INÍCIO ══════════════ */

document.getElementById("mov-data").valueAsDate = new Date();
document.getElementById("rec-inicio").valueAsDate = new Date();
document.getElementById("compra-data").valueAsDate = new Date();

const hojeInicial = new Date();
const mesInicial = `${hojeInicial.getFullYear()}-${String(hojeInicial.getMonth() + 1).padStart(2, "0")}`;
document.getElementById("mov-filtro-mes").value = mesInicial;
STATE.filtroMovMes = mesInicial;

iniciarListeners();
