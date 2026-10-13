# Mapa dos arquivos

O que cada arquivo faz. Cada arquivo também começa com um comentário (em inglês,
como o resto do código) explicando sua função.

## Raiz

| Arquivo | Função |
| --- | --- |
| `server.js` | Ponto de entrada. Sobe o Express, serve a interface (`public/`), as fotos (`/uploads`), as bibliotecas de exportação (`/vendor`) e a API. Liga o backup automático. |
| `Iniciar Milaclone.bat` | Atalho do Windows: inicia o servidor e abre o navegador. |
| `Dockerfile`, `docker-compose.yml` | Container e implantação no servidor (Tailscale). |
| `playwright.config.js` | Configuração dos testes de navegador. |

## `backend/` — servidor

| Arquivo | Função |
| --- | --- |
| `db.js` | Banco SQLite: tabelas, consultas prontas, apagar em cascata (board com tudo dentro). |
| `routes.js` | Todos os endereços da API: boards, cards, upload, miniaturas, busca, lixeira, backup, eventos ao vivo, ComfyUI. |
| `transfer.js` | Copiar e mover seleções inteiras (com colunas, grupos, setas e boards aninhados) numa única operação. |
| `history.js` | Desfazer/refazer: grava cada mudança no banco e reverte por aba. |
| `trash.js` | Lixeira: guarda o que foi apagado por 30 dias e restaura. |
| `backup.js` | Cópia automática diária do banco, exportar e restaurar backup completo (.tar.gz). |
| `events.js` | Atualização ao vivo: avisa outros aparelhos abertos quando um board muda. |
| `comfy.js` | Ponte com ComfyUI local e RunPod Serverless: monta o workflow, envia, acompanha e traz as imagens. |
| `version.js` | Número da versão (package.json) e commit do git em uso. |
| `update.js` | Verificar e aplicar atualizações pelo git (backup antes, reinicia o servidor). Só aceita pedidos do próprio computador. |
| `migrate.js` | Migrações numeradas do banco, com backup antes de cada mudança real. |
| `translate.js` | Tradução PT ⇄ EN das notas pelo MyMemory (grátis, sem IA, sem chave), linha por linha, preservando tags `<lora:…>`, pesos e vírgulas. |

## `public/` — interface

| Arquivo | Função |
| --- | --- |
| `index.html` | Estrutura da página (barra superior, barra lateral, canvas, painéis do celular). |
| `style.css` | Todo o visual, com os temas (claro, escuro, sépia, grafite). |
| `js/main.js` | Ponto de entrada da interface: navegação entre boards, atalhos de teclado, área de transferência, atualização ao vivo, lista de comandos. |

### `public/js/core/` — base

| Arquivo | Função |
| --- | --- |
| `state.js` | Estado compartilhado (board aberto, câmera, seleção). |
| `api.js` | Chamadas ao servidor; marca cada ação para o desfazer. |
| `util.js` | Ajudantes: cores, ícones, mensagens rápidas (toast). |
| `markdown.js` | Formatação das notas (negrito, listas, títulos) de forma segura. |

### `public/js/board/` — o canvas

| Arquivo | Função |
| --- | --- |
| `cards.js` | Desenha todos os tipos de card (nota, foto, coluna, board, grupo…). |
| `create.js` | Tamanho padrão de cada card e criação no ponto clicado. |
| `editing.js` | Seleção, edição de texto, salvamento automático, apagar, agrupar. |
| `drag.js` | Arrastar cards, entrar/sair de colunas, redimensionar. |
| `groups.js` | Descobre em qual grupo um card caiu. |
| `connections.js` | Setas entre cards e ligações dos nodes. |
| `clipboard.js` | Copiar, recortar, colar, duplicar, travar posição. |
| `arrange.js` | Alinhar, distribuir, arrumar em grade, setas do teclado, grade magnética. |
| `viewport.js` | Zoom, mover a câmera, ajustar à tela. |
| `minimap.js` | Minimapa no canto. |
| `tags.js` | Tags nos cards e filtro do board. |
| `history.js` | Botões e atalhos de desfazer/refazer. |
| `tools.js` | Barra lateral de ferramentas, seleção por caixa, importar fotos (arrastar, colar, escolher). |

### `public/js/ui/` — janelas e menus

| Arquivo | Função |
| --- | --- |
| `menus.js` | Menu do clique direito e paleta de cores/ícones. |
| `panel.js` | Janelas modais e confirmações. |
| `appmenu.js` | Menu "⋯" do topo: lixeira, backup, aparência, exportar. |
| `theme.js` | Temas de cor e escolha de fonte. |
| `cmdk.js` | Busca Ctrl+K e "adicionar aqui" do duplo clique. |
| `lightbox.js` | Visualizador de foto em tela cheia. |
| `boardchrome.js` | Barra lateral de propriedades quando um board está selecionado. |
| `mobile.js` | Cabeçalho e rodapé do celular. |
| `export.js` | Exportar board ou seleção em PNG/PDF. |

### `public/js/features/` — recursos maiores

| Arquivo | Função |
| --- | --- |
| `comfynode.js` | Card do ComfyUI e janela de configuração. |
| `translate.js` | Card gêmeo traduzido (PT ⇄ EN) ligado por seta tracejada; janela ⋯ → Tradução. |
| `update.js` | Janela "Sobre o Milaclone": versão, verificar e aplicar atualizações. |
| `enhance.js` | Aprimorar imagens (upscale): ícone, menu, barra de seleção, progresso e janela de opções. |
| `quicknotes.js` | Notas rápidas (tarefas) do celular. |

## Testes e ferramentas

| Pasta | Função |
| --- | --- |
| `test/` | Testes do servidor (`npm test`), servidores falsos de ComfyUI/RunPod e do tradutor. |
| `e2e/` | Testes no navegador real (`npm run test:e2e`). |
| `scripts/qa.js` | Roda todos os testes antes de entregar (`npm run qa`). |
| `scripts/explore.js` | Robô que navega sozinho procurando problemas (`npm run explore`). |

## Windows e pacote

| Arquivo | O que faz |
|---|---|
| `Instalar Milaclone.bat` | Instala como app: liga com o Windows e cria os atalhos. |
| `Desinstalar Milaclone.bat` | Remove a tarefa e os atalhos (boards e imagens ficam). |
| `Atualizar Milaclone.bat` | `git pull`, `npm install` e reinicia o servidor. |
| `Iniciar Milaclone.bat` | Abre o servidor à mão, numa janela de console. |
| `scripts/windows/servidor.ps1` | Mantém o servidor ligado em segundo plano e reinicia se cair (ou após atualizar). |
| `scripts/windows/iniciar-oculto.vbs` | Roda o `servidor.ps1` sem janela. |
| `scripts/windows/instalar.ps1` / `desinstalar.ps1` | O trabalho dos `.bat` acima. |
| `scripts/make-icons.js` | Desenha o ícone e gera `public/icons/*` (PWA, favicon, `.ico`). |
| `public/manifest.webmanifest`, `public/sw.js` | Tornam o Milaclone instalável como PWA. |
| `CHANGELOG.md` | Histórico das versões. |
