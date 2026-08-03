# Controle Financeiro Leonardo

Frontend estático (HTML/CSS/JS puro, sem framework) hospedado no GitHub
Pages, com **Cloud Firestore** (Firebase) como banco de dados em tempo real.

Este sistema é a versão em Firebase do controle financeiro que antes rodava
em Google Sheets + Apps Script. Não guarda fotos/anexos — o único
`Code.gs` deste pacote existe só como proxy de segredos da integração de
Open Finance (Conexões Bancárias, veja a seção 5), que é opcional.

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

## 5. Conexões Bancárias (Open Finance via Pluggy) — opcional

Uma aba "🏦 Conexões Bancárias" que importa transações do seu banco direto
pra Movimentações, usando a [Pluggy](https://pluggy.ai) — uma agregadora
brasileira de Open Finance. **É totalmente opcional**: o resto do sistema
funciona normalmente sem isso configurado, a aba só mostra um aviso pra
configurar quando você tentar conectar um banco.

**Escopo: somente leitura.** Esta integração só lê extratos e transações
pra importar como movimentações — ela **nunca** inicia pagamento,
transferência, PIX ou qualquer outra ação que mexa no seu dinheiro de
verdade. Não existe (e não deve ser adicionado) nenhum caminho de código
que escreva de volta pro banco.

### 5.1. Criar uma conta Pluggy (sandbox gratuita)

1. Acesse [console.pluggy.ai](https://console.pluggy.ai) e crie uma conta gratuita (não pede cartão de crédito pro tier sandbox).
2. No painel, ache **Client ID** e **Client Secret** (geralmente em "API Keys" ou na tela inicial do projeto).
3. Guarde os dois — eles vão pro Apps Script no passo 5.3, nunca direto no código deste projeto.

**Importante sobre o sandbox**: a conta gratuita da Pluggy só conecta a
**bancos de teste fictícios** (pra você testar o fluxo inteiro sem usar uma
conta bancária real). Pra conectar bancos de verdade, é preciso migrar pra
uma conta de produção da Pluggy, o que envolve custo e passar pelo processo
de certificação de Open Finance da própria Pluggy — veja isso diretamente
no site deles quando for a hora; este pacote não configura nem garante
acesso a bancos reais.

### 5.2. Implantar o Code.gs (proxy de segredos)

O `clientId`/`clientSecret` da Pluggy **nunca** podem ir pro `app.js` ou
`index.html` (são arquivos públicos, visíveis por "ver código-fonte"). Por
isso existe [`Code.gs`](Code.gs) — um Apps Script mínimo que guarda esses
segredos e repassa só as 3 chamadas de leitura que o app precisa.

1. Crie uma planilha Google Sheets em branco (só serve de "casa" pro script).
2. Menu **Extensões → Apps Script**.
3. Apague o conteúdo padrão e cole todo o conteúdo de `Code.gs`.
4. Menu **Implantar → Nova implantação** → tipo **"Aplicativo da Web"**:
   - Executar como: **Eu** (seu e-mail)
   - Quem pode acessar: **Qualquer pessoa**
5. Copie a URL `/exec` gerada.

### 5.3. Configurar as Script Properties (segredos da Pluggy)

Ainda no editor do Apps Script: menu **⚙️ Configurações do projeto** →
**Script Properties** → **Add script property**, e adicione duas:

| Propriedade            | Valor                                  |
|-------------------------|-----------------------------------------|
| `PLUGGY_CLIENT_ID`      | o Client ID copiado no passo 5.1        |
| `PLUGGY_CLIENT_SECRET`  | o Client Secret copiado no passo 5.1    |

Nunca escreva esses valores em texto puro em nenhum arquivo do projeto.

### 5.4. Ligar o app ao proxy

Abra [`firebase-init.js`](firebase-init.js) e substitua
`PLUGGY_PROXY_URL` pela URL `/exec` copiada no passo 5.2.

Pronto — a aba "Conexões Bancárias" já consegue abrir o widget da Pluggy
Connect, conectar um banco de teste (sandbox) e importar as transações.

**Toda vez que você editar `Code.gs`**, é preciso fazer uma nova implantação
(ou "Gerenciar implantações → editar → Nova versão") pra que a URL já
publicada reflita o código novo — só salvar no editor não é suficiente.

## Estrutura de dados no Firestore

- **lancamentos/{id}**: `nome`, `tipo` (`Entrada`/`Saida`), `categoria`, `createdAt`
- **movimentacoes/{id}**: `lancamentoId`, `data` (`yyyy-MM-dd`), `valor`, `pago`, `responsavel` (quem fez o gasto), `origem`, `cartaoId`, `compraParceladaId`, `pluggyTransactionId` (opcional, só em movimentações importadas via Open Finance), `createdAt`
- **cartoes/{id}**: `nome`, `limiteTotal`, `diaFechamento`, `diaVencimento`, `ativo`, `createdAt`
- **comprasParceladas/{id}**: `cartaoId`, `lancamentoId`, `descricao`, `responsavel` (quem fez a compra), `valorTotal`, `numParcelas`, `dataCompra`, `dataRegistro`
- **recorrentes/{id}**: `lancamentoId`, `valor`, `dataInicio`, `diaVencimento`, `ativo`, `ultimoMesLancado`, `createdAt`
- **historico/{id}**: `lancamentoId`, `nomeLancamento`, `campo`, `valorAnterior`, `valorNovo`, `tipoAlteracao`, `dataHora` — create-only, nunca editado/apagado
- **config/geral**: documento único com `rendaMensal`, `saldoInicial`
- **feriados/{id}**: `data` (`yyyy-MM-dd`), `descricao` — usados no cálculo de vencimento em dia útil
- **planos/{id}**: `icone`, `nome`, `descricao`, `valorAlvo`, `valorAcumulado`, `aportePlanejadoMensal`, `createdAt` — metas de economia (aba "Planos")
- **listaCompras/{id}**: `nome`, `descricao`, `valorEstimado`, `categoria`, `tipoCompra` (`Recorrente`/`Pontual`), `status` (`Pendente`/`Comprado`/`Cancelado`), `recorrenciaFrequencia` (`semanal`/`mensal`/`anual`/`personalizada`, só em itens Recorrentes), `recorrenciaIntervaloDias` (só quando a frequência é `personalizada`), `ultimaCompra`, `proximaCompra`, `createdAt` — lembretes de compras futuras (aba "Lista de Compras"), não mexe em saldo nenhum
- **planos/{id}/aportes/{id}**: `tipo` (`Aporte`/`Retirada`), `valor`, `data`, `timestamp` — log permanente de cada aporte/retirada de um plano, create-only
- **pessoas/{id}**: `nome`, `createdAt` — alimenta os selects de "Quem comprou" em Movimentações e Cartão de Crédito
- **conexoesBancarias/{id}**: `itemId` (id do "item" na Pluggy), `instituicao`, `status` (`conectado`/`erro`/`reconexao_necessaria`), `ultimaSincronizacao`, `ativoParaPessoal`, `createdAt` — um documento por banco conectado via Open Finance
- **cartoesOpenFinance/{id}**: `conexaoId`, `instituicao`, `accountId`, `nome`, `bandeira`, `limiteTotal`, `limiteUtilizado`, `limiteDisponivel`, `dataFechamento`, `dataVencimento`, `ultimaSincronizacao` — cartões descobertos via Open Finance, só leitura
- **regrasCategorizacaoOF/{id}**: `chave`, `lancamentoId`, `descricaoExemplo`, `atualizadoEm` — "essa transação sempre vira esse lançamento", aprendida quando você recategoriza uma transação importada

### Sobre o campo "Quem comprou"

É um `<select>` alimentado pela coleção `pessoas`, com um botão "+" pra
cadastrar gente nova sem sair da tela. Pra manter a migração simples, ele
guarda o **nome** da pessoa (não um ID) em `responsavel` — então renomear
uma pessoa cadastrada não atualiza registros antigos automaticamente (é
diferente de como `lancamentoId` funciona). Registros antigos que já
tinham um texto livre em "Quem comprou" (de antes dessa mudança) continuam
aparecendo normalmente nos selects, marcados como "(não cadastrado)" até
você cadastrar a pessoa de verdade ou trocar por uma existente.

### Sobre as movimentações importadas de "Conexões Bancárias"

Toda transação importada via Pluggy vira uma `movimentacao` normal, com
`origem: "Open Finance"` e `pluggyTransactionId` preenchido (usado pra não
importar a mesma transação duas vezes numa próxima sincronização). Como a
Pluggy não sabe qual `lancamento` seu você quer usar pra cada transação, o
sistema cria automaticamente (ou reaproveita, se já existir) um lançamento
genérico chamado **"Importado do banco"** — um pra Entradas, um pra
Saídas, categoria "Open Finance (a revisar)" — só pra a transação não
ficar sem lugar nenhum. Depois é só abrir a movimentação em Movimentações
e trocar o lançamento/categoria pelo que fizer sentido — a próxima
transação parecida (mesmo CNPJ ou mesma descrição) já entra categorizada
sozinha, porque o sistema aprende essa regra.

Compras parceladas no cartão detectadas via Open Finance também geram
automaticamente as parcelas **futuras** (o banco só manda a que já
aconteceu) como movimentações pendentes, marcadas "PREVISÃO" — quando a
parcela real chegar numa sincronização seguinte, o sistema substitui a
previsão em vez de duplicar.

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
- **Editar uma compra parcelada sincroniza tudo em Movimentações**: mudar
  cartão, valor total, nº de parcelas ou data da compra recalcula
  automaticamente as parcelas ainda não pagas (as já pagas nunca são
  tocadas — viraram histórico). A regra do fechamento é respeitada: uma
  compra feita a partir do dia de fechamento do cartão entra na fatura do
  mês seguinte.
- **Recalcular parcelas manualmente**: no modal de editar compra, o botão
  "🔄 Recalcular parcelas com os dados atuais" força o recálculo das
  parcelas ainda não pagas mesmo sem mudar nenhum campo — útil pra corrigir
  compras antigas que foram lançadas antes de algum ajuste na regra de
  fechamento do sistema.
- **Planos**: aba nova de metas de economia, com barra de progresso,
  previsão de quando você consegue chegar lá no ritmo atual, e um
  simulador — diga quanto quer guardar por mês (mostra a previsão de
  tempo) ou em quantos meses quer conseguir (mostra quanto precisa guardar
  por mês). Cada aporte/retirada fica registrado num log permanente por
  plano.
- **Conexões Bancárias**: importação de extrato via Open Finance (Pluggy),
  somente leitura — veja a seção 5 acima. Categorização automática que
  aprende, conciliação com lançamentos já pendentes (evita duplicar) e
  previsão de parcelas futuras de cartão.
- **Lista de Compras**: aba nova de lembretes/planejamento de compras
  futuras — separada das Movimentações porque ainda não é um gasto de
  verdade. Itens **Pontuais** vão pro histórico assim que marcados como
  comprados; itens **Recorrentes** nunca são removidos — reagendam
  sozinhos pro próximo período (semanal, mensal, anual ou a cada X dias)
  ao serem marcados como comprados. Dá pra filtrar por tipo, categoria e
  status, e ordenar por data, valor estimado ou nome.

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
  de 2026 pré-cadastrada — trouxe essa mesma lista pronta em
  [`feriados-2026-import.csv`](feriados-2026-import.csv). Pra usar: abra
  `planilha.html`, vá na aba "Feriados", clique em **Importar CSV/XLSX** e
  escolha esse arquivo (as linhas não têm `id`, então todas entram como
  registros novos). Sem isso, o cálculo de vencimento ainda funciona, só não
  pula feriados (continua pulando fins de semana normalmente).
- **Conexões Bancárias é opcional e isolada**: se você nunca configurar o
  Pluggy/Code.gs, o resto do sistema (Movimentações, Cartão, Recorrentes,
  Planos etc.) funciona 100% normalmente — a aba só mostra um erro amigável
  se você tentar conectar um banco sem ter configurado `PLUGGY_PROXY_URL`.
