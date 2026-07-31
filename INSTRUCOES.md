# Controle Financeiro Leonardo — Como colocar no ar

Este pacote tem estes arquivos:
- `firebase-init.js` → liga o sistema ao banco de dados (Firestore)
- `index.html`, `style.css`, `app.js` → o sistema que o Leonardo vai usar no navegador
- `firestore.rules` → regras de segurança, cola no console do Firebase
- `planilha.html` → uma página separada pra editar ou apagar dados direto, como se fosse uma planilha (veja o Passo 3 abaixo)
- `manifest.json`, `service-worker.js`, ícones (`.png`/`.ico`) → deixam o sistema instalável como aplicativo. **Precisam ficar na mesma pasta que o `index.html`**, sempre que for hospedar — não são opcionais.
- `Code.gs` → só é usado se vocês quiserem ativar a aba "Conexões Bancárias" (importar extrato do banco automaticamente). É **opcional** — sem configurar isso, o resto do sistema funciona normalmente (veja o Passo 5).
- `migrate-node/` → ferramenta separada, só pra quando vocês quiserem trazer os dados da planilha antiga (**não sobe pra hospedagem**)

## Passo 1 — Criar o banco de dados (Firebase)

1. Acesse [console.firebase.google.com](https://console.firebase.google.com) e crie um projeto novo (gratuito).
2. Ative o **Firestore Database** (modo produção).
3. Em **Regras**, cole o conteúdo de `firestore.rules` e publique.
4. Registre um "app Web" nas configurações do projeto e copie a configuração (`firebaseConfig`).
5. Abra `firebase-init.js` num editor de texto simples e cole essa configuração no lugar dos valores de exemplo (`COLE_AQUI_...`).

## Passo 2 — Colocar no ar

Este sistema **não funciona só abrindo o `index.html` no computador** (é
uma limitação de segurança do navegador). Ele precisa estar hospedado num
site com HTTPS. A forma mais simples e gratuita é o **GitHub Pages**:

1. Crie uma conta gratuita em [github.com](https://github.com), se ainda não tiver.
2. Crie um repositório novo.
3. Arraste todos os arquivos deste pacote pra dentro dele (soltos, sem pastas) — **exceto a pasta `migrate-node`**, essa fica só no seu computador.
4. Nas configurações do repositório, ative o **GitHub Pages** apontando pra branch principal.
5. Em alguns minutos, o link aparece — é esse link que o Leonardo vai usar.

## Passo 3 — Editar dados direto, como numa planilha

Se você quiser corrigir um dado, apagar um registro de teste, ou colar uma
lista inteira de uma vez, **não precisa entrar no site do Firebase**. Abra
o link do site com `/planilha.html` no final (ex:
`https://seusite.github.io/planilha.html`). Essa página pede uma senha (a
senha inicial é `leonardo2026` — troque assim que puder, veja o `README.md`)
e depois funciona como uma planilha: abas por tipo de dado, você edita a
célula e ela salva sozinha, seleciona várias linhas e apaga de uma vez, e
tem botões pra exportar em CSV/Excel ou importar um arquivo CSV/Excel de
uma vez.

**Guarde o link e a senha dessa página em um lugar seguro** — quem tiver
os dois consegue editar ou apagar qualquer dado do sistema.

## Passo 4 — Trazer os dados da planilha antiga (quando quiserem)

O sistema novo começa vazio. Quando o Leonardo quiser trazer os dados que
já existem na planilha antiga (lançamentos, movimentações, cartão etc.),
veja o passo a passo em `migrate-node/README.md`. **Isso não precisa ser
feito agora** — dá pra usar o sistema novo em paralelo, com dados de teste,
até vocês decidirem migrar de verdade. E o sistema antigo continua
funcionando normalmente enquanto isso.

## Passo 5 — Ativar "Conexões Bancárias" (opcional, avançado)

Essa aba importa o extrato do banco automaticamente pra dentro do sistema,
usando um serviço chamado Pluggy. **Não é obrigatório** — pule esse passo
se quiser, o resto do sistema funciona 100% sem isso.

Envolve criar uma conta gratuita em [console.pluggy.ai](https://console.pluggy.ai),
implantar o `Code.gs` do mesmo jeito que o Passo 1 (Extensões → Apps
Script → colar o código → Implantar como Aplicativo da Web), e colar duas
informações da Pluggy (Client ID e Client Secret) nas "Script Properties"
desse Apps Script. O passo a passo completo, com prints do que procurar em
cada tela, está no `README.md`, seção "5. Conexões Bancárias".

## Estrutura de dados criada no Firestore

- **lancamentos**: nome, tipo (Entrada/Saída), categoria
- **movimentacoes**: lançamento, data, valor, se está pago, cartão (se for parcela)
- **cartoes**: nome, limite, dia de fechamento e vencimento
- **comprasParceladas**: compra parcelada no cartão, com todas as parcelas já criadas em movimentacoes
- **recorrentes**: custos que se repetem todo mês (aluguel, assinatura...)
- **historico**: log de tudo que foi editado ou excluído — nunca é apagado
- **config**: renda mensal e saldo inicial
- **feriados**: usado pra calcular vencimento em dia útil
- **pessoas**: nomes que aparecem em "Quem comprou"
- **planos**: metas de economia
- **conexoesBancarias**, **cartoesOpenFinance**, **regrasCategorizacaoOF**: usados só se a aba "Conexões Bancárias" (Passo 5) estiver configurada
