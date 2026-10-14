<div align="center">
  <img src="public/icons/icon.svg" width="96" height="96" alt="Ícone do Milaclone">
  <h1>Milaclone</h1>
  <p><strong>Um espaço visual open source para organizar ideias, referências e fluxos de criação com IA.</strong></p>
  <p>Quadros infinitos, notas, imagens, tarefas, conexões e integração com ComfyUI —<br>tudo armazenado localmente e sob seu controle.</p>
  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/licen%C3%A7a-MIT-blue.svg" alt="Licença MIT"></a>
    <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-20.9%2B-339933?logo=node.js&amp;logoColor=white" alt="Node.js 20.9 ou mais recente"></a>
    <a href="CHANGELOG.md"><img src="https://img.shields.io/github/package-json/v/artstylo650-coder/milaclone?label=vers%C3%A3o&amp;color=7c4dff" alt="Versão atual"></a>
  </p>
</div>

> [!IMPORTANT]
> Este projeto é uma versão expandida do [Milaclone original](https://github.com/ellshep/milaclone),
> criado por [Ellington Shephard (`@ellshep`)](https://github.com/ellshep) e disponibilizado sob a
> licença MIT. A licença e o copyright do autor original foram preservados.
> Esta versão acrescenta, entre outros recursos, integração com ComfyUI e RunPod, instalador para
> Windows, tradução, temas, conexões entre cards, histórico, lixeira, backups e exportação.

<p align="center">
  <img src="docs/assets/milaclone-overview.png" alt="Milaclone mostrando referências visuais, notas, tarefas, conexões e um workflow do ComfyUI" width="100%">
</p>
<p align="center"><em>Organize referências, decisões e geração de imagens no mesmo quadro.</em></p>

## Sumário

- [Sobre o projeto](#sobre-o-projeto)
- [Principais recursos](#principais-recursos)
- [O que esta versão acrescenta](#o-que-esta-versão-acrescenta)
- [Instalação rápida](#instalação-rápida)
- [Como usar](#como-usar)
- [ComfyUI e RunPod](#comfyui-e-runpod)
- [Dados, privacidade e backups](#dados-privacidade-e-backups)
- [Configuração](#configuração)
- [Acesso remoto com Tailscale](#acesso-remoto-com-tailscale)
- [Desenvolvimento](#desenvolvimento)
- [Limitações conhecidas](#limitações-conhecidas)
- [Contribuição](#contribuição)
- [Créditos e licença](#créditos-e-licença)

## Sobre o projeto

O Milaclone é um quadro visual auto-hospedado inspirado na experiência de ferramentas como
Milanote. Ele permite reunir notas, listas, links, arquivos, imagens e quadros aninhados em um
canvas livre, com zoom e navegação infinita.

Esta versão também funciona como interface visual para geração de imagens: fotos, prompts e
resultados podem ser conectados diretamente a workflows do ComfyUI. O frontend usa JavaScript,
HTML e CSS puros, sem etapa de build, e o backend é uma aplicação Node.js com banco SQLite.

Os dados ficam na sua máquina. Não há conta obrigatória, servidor de banco separado ou serviço
de nuvem necessário para usar os recursos básicos.

## Principais recursos

### Quadros e conteúdo

- Canvas infinito com pan, zoom, grade magnética e minimapa.
- Cards de nota, tarefa, link, comentário, imagem, arquivo, coluna, grupo e subquadro.
- Quadros aninhados com navegação por breadcrumb.
- Linhas e setas entre cards, com rótulo, cor e estilo de ponta.
- Arrastar, redimensionar, alinhar, distribuir, agrupar, bloquear e organizar cards.
- Colunas em pilha, lado a lado ou em grade.
- Markdown em notas e visualizador de imagens em tela cheia.
- Tags, filtro por quadro e busca global com `Ctrl+K` ou `/`.

### Segurança dos dados

- Salvamento automático em SQLite.
- Desfazer e refazer por aba.
- Lixeira com retenção padrão de 30 dias.
- Snapshots diários automáticos do banco.
- Backup e restauração completos em `.tar.gz`.
- Exportação do quadro ou da seleção para PNG e PDF.
- Atualização ao vivo entre abas e dispositivos conectados.

### Personalização e aplicativo

- Interface em português.
- Temas claro, escuro, sépia e grafite.
- Quatro combinações de fontes.
- PWA instalável pelo navegador.
- Instalador para Windows, atalho próprio e inicialização automática opcional.
- Atualizador integrado com backup antes de alterações no banco.

### Criação com IA

- Integração com ComfyUI local e RunPod Serverless.
- Workflows de texto para imagem, edição, variações e upscale.
- Processamento em lote a partir de grupos de imagens.
- Controle de prompt, seed, proporção, qualidade e campos do workflow.
- Tradução PT ⇄ EN por MyMemory, preservando sintaxe comum de prompts.

## O que esta versão acrescenta

Em relação ao [projeto original](https://github.com/ellshep/milaclone), este fork amplia a base em
várias áreas:

| Área | Base original | Esta versão |
|---|---|---|
| Organização | Cards, colunas e quadros aninhados | Grupos, tags, busca, minimapa, alinhamento e grade magnética |
| Conexões | Organização espacial | Linhas e setas com texto, cor e pontas |
| Histórico | Salvamento automático | Desfazer/refazer, lixeira, snapshots e backup completo |
| Imagens | Upload e visualização | Exportação PNG/PDF, lightbox, lotes e aprimoramento |
| IA | Não integrada | ComfyUI local, RunPod Serverless e workflows configuráveis |
| Idioma | Interface original em inglês | Interface em português e tradução PT ⇄ EN |
| Aparência | Visual base | Quatro temas, pares de fontes e interface reorganizada |
| Windows | Execução manual com Node.js | Instalador, atalhos, inicialização oculta e atualização integrada |
| Qualidade | Testes da base | Suíte ampliada de testes de API e testes de ponta a ponta |

O histórico detalhado das versões está em [CHANGELOG.md](CHANGELOG.md).

## Instalação rápida

### Windows — opção mais simples

1. Instale o [Node.js 20.9 ou mais recente](https://nodejs.org/).
2. Baixe ou clone este repositório.
3. Execute **`Instalar Milaclone.bat`**.
4. Abra o atalho **Milaclone** criado na Área de Trabalho ou no menu Iniciar.

O instalador baixa as dependências, cria os atalhos e registra uma tarefa que mantém o servidor
rodando de forma oculta após o login. O Chrome ou Edge abre o projeto como uma janela de
aplicativo, sem abas ou barra de endereço.

Para remover a tarefa e os atalhos, execute **`Desinstalar Milaclone.bat`**. Seus quadros,
uploads e backups não são apagados.

### Node.js — qualquer sistema

Requisitos:

- [Node.js](https://nodejs.org/) 20.9 ou mais recente;
- Git, caso queira receber atualizações pelo repositório.

```bash
git clone https://github.com/artstylo650-coder/milaclone.git
cd milaclone
npm install
npm start
```

Abra <http://localhost:4321> no navegador.

Para usar outra porta:

```bash
PORT=8080 npm start
```

No PowerShell:

```powershell
$env:PORT = 8080
npm start
```

### Docker

O `docker-compose.yml` inclui a aplicação e um sidecar do Tailscale. Crie um arquivo
`.env` na raiz com a chave de autenticação:

```env
TS_AUTHKEY=tskey-auth-COLOQUE_SUA_CHAVE_AQUI
```

Depois execute:

```bash
docker compose up -d --build
```

O serviço fica disponível localmente na porta `8182`. Os dados persistem nos volumes
`milaclone_data`, `milaclone_uploads` e `milaclone_ts_state`.

> [!CAUTION]
> `docker compose down` preserva seus dados. `docker compose down -v` remove os volumes e apaga
> quadros, uploads e a identidade do nó Tailscale.

## Como usar

### Criar e organizar cards

Use a barra lateral, dê dois cliques em uma área vazia ou pressione um atalho:

| Ação | Atalho |
|---|---|
| Nova nota | `N` |
| Novo link | `L` |
| Nova tarefa | `T` |
| Novo quadro | `B` |
| Nova coluna | `C` |
| Novo comentário | `M` |
| Buscar ou executar comandos | `Ctrl+K` ou `/` |
| Agrupar / desagrupar | `Ctrl+G` / `Ctrl+Shift+G` |
| Desfazer / refazer | `Ctrl+Z` / `Ctrl+Shift+Z` ou `Ctrl+Y` |
| Copiar / recortar / colar | `Ctrl+C` / `Ctrl+X` / `Ctrl+V` |
| Duplicar | `Ctrl+D` |
| Selecionar tudo | `Ctrl+A` |
| Ajustar o quadro à tela | `F` |
| Editar o card selecionado | `Enter` |
| Mover para a lixeira | `Delete` ou `Backspace` |

As setas movem a seleção; com `Shift`, o deslocamento é de 10 px. Segure `Espaço` e arraste para
mover o canvas. Em notas, `Ctrl+B` aplica negrito e `Ctrl+I` aplica itálico em Markdown.

### Conectar cards

Crie uma linha entre dois cards para representar uma relação ou um fluxo. A conexão pode receber
texto, cor e pontas. No fluxo de ComfyUI, as conexões também indicam quais imagens e notas serão
usadas como entradas.

### Buscar, filtrar e exportar

- `Ctrl+K` pesquisa conteúdo em todos os quadros.
- Tags ajudam a filtrar o quadro atual.
- O menu **⋯** permite baixar um backup completo ou restaurar um arquivo anterior.
- Um quadro inteiro ou apenas a seleção pode ser exportado como PNG ou PDF.

## ComfyUI e RunPod

O card **ComfyUI** conecta o quadro a uma instalação local do
[ComfyUI](https://github.com/comfyanonymous/ComfyUI) ou a um endpoint RunPod Serverless com
[`worker-comfyui`](https://github.com/runpod-workers/worker-comfyui) 5.x.

### Configuração básica

1. Adicione um card **ComfyUI** pela barra lateral ou digitando “comfy” após dois cliques no
   canvas.
2. Abra a engrenagem do card e escolha **ComfyUI local** ou **RunPod Serverless**.
3. No ComfyUI, use **Workflow → Export (API)** e importe o JSON exportado no Milaclone.
4. Selecione os campos do workflow que deseja controlar no quadro.
5. Conecte imagens ou grupos às entradas e, opcionalmente, uma nota ao prompt.
6. Ajuste prompt, proporção, qualidade, quantidade e seed; então pressione **Gerar** ou
   `Ctrl+Enter`.

Os resultados aparecem em grupos próximos às imagens de origem. Cada novo lote fica separado
para facilitar a comparação.

### Tipos de workflow

- **Texto para imagem:** recebe o prompt e gera uma ou mais imagens.
- **Edição:** mostra a imagem original e permite compará-la com o resultado.
- **Upscale/aprimoramento:** usa uma imagem como entrada e destaca a resolução de saída.
- **Lote:** um grupo alimenta uma tarefa por imagem; dois grupos são pareados pela posição.

O botão **Escolher campos** expõe valores simples do workflow, como steps, dimensões, sampler,
CFG e força de LoRA. O modo de qualidade reduz temporariamente os campos de tamanho para testes
mais rápidos; volte para **Final** antes da geração definitiva.

### ComfyUI local

O endereço padrão é `http://127.0.0.1:8188`. Nas configurações você também pode informar o
arquivo que inicia o ComfyUI — por exemplo, `run_nvidia_gpu.bat` na versão portátil. Quando o
serviço estiver desligado, o Milaclone poderá iniciá-lo e aguardar até que fique disponível.

Esse caminho só pode ser configurado no próprio computador que executa o servidor.

### RunPod Serverless

Informe o endpoint ID e a chave da API nas configurações ou por variáveis de ambiente. A chave
permanece no backend e não é enviada ao navegador. Cada variação é submetida como uma tarefa
separada, permitindo que vários workers processem o lote em paralelo.

Imagens de entrada são limitadas a 2048 px para respeitar o tamanho máximo da requisição. O
primeiro trabalho pode demorar mais enquanto o worker inicia.

### Aprimoramento em lote

O ícone de aprimoramento de uma imagem abre as opções de upscale. É possível processar:

- somente a imagem atual;
- a seleção;
- todas as imagens do grupo;
- imagens ainda não aprimoradas do quadro, até 64 por execução.

Os resultados aparecem próximos ao grupo de origem e recebem a marca **Aprimorada**.

### Tradução de prompts

Notas podem ser traduzidas entre português e inglês pelo serviço MyMemory. A tradução cria um
card relacionado e preserva construções comuns de prompts, como `<lora:...>`, pesos e separação
por vírgulas. O e-mail é opcional e serve apenas para ampliar a cota gratuita do serviço.

## Dados, privacidade e backups

| Conteúdo | Local padrão |
|---|---|
| Quadros e configurações | `data/board.db` |
| Snapshots automáticos | `data/backups/` |
| Imagens e arquivos | `public/uploads/` |

Esses caminhos estão no `.gitignore`: seus quadros, uploads, backups e arquivos `.env` não são
incluídos em commits normais.

O servidor cria um snapshot ao iniciar quando o último backup tem mais de um dia e continua
criando cópias diariamente. Por padrão, mantém as 14 mais recentes. Para proteção contra falha
do disco, configure `BACKUP_DIR` em outra unidade ou em um NAS.

O menu **⋯ → Baixar backup** cria um `.tar.gz` com o banco e os uploads. Ao restaurar um backup,
o estado atual é copiado antes da substituição.

> [!WARNING]
> O Milaclone não possui autenticação de usuários. Não exponha a porta diretamente à internet.
> Para acesso remoto, prefira uma rede privada como Tailscale ou um proxy com autenticação.

## Configuração

Todas as variáveis são opcionais:

| Variável | Padrão | Finalidade |
|---|---|---|
| `PORT` | `4321` | Porta HTTP da aplicação |
| `HOST` | `0.0.0.0` | Interface de rede usada pelo servidor |
| `DATA_DIR` | `./data` | Diretório do banco SQLite |
| `UPLOAD_DIR` | `public/uploads` | Diretório de imagens e arquivos |
| `BACKUP_DIR` | `DATA_DIR/backups` | Diretório dos snapshots |
| `BACKUP_INTERVAL_HOURS` | `24` | Intervalo entre snapshots |
| `BACKUP_KEEP` | `14` | Quantidade de snapshots mantidos |
| `TRASH_DAYS` | `30` | Dias de retenção na lixeira |
| `COMFYUI_URL` | `http://127.0.0.1:8188` | Endereço do ComfyUI local |
| `TRANSLATE_API` | MyMemory | Serviço de tradução compatível |
| `RUNPOD_ENDPOINT_ID` | — | ID do endpoint RunPod Serverless |
| `RUNPOD_API_KEY` | — | Chave da API RunPod, usada apenas no servidor |

As opções do ComfyUI e RunPod também podem ser definidas em **⋯ → Configurações do ComfyUI**.
Variáveis de ambiente têm prioridade.

## Acesso remoto com Tailscale

O Docker Compose inclui um sidecar Tailscale que publica o Milaclone dentro da sua tailnet sem
expor a aplicação à internet aberta.

| Componente | Função |
|---|---|
| `TS_AUTHKEY` no `.env` | Autentica o nó na primeira execução |
| `TS_HOSTNAME` | Define o nome do dispositivo na tailnet |
| `tailscale/serve.json` | Encaminha HTTPS para `app:4321` |
| `milaclone_ts_state` | Preserva a identidade do nó |

Após subir o Compose, o endereço segue o formato:

```text
https://mila.seu-tailnet.ts.net
```

Para diagnosticar problemas:

```bash
docker compose logs tailscale
docker compose exec tailscale tailscale status
docker compose exec tailscale tailscale serve status
```

Sem Docker, também é possível iniciar o app com `npm start` e publicar a porta pela instalação
local do Tailscale:

```bash
sudo tailscale serve --bg 4321
```

## Atualizações

A versão atual aparece em **⋯ → Sobre o Milaclone**. O aplicativo verifica se há novos commits e
permite atualizar no próprio computador. Antes da atualização, cria um snapshot do banco e recusa
o processo caso existam alterações locais não commitadas.

No Windows, **`Atualizar Milaclone.bat`** executa o mesmo processo. Para atualização manual:

```bash
git pull --ff-only
npm install
npm start
```

Consulte [CHANGELOG.md](CHANGELOG.md) antes de atualizar.

## Desenvolvimento

### Estrutura do projeto

```text
backend/             banco, rotas, backups, histórico, tradução e ComfyUI
public/              interface web, estilos, ícones e service worker
public/js/board/     comportamento do canvas e dos cards
public/js/core/      estado, API, Markdown e utilitários
public/js/features/  ComfyUI, aprimoramento, tradução e notas rápidas
public/js/ui/        menus, painéis, temas, lightbox e exportação
scripts/windows/     instalação, inicialização e remoção no Windows
test/                testes de unidade e integração da API
e2e/                 testes de ponta a ponta com Playwright
docs/                documentação técnica complementar
```

Mais detalhes estão em [docs/ARQUIVOS.md](docs/ARQUIVOS.md) e
[docs/QUALITY.md](docs/QUALITY.md).

### Testes

```bash
npm test             # testes de unidade e integração
npm run test:e2e     # testes no navegador com Playwright
npm run qa           # validação completa do projeto
```

Antes dos testes de navegador, instale o Chromium do Playwright uma vez:

```bash
npx playwright install chromium
```

### Tecnologias

- Backend: Node.js, Express, better-sqlite3, Multer, Sharp e tar.
- Frontend: JavaScript, HTML e CSS sem framework ou bundler.
- Testes: `node:test` e Playwright.
- Persistência: SQLite e sistema de arquivos local.

## Limitações conhecidas

- Não há autenticação nem separação entre usuários.
- Alterações chegam a outras abas em tempo real, mas conflitos usam “última gravação vence”.
- Não há desenho à mão livre nem threads de comentários.
- Workflows do ComfyUI precisam ser exportados no formato API.
- A disponibilidade e a cota de tradução dependem do serviço MyMemory.

## Contribuição

Issues, relatos de teste e pull requests são bem-vindos. Ao relatar um problema, inclua:

- sistema operacional e versão do Node.js;
- forma de instalação: Windows, Node.js ou Docker;
- passos para reproduzir;
- comportamento esperado e observado;
- logs relevantes sem chaves, tokens ou dados pessoais.

Antes de enviar um pull request, execute:

```bash
npm test
npm run test:e2e
```

Nunca inclua `.env`, bancos de `data/`, backups ou conteúdo de `public/uploads/`.

## Créditos e licença

- **Projeto original:** [Milaclone](https://github.com/ellshep/milaclone), criado por
  [Ellington Shephard (`@ellshep`)](https://github.com/ellshep).
- **Esta versão expandida:** mantida por
  [`@artstylo650-coder`](https://github.com/artstylo650-coder).
- **Referências adicionais:** consulte [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Distribuído sob a [Licença MIT](LICENSE). O aviso de copyright do autor original deve permanecer
nas cópias e redistribuições.

“Milanote” é uma marca de seus respectivos proprietários. Este projeto é independente, não
oficial e não possui afiliação com o Milanote.
