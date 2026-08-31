# Orbyn — Manual do operador

Sistema local de prospecção comercial no Instagram para a **Aionixdev**.

O sistema roda inteiro na sua máquina: painel Next.js, worker de jobs e banco SQLite. Nada é hospedado, nada sai do seu computador além das chamadas que você configurar explicitamente (OpenAI, API oficial da Meta e o Chrome que você mesmo abre).

---

## Sumário

1. [Requisitos](#1-requisitos)
2. [Instalação](#2-instalação)
3. [Cadastro oficial do negócio](#3-cadastro-oficial-do-negócio)
4. [OpenAI](#4-openai)
5. [Chrome dedicado](#5-chrome-dedicado)
6. [Instagram / Meta](#6-instagram--meta)
7. [Operação do dia a dia](#7-operação-do-dia-a-dia)
8. [Dry-run e smoke test real](#8-dry-run-e-smoke-test-real)
9. [Backup e restauração](#9-backup-e-restauração)
10. [Alertas: o que significam e o que fazer](#10-alertas-o-que-significam-e-o-que-fazer)
11. [Privacidade e retenção](#11-privacidade-e-retenção)
12. [O que o sistema nunca faz](#12-o-que-o-sistema-nunca-faz)

---

## 1. Requisitos

| Item | Versão |
| --- | --- |
| Node.js | 24 LTS |
| pnpm | 11 ou superior |
| Google Chrome | qualquer versão estável recente (opcional, só para o primeiro contato) |
| Sistema | Windows, macOS ou Linux |

Confira:

```bash
node -v    # deve mostrar v24.x
pnpm -v
```

---

## 2. Instalação

```bash
pnpm install
cp .env.example .env
cp config/business.example.json config/business.json   # se ainda não existir
pnpm db:migrate
```

Suba o sistema completo (painel + worker) com **um comando**:

```bash
pnpm dev
```

- Painel: <http://127.0.0.1:4310>
- Worker: roda no mesmo terminal, com prefixo `[worker]`
- `Ctrl+C` encerra os dois

Para rodar em modo de produção local:

```bash
pnpm build
pnpm start
```

Quer ver a interface com dados de exemplo antes de apontar para perfis reais?

```bash
pnpm seed:demo
```

Os registros criados por esse comando têm origem `demo_seed` e **nunca** recebem contato real — o envio ao vivo os recusa por construção.

---

## 3. Cadastro oficial do negócio

O arquivo `config/business.json` é a **verdade oficial** do negócio: identidade, links, posicionamento, oferta, modelo de receita, ICP, afirmações verificadas e programa de afiliados.

Regras:

- **Somente você** altera esse arquivo. Nenhuma rotina do sistema escreve nele — não existe caminho de escrita no código, e há um teste automatizado que falha caso alguém introduza um.
- O aprendizado do sistema (pesos de palavra-chave, horários preferidos, distribuição de variantes) fica **separado**, na tabela `strategy_state`, visível em **Experimentos → Estratégia aprendida**.
- A cada inicialização o sistema grava a impressão digital do arquivo. Se ela mudar, um alerta informativo é aberto para você revisar claims, links e ICP.

### Campos que travam capacidades

| Campo vazio ou `"A DEFINIR"` | Efeito |
| --- | --- |
| `links.whatsapp` | Funil de clientes fica não configurado; nenhum encaminhamento acontece |
| `verifiedClaims` vazio | Funil de clientes fica não configurado |
| `affiliateProgram.groupLink` | **Funil de afiliados aguardando configuração** |
| `affiliateProgram.verifiedProgramClaims` vazio | **Funil de afiliados aguardando configuração** |

Enquanto uma capacidade estiver não configurada, o painel diz exatamente o que falta e **nenhum placeholder é enviado a lead algum**.

### Afirmações verificadas

A IA só pode afirmar fatos sobre a empresa que estejam em `verifiedClaims`. Tudo em `unverifiedClaims` fica bloqueado até você comprovar e mover para a lista verificada.

Além disso, um filtro determinístico roda em **toda** mensagem, gerada por IA ou por modelo, e bloqueia: percentuais, ROI, valores em reais, quantidade de clientes, cases, depoimentos, garantias, superlativos, urgência artificial e relação inventada. Uma mensagem reprovada nunca é enviada: ela vira alerta e a conversa vai para revisão humana.

---

## 4. OpenAI

O motor de IA é **opcional**. Sem chave, o sistema continua operando: as aberturas usam um modelo determinístico ancorado apenas nos dados coletados e nas afirmações verificadas, a classificação de respostas usa regras, e qualquer resposta que exigiria julgamento comercial é encaminhada para você.

### Criar a chave

1. Acesse <https://platform.openai.com/>.
2. Crie um **projeto dedicado** para o Orbyn (não use o projeto padrão da sua conta).
3. Em **API keys**, gere uma chave **restrita a esse projeto**.
4. Conceda apenas o privilégio necessário: escrita em *Model capabilities* (Responses/Chat). Nada de *Fine-tuning*, *Assistants*, *Files* ou permissões administrativas.
5. Em **Limits**, defina um limite de gasto mensal no próprio projeto. Esse é o seu segundo cinto de segurança — o primeiro é o `OPENAI_MONTHLY_BUDGET_USD` do `.env`.

### Onde configurar

No `.env`:

```env
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.1
OPENAI_MODEL_FAST=gpt-5.1-mini
OPENAI_MONTHLY_BUDGET_USD=25
```

Use nomes de modelo **exatos**, não apelidos flutuantes: um apelido pode mudar de comportamento sem aviso.

### Preço por token

```env
OPENAI_PRICE_INPUT_PER_1M=
OPENAI_PRICE_OUTPUT_PER_1M=
OPENAI_FAST_PRICE_INPUT_PER_1M=
OPENAI_FAST_PRICE_OUTPUT_PER_1M=
```

Preencha com o preço do seu plano, por 1 milhão de tokens. Se deixar vazio, o sistema **não inventa número**: registra a chamada com os tokens reais e mostra "preço não configurado" no painel. Com o preço preenchido, o teto mensal passa a bloquear novas chamadas automaticamente.

### Se a chave vazar

1. Revogue a chave imediatamente em **API keys → Revoke**.
2. Gere uma nova chave no mesmo projeto restrito.
3. Atualize o `.env` e reinicie (`Ctrl+C` e `pnpm dev`).
4. Confira o consumo em **Usage** no painel da OpenAI e compare com a página **Custo de IA** do Orbyn.
5. Se houver consumo que você não reconhece, reduza o limite do projeto para zero enquanto investiga.

O `.env` está no `.gitignore` e os logs passam por redação de segredos — chaves, tokens, cookies e cabeçalhos de autorização nunca são gravados.

---

## 5. Chrome dedicado

O primeiro contato usa o **seu** Chrome, porque a API oficial da Meta não permite iniciar conversa (ver seção 6). O Orbyn se conecta a ele pela porta de depuração local e abre **uma aba própria**.

> **Aviso de segurança — leia antes de habilitar.**
> Quem tiver acesso à porta de depuração controla a sessão autenticada desse Chrome: pode ler mensagens, agir como você e extrair cookies.
> - Use **sempre** um perfil dedicado, separado do seu perfil pessoal.
> - Vincule a porta **apenas** a `127.0.0.1`. **Nunca** a `0.0.0.0`.
> - **Não use em computador compartilhado.**
>
> O sistema recusa iniciar se `CHROME_CDP_URL` apontar para algo fora do loopback.

### Windows (PowerShell)

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --remote-debugging-address=127.0.0.1 `
  --user-data-dir="$PWD\.chrome-profile"
```

### macOS

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$PWD/.chrome-profile"
```

### Linux

```bash
google-chrome \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$PWD/.chrome-profile"
```

Na primeira execução, faça login no Instagram **dentro desse perfil dedicado**. A pasta `.chrome-profile/` está no `.gitignore`.

No `.env`:

```env
CHROME_CDP_URL=http://127.0.0.1:9222
CHROME_PROFILE_DIR=./.chrome-profile
```

### Como o Orbyn se comporta nesse Chrome

- Reaproveita o contexto já autenticado; **nunca** abre um navegador próprio se a conexão falhar.
- Abre **uma aba nova** para cada job e a fecha no final, inclusive em caso de erro.
- **Nunca** traz a janela para a frente, nem controla o mouse ou o teclado do computador — você pode continuar trabalhando normalmente.
- Restringe o tráfego da aba aos domínios do Instagram.
- Executa **um job de navegador por vez**.
- Se a conexão falhar: registra `browser_unavailable`, pausa a fila dependente e abre um alerta. Não tenta contornar.

---

## 6. Instagram / Meta

### Limitação verificada na documentação oficial

Consultada em **30/08/2026**, a documentação da Instagram Platform afirma:

> "Only after an Instagram user has sent your app user's Instagram professional account a message can your app send a message to the Instagram user."

E sobre a janela de resposta:

> "Your app has 24 hours to respond to any message sent from an Instagram user."

Com a tag `human_agent`, um atendente humano pode responder em até 7 dias.

**Consequência prática, que define toda a arquitetura do sistema:**

- A API oficial **não inicia** conversa. O primeiro contato só é possível pelo navegador.
- Depois que o lead responde, a propriedade da conversa passa **permanentemente** para a API oficial. O navegador não volta àquela thread — a máquina de estados não tem esse caminho.
- Se a janela de 24h fechar, o follow-up simplesmente **não acontece**. O sistema registra o motivo e não tenta contornar pelo navegador.

Reveja essas regras na documentação da Meta antes de mudar qualquer coisa: elas mudam com o tempo.

Referências:
- <https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/>
- <https://developers.facebook.com/docs/messenger-platform/policy/policy-overview/>

### Estado desta instalação (verificado em 30/08/2026)

| Item | Valor |
| --- | --- |
| App Meta | `Orbyn` — ID `1336782218241246` |
| App do Instagram | `Orbyn-IG` — ID `1747974179615048` |
| Portfólio empresarial | Aionixdev |
| Conta profissional | @aionixdev, tipo BUSINESS |
| IG Business Account ID | `<IG_BUSINESS_ACCOUNT_ID>` |
| ID retornado por `/me` | `<IG_BUSINESS_ACCOUNT_ID>` |
| Modo do app | **Em desenvolvimento** (não publicado) |

Os dois IDs são normais e ambos resolvem para a mesma conta: o primeiro é o que o
painel exibe, o segundo é o que a API devolve com um token de Instagram Login.
O Orbyn usa `INSTAGRAM_BUSINESS_ACCOUNT_ID` apenas para liberar a capacidade,
nunca para casar o destinatário, então qualquer um dos dois serve.

### Configuração

1. Converta a conta para **profissional** (Business ou Creator).
2. Em <https://developers.facebook.com/apps>, crie o app e adicione o caso de uso
   **"Gerenciar mensagens e conteúdo no Instagram"**.
3. Em **Funções → Funções**, adicione a conta como **Testador do Instagram**.
4. **Aceite o convite pela conta do Instagram**: em <https://www.instagram.com/accounts/manage_access/>,
   aba **"Convites do testador"** → **Aceitar**. Sem esse aceite, o token não é gerado.
5. Confirme as permissões: `instagram_business_basic`,
   `instagram_business_manage_messages`, `instagram_business_manage_comments`.
6. Gere o token em **"2. Gerar tokens de acesso" → Gerar token**. O fluxo força
   login com senha, mesmo com sessão ativa.
7. Copie a **chave secreta do app do Instagram** (botão "Mostrar" — também pede
   senha) e preencha o `.env`:

```env
INSTAGRAM_APP_SECRET=...
INSTAGRAM_PAGE_ACCESS_TOKEN=...
INSTAGRAM_WEBHOOK_VERIFY_TOKEN=escolha-uma-frase-secreta
INSTAGRAM_BUSINESS_ACCOUNT_ID=...
```

> A chave secreta usada para validar a assinatura do webhook é a **do app do
> Instagram** (`Orbyn-IG`), não a do app Meta. São valores diferentes.

### Webhook

O endpoint é `POST /api/webhooks/instagram`; a verificação inicial é `GET` no
mesmo endereço.

Como o sistema roda local, exponha a porta com um túnel:

```bash
cloudflared tunnel --url http://127.0.0.1:4310
```

No painel da Meta, em **"3. Configurar webhooks"**:

- **URL de callback**: `https://SEU-TUNEL/api/webhooks/instagram`
- **Verificar token**: exatamente o valor de `INSTAGRAM_WEBHOOK_VERIFY_TOKEN`
- Clique **Verificar e salvar** — a Meta chama o `GET` na hora e só salva se o
  challenge for ecoado corretamente.
- Assine o campo **`messages`** e ative a **assinatura da conta** na tabela do
  passo 2 (a chave passa de "Desativado" para "Ativado").

> **A URL do túnel gratuito muda a cada reinício.** Quando reiniciar o
> `cloudflared`, atualize a URL de callback no painel da Meta, senão a Meta
> continuará entregando no endereço antigo e nada chegará.

### Restrição de modo de desenvolvimento

O painel exibe, na seção de webhooks:

> *"Seu app deve estar com o status de publicado para receber webhooks."*

A configuração inteira pode ser salva e ativada em modo desenvolvimento — e foi —
mas a **entrega efetiva** dos eventos depende da publicação do app. Enquanto ele
estiver "Em desenvolvimento", a cadeia `lead responde → webhook → handoff →
resposta pela API` não fecha sozinha. Isso é uma regra da Meta, não uma limitação
do Orbyn.

Publicar o app é uma decisão sua, em **Publicar** no menu lateral. Publicação e
Análise do App têm impacto externo e não devem ser feitas por automação.

### Modo de teste

Enquanto o app estiver em modo de desenvolvimento, só contas com papel no app conseguem trocar mensagens. Use uma conta de teste sua para validar o ciclo completo antes de ir para produção.

---

## 7. Operação do dia a dia

### Colocar leads no funil

Duas formas:

1. **Importação manual** (funciona sempre, sem navegador): **Funil de clientes → Importar perfis**. Um por linha, aceitando `@perfil`, `perfil` ou a URL completa.
2. **Descoberta automática** (exige o Chrome conectado): o worker busca perfis públicos a partir das palavras-chave do ICP e lê apenas os campos públicos que a pontuação usa.

Em ambos os casos o sistema deduplica por `@`, recusa qualquer perfil na lista de não contatar e nunca cria um lead da sua própria conta.

### O ciclo automático

```
descobrir → qualificar → agendar → 1ª DM (navegador) → aguardar
   → resposta chega no webhook → propriedade passa para a API
   → interpretar intenção → decidir a próxima ação → responder ou escalar
```

Você não precisa aprovar cada passo. Dentro dos limites do `.env` e do `config/business.json`, o sistema opera sozinho. Fora deles, ele pausa a capacidade afetada e te chama.

### Ritmo

| Controle | Padrão | Variável |
| --- | ---: | --- |
| DMs por dia | 30 | `MAX_DMS_PER_DAY` |
| Intervalo entre DMs | 90–240s | `MIN/MAX_SECONDS_BETWEEN_DMS` |
| Horário de operação | 09:00–20:00 | `OPERATING_HOURS` |
| Aquecimento | 5/dia na 1ª semana, +5 por semana | automático |

São **tetos, não metas**. O motor de otimização pode operar abaixo deles; **não pode elevá-los**. Se algum componente pedir volume acima do teto, a operação é recusada com erro explícito.

### Pausar e retomar

- **Pausa geral**: no computador, botão no rodapé do menu lateral; no celular, dentro de **Mais** (o último ícone da barra inferior). Pausar é imediato e não pede confirmação. Retomar pede — é a direção que liga o envio de mensagens de volta.
- **Pausa por capacidade**: em **Configurações → Capacidades**.

### Acompanhar pelo celular

O painel é instalável: vira um aplicativo com ícone próprio, em tela cheia, sem a barra do navegador.

**Instalar:** abra o endereço público do painel no celular, faça login e use a faixa **"Instale o Orbyn"** no topo da tela:

- **Android (Chrome, Brave, Edge)** — botão *Instalar*, que abre a caixa de instalação do próprio navegador.
- **iPhone (Safari)** — o Safari não tem essa caixa, então o botão vira *Como instalar* e mostra o passo a passo: compartilhar → *Adicionar à Tela de Início*. Só funciona pelo Safari; o Chrome do iOS não oferece a opção.

Dispensou a faixa? A oferta continua em **Mais → Instalar como aplicativo**. Depois de instalado, nada disso aparece.

> **A tela de aviso do ngrok atrapalha a instalação.** Na conta gratuita, o ngrok mostra uma página de aviso antes do site. O Chrome busca o `manifest.webmanifest` **sem cookies**, então recebe essa página de aviso no lugar do JSON, conclui que o site não é instalável e o botão *Instalar* nunca aparece. Por isso a tag do manifest é declarada com `crossorigin="use-credentials"`, que manda o cookie junto e resolve. Se quiser eliminar o aviso de vez — e o toque extra em *Visit Site* a cada visita — é preciso um plano pago do ngrok ou um túnel do Cloudflare com domínio nomeado.

A instalação exige **HTTPS**, então use o endereço do túnel (`pnpm tunnel`), não `localhost`.

**Como ele se comporta:**

- Abre direto na visão geral, com DMs do dia, taxa de resposta, encaminhamentos e custo de IA na primeira tela.
- A barra inferior tem as quatro telas de acompanhamento; o resto fica em **Mais**, junto da pausa geral e do estado das capacidades.
- Sempre busca dados novos: nada de número é guardado em cache. Ao voltar para o app depois de mais de 30 segundos fora, a tela se atualiza sozinha.
- Sem rede, avisa na hora. Uma ação disparada offline não falha — fica pendente e é reenviada quando a conexão volta.

> **O endereço precisa ser fixo.** O aplicativo instalado guarda o endereço de onde foi instalado; se ele mudar, o ícone na tela inicial para de funcionar. Com `NGROK_DOMAIN` no `.env` — que é como esta instalação está — o domínio é reservado e não muda entre reinícios, então instale à vontade. Sem ele, `pnpm tunnel` cai no túnel rápido do Cloudflare, que sorteia um hostname novo a cada execução: aí o ícone dura só até o próximo `pnpm tunnel`.

Os ícones do aplicativo são desenhados por `pnpm icons` a partir da cor de destaque do painel. Rode de novo se mudar essa cor.

### Opt-out

Qualquer pedido de parada é atendido **na hora**, sem depender da OpenAI: a detecção é por regra determinística. O lead vai para `do_not_contact`, os jobs pendentes dele são cancelados, o `@` entra na lista de supressão (apenas o hash, sem dados pessoais) e nenhuma nova abordagem, follow-up ou reentrada em campanha acontece — nem por outro canal.

---

## 8. Dry-run e smoke test real

### Dry-run (não envia nada)

```bash
pnpm dryrun:dm @perfil_de_teste
```

Percorre o fluxo inteiro — capacidade, supressão, ritmo, propriedade do canal, geração da mensagem, política de conteúdo, navegação real até o campo de digitação — e **para antes de enviar**. Mostra no terminal a mensagem que *seria* enviada.

Com o Chrome conectado, a navegação é real. Sem o Chrome, o mesmo fluxo roda contra o driver simulado, e o terminal avisa qual dos dois foi usado.

### Smoke test real (envia uma DM de verdade)

Exige **três** autorizações independentes:

1. `ALLOW_REAL_DM_SMOKE_TEST=true` no `.env`
2. a flag `--i-authorize-real-dm`
3. digitar `ENVIAR` no prompt

```bash
pnpm smoke:dm -- --handle @seu_perfil_de_teste --i-authorize-real-dm
```

Use um perfil seu. Nenhum teste automatizado consegue disparar esse caminho.

---

## 9. Backup e restauração

O worker faz um backup por dia e mantém os 14 mais recentes. Você também pode gerar um agora em **Configurações → Backups → Fazer backup agora**, ou pelo terminal:

```bash
pnpm db:backup
```

Restaurar:

```bash
pnpm db:restore                      # usa o backup mais recente
pnpm db:restore backups/orbyn-....db # usa um específico
```

Antes de substituir, o sistema:

1. abre o backup em modo leitura e roda `integrity_check`;
2. confere se as tabelas essenciais existem — arquivo inválido é recusado;
3. copia o banco atual para `backups/pre-restore-*.db`, de modo que a própria restauração é reversível.

O caminho de restauração é coberto por teste automatizado.

---

## 10. Alertas: o que significam e o que fazer

| Alerta | O que aconteceu | O que fazer |
| --- | --- | --- |
| **Automação pausada por sinal de segurança** | O Instagram apresentou captcha, checkpoint, "ação bloqueada" ou aviso de atividade suspeita | Abra o Chrome dedicado e resolva **você mesmo**. O sistema nunca resolve captcha nem contorna challenge. Só retome depois de confirmar que a conta está normal — e considere reduzir `MAX_DMS_PER_DAY` |
| **Chrome do operador indisponível** | A conexão CDP falhou | Confirme que o Chrome está aberto com a porta de depuração. A fila fica parada até você retomar |
| **Webhook com assinatura inválida** | Alguém enviou ao endpoint sem a assinatura correta | Confira `INSTAGRAM_APP_SECRET`. Se estiver certo, o endpoint está exposto e recebendo tráfego de terceiros — feche o túnel |
| **Orçamento mensal de IA atingido** | O teto do `.env` foi alcançado | As chamadas ficam bloqueadas. Aumente o teto conscientemente ou aguarde o próximo mês |
| **Resposta reprovada pela política** | A mensagem gerada trazia algo não verificado | A conversa foi para revisão humana. Responda você mesmo ou ajuste `verifiedClaims` |
| **Conversa aguardando decisão humana** | Preço, prazo, proposta ou tema que exige julgamento | Assuma a conversa |
| **Job esgotou as tentativas** | Falha persistente | Veja o erro em **Fila de jobs**; corrija a causa e use **Reexecutar** |
| **Cadastro oficial alterado** | `config/business.json` mudou entre execuções | Revise claims, links e ICP |

Uma falha de integração repetida abre o **disjuntor** correspondente (visível em Configurações), que se fecha sozinho após o período de espera.

---

## 11. Privacidade e retenção

A operação é no Brasil e o sistema foi desenhado com os princípios aplicáveis de proteção de dados:

- **Minimização**: só são coletados campos públicos que a pontuação de ICP realmente usa.
- **Finalidade**: prospecção comercial da Aionixdev, nada além disso.
- **Proveniência**: cada campo coletado guarda onde foi observado.
- **Sem dados sensíveis**: nada de saúde, religião, opinião política, origem racial, filiação sindical, vida sexual ou biometria — nem para pontuar, nem para segmentar, nem para personalizar.
- **Sem enriquecimento externo**: nenhuma fonte de terceiros é consultada.
- **Retenção**: `DATA_RETENTION_DAYS` (padrão 365). Passado o prazo, leads que não viraram clientes são **anonimizados** — o `@` vira hash, os dados públicos são apagados e os textos das mensagens são removidos. Clientes ativos são preservados.
- **Supressão mínima**: quem pede para não ser contatado fica registrado apenas como hash do `@`, o suficiente para nunca ser reabordado.
- **Sem compartilhamento**: a base não é vendida, exportada nem compartilhada.

---

## 12. O que o sistema nunca faz

- Enviar placeholder, `A DEFINIR` ou template não resolvido para um lead.
- Afirmar número, percentual, ROI, economia, quantidade de clientes, case, depoimento ou garantia.
- Usar superlativo ou autoridade de mercado não comprovada.
- Criar urgência falsa, inventar relação prévia ou fingir ser cliente.
- Transformar observação do perfil em diagnóstico. "Vi que vocês trabalham com distribuição de bebidas" é permitido; "vocês devem estar perdendo dinheiro com estoque" não é.
- Resolver captcha, contornar challenge, mascarar automação, falsificar fingerprint, usar API privada ou endpoint não autorizado.
- Aumentar volume por conta própria em resposta a baixa conversão.
- Enviar pelo navegador e pela API na mesma thread — existe propriedade explícita de canal, com um único dono por vez.
- Reabordar quem pediu para parar, por qualquer canal.
- Alterar sozinho `config/business.json`, os limites máximos, as políticas de segurança, preços ou claims.
- Gravar segredo em log.
