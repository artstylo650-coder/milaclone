# Changelog

Cada versão segue `MAIOR.MENOR.CORREÇÃO`: correção quando só conserta, menor quando traz recurso novo, maior quando muda algo que exige atenção ao atualizar. Antes de qualquer atualização o Milaclone faz um backup do banco (`data/backups/board-…-before-update.db`).

## 1.0.0 — consolidação

Primeira versão fechada, reunindo tudo que foi feito sobre a base original do Milanote-clone.

### Boards
- Cards de nota, tarefas, link, imagem, arquivo, comentário, board, coluna e grupo; setas entre cards com texto, pontas e cor.
- Desfazer/refazer (Ctrl+Z / Ctrl+Y), por aba, guardado no SQLite; lixeira de 30 dias; backups automáticos diários e exportação/restauração em `.tar.gz`; atualização ao vivo entre abas.
- Alinhar, distribuir e arrumar; grade magnética; minimapa; tags e filtro; busca (Ctrl+K); exportar PNG/PDF.
- Colunas em pilha, lado a lado ou em grade; boards redimensionáveis.
- Interface em português, 4 temas (claro, escuro, sépia, grafite) e 4 pares de fontes.
- Notas: clicar coloca o cursor onde clicou, Enter no título vai para o texto, arrastar o mouse seleciona texto.
- Tradução PT ⇄ EN pelo MyMemory (sem IA): card gêmeo ligado por seta, mantendo tags `<lora:…>`, pesos e vírgulas.

### ComfyUI
- Ponte com ComfyUI local ou RunPod Serverless: workflows exportados em formato API, uma tarefa por foto de um grupo, resultados em grupos empilhados com linha de volta à origem, cancelar, recuperar imagens, ligar o ComfyUI sozinho.
- O card **é a imagem**: nome e atalhos em cima, barra flutuante ao selecionar (prompt, proporção desenhada, qualidade, imagens por foto, seed), anel de progresso com passo atual, brilho enquanto gera.
- Muda conforme o workflow: texto→imagem, edição (mostra a original, comparar segurando o botão) e upscale (sem prompt, resolução em destaque).
- Aprimorar (upscale) em lote: ícone em cada imagem, menu, barra de seleção; limite de 64 por vez.
- Campos do workflow à escolha, modo de teste com tamanho reduzido, seed fixa/igual no lote.

### Aplicativo
- Instalação como app do Windows (`Instalar Milaclone.bat`): liga com o Windows, atalho com janela própria, PWA instalável.
- Versão e atualização pelo GitHub: menu ⋯ → Sobre o Milaclone, ou `Atualizar Milaclone.bat`.
- Migrações do banco com backup antes de cada mudança.
