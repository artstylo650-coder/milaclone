# Propósito e critérios de entrega

O Milaclone é um espaço visual para organizar referências: reunir fotos em lote,
comparar variações, anotar decisões, organizar tarefas e separar projetos em
boards. Velocidade e previsibilidade no trabalho com muitas imagens são prioridades.

## Regra para novos recursos

Antes de expor um botão, registrar:

- Qual tarefa real ele resolve e como reduz trabalho para o usuário.
- Como a pessoa descobre a ação e entende o resultado.
- O fluxo completo: criar, usar, modificar, salvar, reabrir e remover.
- Como se comporta em seleção múltipla, zoom, grupos e falhas relevantes.
- Qual teste comprova o resultado visível, incluindo persistência quando aplicável.

Não considerar concluído porque um elemento apareceu na tela ou uma requisição
retornou 200. A função precisa produzir o resultado esperado para o usuário.

## Revisão aplicada

| Recurso | Utilidade e decisão |
| --- | --- |
| Imagens em lote | Importar referências de uma vez; usar miniaturas reais e preservar originais. |
| Grupos | Reunir e mover referências; selecionar um grupo direciona a importação para ele, acrescenta abaixo dos membros e expande a moldura. |
| Ajustar à tela | Recuperar a visão do projeto sem procurar cards perdidos; botão e atalho F. |
| Notas e tarefas | Registrar decisões e pendências; edições rápidas de campos diferentes precisam sobreviver à recarga. |
| Nodes genéricos | Retirados da barra: não há uma tarefa útil completa nem execução de workflow. Dados existentes continuam legíveis. |
| Copiar, recortar, colar | Atuam sobre a seleção inteira. Recortar e colar move os cards originais (boards mantêm o conteúdo); copiar duplica a subárvore completa. Depois de copiar cards, colar texto ou imagem de fora continua funcionando. |
| Seleção e grupos | Clique seleciona só o card; título do grupo seleciona moldura e membros. Arrastar um card para fora do grupo o remove; apagar a moldura mantém os cards. |
| Menu de contexto | Clique direito numa seleção múltipla age sobre todos; no canvas vazio oferece colar aqui, adicionar cards, selecionar tudo e ajustar à tela. |
| Desfazer/refazer | Ctrl+Z por aba, gravado no banco; ações de várias requisições voltam num passo. |
| Lixeira e backup | Exclusões ficam 30 dias na lixeira; snapshot diário automático; backup completo (.tar.gz) para baixar e restaurar. |
| Setas | Ligam cards com rótulo e direção; somem com o card apagado; acompanham cópias. |
| Busca e adicionar | Ctrl+K busca em todos os boards (sem acento/maiúscula); duplo clique no canvas adiciona card no ponto. |
| Visualizador | Duplo clique na foto abre o original com zoom e navegação. |
| ComfyUI | Node roda workflows (API) no ComfyUI local ou RunPod Serverless; fotos ligadas por seta são entradas; resultados voltam num grupo. Testado contra servidores falsos, não contra GPU real. |
| Organização | Markdown nas notas, alinhar/distribuir/arrumar, setas do teclado, grade magnética, minimapa, tags e filtro. |
| Tempo real | Outros aparelhos abertos atualizam sozinhos (SSE); última gravação vence. |
| Export | PNG ou PDF do board ou da seleção, renderizado pelo navegador com bibliotecas servidas localmente. |
| Colunas | Layout vertical, lado a lado ou grade (botão no cabeçalho ou menu de contexto); a largura da coluna define o tamanho dos cards lado a lado. |
| Export (antigo) | Retirado: a ação só mostrava uma mensagem e não entregava arquivo. Não anunciar exportação até existir um fluxo completo e testado. |

## Navegação automatizada

Executar `npm run qa` na raiz. O script `scripts/qa.js` roda a API e todos os
cenários Chromium, incluindo `e2e/journeys.spec.js`. O script não imprime mensagens
de sucesso; retorna código 1 e diagnósticos se um teste falhar. O npm ainda pode
imprimir o cabeçalho do comando. Para execução totalmente silenciosa em sucesso:
`node scripts/qa.js`.

- Resumo e logs: `qa-report/summary.json`, `qa-report/api.log`, `qa-report/browser.log`.
- Relatório navegável: `playwright-report/index.html`.
- Evidências de falhas: `test-results/` (screenshot, vídeo e trace).
- Não há rotina agendada: o comando roda quando invocado; deve ser usado antes da entrega.
- O servidor de testes usa porta 4322 e banco/uploads em `.e2e-data/`.
  O banco e as fotos reais do usuário não são usados.

Os percursos novos usam arquivos PNG válidos e verificam a decodificação das
miniaturas, erros de JavaScript e respostas HTTP locais com erro. Incluem um
lote de 24 imagens sintéticas de 1200 × 1600, organização, recarga, retorno ao
board e deslocamento da tela com Space sobre uma foto. Isso prova o fluxo nesse
cenário; não é uma medição de desempenho para qualquer volume/hardware.

Os testes antigos continuam como regressão. Alguns usam arquivos simulados e
preparação direta de dados; não substituem os percursos completos. O comando QA
valida Chromium desktop; não implica aprovação de Safari, mobile ou acessibilidade
completa. Para mobile, instalar WebKit e executar o projeto mobile-webkit.

## Robô explorador

`npm run explore -- --steps 300 --seed 42` sobe um servidor isolado (`.explore-data/`),
cria um board com fotos, notas, coluna, grupo e seta e executa ações aleatórias
reproduzíveis: criar, digitar, arrastar, selecionar, agrupar, alinhar, copiar,
desfazer, apagar, abrir boards, ligar cards, etiquetar, filtrar, buscar, ver fotos,
redimensionar, menu de contexto, lixeira, setas do teclado e recarregar.

Depois de cada ação confere: erros de JavaScript e HTTP, cards da tela iguais ao
banco (presença e posição), referências quebradas (setas, grupos, colunas), seleção
azul nativa do navegador e estado da barra de seleção e dos modais. O relatório fica
em `qa-report/explore/report.md` com screenshot e os passos anteriores; a mesma
semente repete a sessão. Não substitui os testes de percurso: encontra regressões
fora dos caminhos previstos.

## Documentação consultada

- [Nielsen Norman Group — 10 Usability Heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/):
  prevenção de erros, reconhecimento de ações e interfaces com conteúdo relevante.
- [Playwright — Best Practices](https://playwright.dev/docs/best-practices):
  verificar comportamento visível, isolar dados e usar asserções que aguardam o resultado.
- [Playwright — Assertions](https://playwright.dev/docs/test-assertions):
  aguardar condições observáveis, sem pausas fixas para presumir sucesso.

Aplicação no projeto: expor apenas ações com propósito completo, testar por
navegação real e preservar evidências quando uma expectativa não se cumpre.
