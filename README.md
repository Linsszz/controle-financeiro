# Controle Financeiro Leonardo

Frontend estático (HTML/CSS/JS puro, sem framework) hospedado no GitHub
Pages, com **Cloud Firestore** (Firebase) como banco de dados em tempo real.

Este sistema é a versão em Firebase do controle financeiro que antes rodava
em Google Sheets + Apps Script. Não guarda fotos/anexos, então não há
`Code.gs` neste pacote.

## 1. Criar o projeto Firebase

1. Acesse o [console do Firebase](https://console.firebase.google.com) e crie um projeto novo (gratuito, plano Spark).
2. Ative o **Firestore**: menu lateral → "Bancos de dados e armazenamento" → **Firestore** → **Criar banco de dados** → escolha uma região (ex: `southamerica-east1` / São Paulo) → **modo de produção**.
3. Publique as regras de segurança: **Firestore Database → Regras** → apague o conteúdo → cole o de [`firestore.rules`](firestore.rules) → **Publicar**.
4. Registre um app Web: ícone de engrenagem → **Configurações do projeto** → role até "Seus apps" → ícone `</>` (Web) → dê um nome (ex: "Financeiro Leonardo") → **não** marque Firebase Hosting → **Registrar app**. Copie o bloco `firebaseConfig = {...}`.
5. Abra [`firebase-init.js`](firebase-init.js) e substitua os valores de exemplo (`COLE_AQUI_...`) pelos que você copiou.

Essas chaves (`apiKey`, `projectId` etc.) são **públicas por design** no Firebase Web — pode subir pro GitHub sem problema. A segurança de verdade vem das regras do Firestore (passo 3).

## 2. Migrar dados da planilha antiga (opcional, uma vez só)

O Leonardo já tem dados reais na planilha antiga. Quando vocês quiserem
trazer esses dados pro sistema novo, veja
[`migrate-node/README.md`](migrate-node/README.md) — um script que roda uma
vez, localmente, e copia tudo pro Firestore. **Isso não mexe em nada do
sistema antigo** — ele continua no ar normalmente até vocês decidirem migrar
de vez.

Se for testar o sistema novo do zero por enquanto, pule esta etapa.

## 3. Planilha administrativa

Este projeto inclui [`planilha.html`](planilha.html) — uma página que
funciona como uma planilha (abas, células editáveis, exportar/importar
CSV/XLSX) por cima do banco de dados, pra editar ou apagar registros sem
precisar entrar no console do Firebase. Ela é protegida por uma senha
simples (só um cadeado contra acesso acidental, **não é segurança de
verdade** — qualquer pessoa com conhecimento técnico consegue escrever
direto no Firestore ignorando essa senha). **Não há link pra ela em nenhum
menu do app** — o acesso é direto pela URL `.../planilha.html` da
hospedagem.

A senha padrão gerada neste pacote é `leonardo2026` — troque assim que
puder (veja "Trocar a senha da planilha administrativa" abaixo).

## 4. Rodar o app

O app é 100% estático — todos os arquivos ficam juntos, sem subpastas
(`index.html`, `style.css`, `app.js`, `firebase-init.js`, `planilha.html`,
`manifest.json`, `service-worker.js`, os ícones `.png`/`.ico`). Isso é
proposital: uploads pela interface web do GitHub não preservam pastas ao
arrastar arquivos soltos.

- **Não abra `index.html` direto do disco (duplo clique) para testar** —
  módulos ES são bloqueados por CORS no protocolo `file://`. Use um
  servidor local (`python -m http.server` / `npx serve`) ou teste direto na
  hospedagem.
- Suba a pasta em qualquer hospedagem estática com HTTPS (GitHub Pages,
  Netlify, Vercel) pra usar de verdade e pro "Instalar app" funcionar.

**Não suba a pasta `migrate-node/` pra hospedagem** — é só uma ferramenta local.

## Estrutura de dados no Firestore

- **lancamentos/{id}**: `nome`, `tipo` (`Entrada`/`Saida`), `categoria`, `createdAt`
- **movimentacoes/{id}**: `lancamentoId`, `data` (`yyyy-MM-dd`), `valor`, `pago`, `responsavel` (quem fez o gasto), `origem`, `cartaoId`, `compraParceladaId`, `createdAt`
- **cartoes/{id}**: `nome`, `limiteTotal`, `diaFechamento`, `diaVencimento`, `ativo`, `createdAt`
- **comprasParceladas/{id}**: `cartaoId`, `lancamentoId`, `descricao`, `responsavel` (quem fez a compra), `valorTotal`, `numParcelas`, `dataCompra`, `dataRegistro`
- **recorrentes/{id}**: `lancamentoId`, `valor`, `dataInicio`, `diaVencimento`, `ativo`, `ultimoMesLancado`, `createdAt`
- **historico/{id}**: `lancamentoId`, `nomeLancamento`, `campo`, `valorAnterior`, `valorNovo`, `tipoAlteracao`, `dataHora` — create-only, nunca editado/apagado
- **config/geral**: documento único com `rendaMensal`, `saldoInicial`
- **feriados/{id}**: `data` (`yyyy-MM-dd`), `descricao` — usados no cálculo de vencimento em dia útil

## O que melhorou em relação ao sistema antigo

- **Tempo real de verdade**: qualquer alteração (marcar como pago, editar um
  lançamento, lançar uma compra) aparece na tela de quem mais estiver com o
  app aberto quase instantaneamente — sem precisar recarregar a página.
- **Sem limite de linhas de planilha** e sem risco de fórmula quebrada.
- **Histórico de alterações** continua funcionando exatamente como antes:
  log permanente, nunca sobrescrito.
- **Custos recorrentes**: como não existe mais um "servidor" rodando
  sozinho (o Apps Script tinha um gatilho automático todo dia 1 às 3h), o
  app agora faz essa checagem automaticamente toda vez que alguém abre a
  tela — na prática, o efeito é o mesmo: o custo recorrente pendente é
  lançado assim que qualquer pessoa abrir o sistema depois da virada do
  mês. O botão manual "Lançar recorrentes pendentes deste mês" continua lá
  também.

## Trocar a senha da planilha administrativa

1. Escolha a senha nova.
2. Calcule o hash SHA-256 dela (peça pra quem monta sistemas assim gerar
   pra você, ou rode no terminal, se tiver Python instalado):
   ```
   python -c "import hashlib; print(hashlib.sha256(b'SUA_SENHA_NOVA').hexdigest())"
   ```
3. Abra `planilha.html`, ache a linha `const SENHA_HASH = "..."` e troque
   pelo resultado (64 caracteres).
4. Suba o arquivo atualizado pra hospedagem.

## Observações

- **Sem servidor "oficial"**: como não há Cloud Functions, a validação de
  regras de negócio (limite do cartão, cálculo de vencimento em dia útil,
  histórico de alterações) roda no `app.js`, no navegador de cada usuário —
  protegida contra gravações mal-formadas pelas regras do Firestore, mas
  não contra alguém tecnicamente hábil abrindo o DevTools. Trade-off
  aceitável pra um sistema de uso pessoal/familiar; se isso um dia
  incomodar (por ex. se mais pessoas passarem a usar o sistema), dá pra
  reconsiderar introduzir Firebase Auth.
- **Feriados**: o sistema antigo já vinha com a lista de feriados nacionais
  de 2026 pré-cadastrada. Popule a coleção `feriados` (pela `planilha.html`,
  aba "Feriados") com as datas que faltarem — sem isso, o cálculo de
  vencimento ainda funciona, só não pula feriados (continua pulando fins de
  semana normalmente).
