# Plano: ComfyUI para produtos (edição, try-on e prompt → imagem)

Este plano parte do que já existe no Milaclone (node ComfyUI com workflow, prompt, variações, fotos ligadas por seta, resultados num grupo ao lado) e do que a pesquisa mostrou sobre como o pessoal resolve o mesmo problema. Nada aqui foi implementado ainda.

## 1. O que você quer

**Fluxo A — lote por vistas (edição i2i e try-on).**
Um card (grupo ou coluna, como "Camisa Manga Longa") guarda as fotos base: frente, ¾ e costas. A configuração da geração sai **desse mesmo card**, sem node solto. O resultado aparece **logo abaixo**, com uma imagem para cada vista (3 camisas vermelhas, nas 3 posições). No try-on, o card guarda as peças sem modelo e o resultado é um modelo vestindo essas peças, também em 3 vistas.

**Fluxo B — nota de prompt → imagem (T2I, com i2i opcional).**
A nota "Prompt" liga por seta ao node ComfyUI e gera **uma** imagem. Pode usar uma foto de referência (i2i) se você quiser.

## 2. Como o pessoal resolve (pesquisa)

- **Workflow vira "app" com entradas escolhidas.** O App Mode do ComfyUI deixa o autor do workflow escolher quais inputs e outputs aparecem, renomear, reordenar e esconder o resto ([docs.comfy.org/interface/app-mode](https://docs.comfy.org/interface/app-mode)). É a base da ideia de **receita** abaixo: o Milaclone mostra só o que importa e preenche o resto sozinho.
- **Try-on com Qwen Image Edit.** O template do RunComfy recebe uma foto da pessoa e até três peças, monta tudo num painel de referência e edita com um prompt ([RunComfy](https://www.runcomfy.com/comfyui-workflows/comfyui-virtual-try-on-workflow-qwen-model-clothing-fitting)). O guia da Runflow diz que o Qwen segura bem logos e estampas ([Runflow](https://www.runflow.io/blog/comfyui-qwen-image-edit)). Há também um template mais novo de edição com `image_1` (base) e `image_2` (guia, como a roupa) ([comfy.org](https://comfy.org/workflows/5fbe136ba6f9-5fbe136ba6f9/)).
- **Try-on com Flux Kontext.** Existe um LoRA de try-on entre imagens que recebe **uma imagem lado a lado**: roupa à esquerda, pessoa à direita. O autor chama de experimental, com acertos e erros ([aistudynow](https://aistudynow.com/cross-image-try-on-with-flux-kontext-lora-v0-2-in-comfyui/)). O ComfyUI também tem template nativo de Kontext com várias imagens ([comfy.org](https://comfy.org/workflows/flux_kontext_dev_basic-6f75cc57d5d6/)).
- **Várias vistas do mesmo produto.** Não achei receita verificada de frente/lado/costas com modelo consistente. Os guias de e-commerce recomendam padronizar resolução das entradas, travar a seed e ser explícito no prompt (marca, material) ([Ohneis](https://comfy.org/workflows/d16e25ecd710-d16e25ecd710/)). LoRAs de múltiplos ângulos do Qwen 2509 mudam o ponto de vista, mas relatam deriva de cor, e os ângulos customizados só funcionam às vezes ([Weird Wonderful AI](https://weirdwonderfulai.art/comfyui/qwen-edit-2509-lora-camera-multi-angle/)). **Conclusão: a vista de costas é a mais arriscada; precisa de teste com as suas peças.**
- **RunPod.** Modelos grandes ficam num network volume e o Flash Boot encurta a subida do worker. Para 24 GB de VRAM, as fontes apontam variantes fp8 de Qwen Image Edit e Flux; bf16 do Qwen pede GPU maior ([guia Qwen no RunPod](https://lilting.ch/en/articles/runpod-qwen-image-edit-setup)). Não achei medição de cold start para esses modelos; só dá para saber testando.

## 3. O que falta hoje no Milaclone

1. As fotos entram no workflow **por ordem de criação da seta**, sem papel. Com "roupa + modelo" isso troca as imagens facilmente.
2. Config e resultado ficam num **node separado**; o grupo de fotos não gera nada.
3. O prompt é digitado no card; **a nota ligada por seta é ignorada**, e a tradução gêmea (EN) não é aproveitada.
4. Os resultados caem num grupo ao lado, em colunas, **sem relação visual com a foto de origem**.
5. Sem seed travada, sem cancelar, sem "refazer só esta", sem tempo/custo, sem aviso de worker acordando.
6. O limite de 10 MB do RunPod `/run` estoura com 3–4 fotos em PNG.

## 4. Desenho proposto

### 4.1 Receita (workflow com slots nomeados)
Ao importar o workflow, o Milaclone detecta os `LoadImage` e os campos comuns e abre um passo curto de **mapeamento**:
- **Slots de imagem** com nome e papel: `Base`, `Roupa`, `Modelo`, `Pose`. Cada slot aceita 1 ou várias imagens.
- **Prompt** e **negativo** (já detectados hoje).
- **Parâmetros expostos** que você escolhe: força (denoise/strength), steps, guidance, LoRA. Os não escolhidos ficam fixos como no workflow.
- **Política de seed:** `aleatória`, `fixa` ou `fixa no lote` (mesma seed nas 3 vistas, para manter modelo e luz parecidos).
- **Modo de lote:** `uma tarefa por imagem do card` (vistas) ou `todas as imagens em uma tarefa` (peças multi-imagem).

Receitas ficam salvas; o card só escolhe a receita. Isso substitui a regra atual "n-ésima seta = n-ésimo LoadImage".

### 4.2 Fluxo A — a config mora no grupo/coluna
- O cabeçalho do grupo ganha um botão **✨ Gerar…**. Ele abre um painel preso ao grupo (receita, prompt, parâmetros) e guarda tudo em `data.comfy` do próprio grupo.
- Cada imagem dentro do grupo é uma **vista**, na ordem da esquerda para a direita. Um sufixo opcional por vista (`vista frontal`, `vista de costas`) vem do nome do card e entra no prompt.
- **Edição (i2i):** receita com slot `Base`; uma tarefa por imagem; prompt tipo "troque a camisa para vinho, mesmo tecido e caimento".
- **Try-on:** receita com `Roupa` (as peças do grupo) e `Modelo` (uma foto escolhida, marcada como modelo). O resultado é o modelo vestindo as peças. Se a vista importa, `Modelo` pode ser outro grupo com as 3 vistas do modelo.
- **Resultado:** um **novo grupo logo abaixo**, mesmo layout, cada imagem alinhada sob a sua origem, com a origem registrada (`data.comfyFrom`). Linha tracejada origem → resultado é opcional.

### 4.3 Fluxo B — nota → ComfyUI
- Nota ligada ao card ComfyUI **preenche o prompt automaticamente** (e prefere a versão EN quando existe gêmeo traduzido). O campo do card vira "prompt extra".
- Interruptor **"Usar foto de referência (i2i)"**: mostra o slot de imagem e o controle de força. Desligado, é T2I puro.
- **Uma geração** por clique; resultado aparece abaixo do card, ligado por seta.

### 4.4 Card ComfyUI mais claro
- Slots aparecem como **miniaturas** (arraste uma imagem para o slot ou ligue com seta; a miniatura confirma qual foi pega).
- Botão mostra a conta: **"Gerar 3"**. Barra de progresso por vista.
- Estado "worker acordando…" quando a tarefa fica muito tempo na fila.
- Em cada resultado: **Refazer esta** (nova seed), **Usar como entrada** (encadear etapas) e **Comparar com a origem**.
- Cancelar tarefas (RunPod `/cancel`) e tentar de novo as que falharam.
- Tempo de execução por tarefa (o RunPod devolve) e total do lote.

### 4.5 Entrada e custo
- Entradas em JPEG qualidade 90, lado maior ~1280 px (os modelos trabalham em torno de 1 MP). Isso resolve o limite de 10 MB com 3–4 fotos.
- Mesma resolução e proporção para as 3 vistas, como os guias recomendam.

## 5. Fases

| Fase | Entrega | Como testar |
|---|---|---|
| 1 | Slots nomeados, mapeamento no import, seed fixa/lote, nota ligada vira prompt, cancelar e tentar de novo | `fake-comfy` com workflow de 2 `LoadImage`; teste de ordem trocada |
| 2 | Lote por vistas no grupo, resultados alinhados abaixo, origem registrada, "Refazer esta" | e2e: grupo com 3 imagens gera 3 abaixo, na ordem |
| 3 | Try-on: slots `Roupa`/`Modelo`, multi-imagem em uma tarefa, JPEG 1280 px | e2e + teste de tamanho do payload |
| 4 | Refino do card: miniaturas nos slots, progresso por vista, tempo, "usar como entrada", comparar | e2e + captura de tela |
| 5 | Guia de setup (RunPod com network volume, fp8, Flash Boot) e receitas de exemplo | você roda no seu endpoint |

Cada fase fecha com o `npm run qa` verde antes da próxima.

## 6. Riscos

- **Consistência entre vistas.** Costas e ¾ podem inventar detalhes. A seed travada ajuda, mas só o teste com as suas peças diz se basta; talvez precise de um prompt por vista ou de uma referência da vista de costas.
- **Fidelidade da peça** (estampa, botão, costura) varia por modelo; precisa comparar Qwen e Kontext nas mesmas fotos.
- **Cold start e custo no RunPod** não têm número publicado; medir no seu endpoint.
- **Eu não consigo rodar ComfyUI nem RunPod daqui.** Tudo é testado com o servidor falso. A validação real depende de você exportar um workflow (Workflow → Export API) e rodar.

## 7. Decisões (respondidas)

- **Modelo:** Krea2 e Krea2 Edit LoRA, ComfyUI **local** (`127.0.0.1:8188`), mas o sistema não pode ficar preso a um modelo: qualquer workflow exportado funciona, com qualquer número de entradas de imagem.
- **Try-on:** a peça pode ir com ou sem modelo, por escolha do usuário em cada uso. Por isso nenhum papel é fixo: cada entrada de imagem do workflow aceita uma foto, um grupo ou "em branco".
- **Ordem das vistas:** não importa; gera uma imagem para cada foto do grupo.
- **Gerar de novo:** empilha, para escolher as melhores.

## 8. Andamento

**Fase 1 — feita** (backend, card e testes; 49 testes do servidor e 97 do navegador passando):
entradas de imagem por workflow com fonte escolhida por entrada (foto, grupo, coluna ou em branco); um grupo gera uma tarefa por foto; nota ligada vira o prompt (gêmea em inglês primeiro); qualquer campo do workflow pode ir para o card (com opções e limites vindos do ComfyUI local); seed aleatória, igual no lote ou fixa; resultados embaixo do grupo de origem, cada lote empilhado abaixo do anterior, cada imagem lembrando de qual foto veio; cancelar.

**Falta:** fase 2 (resultado alinhado sob cada foto de origem, "refazer só esta", comparar com a origem), fase 4 (refino visual do card, tempo por tarefa, "usar como entrada") e fase 5 (guia RunPod). A fase 3 (try-on) já funciona pelas entradas livres da fase 1.

**Importar workflows:** o ComfyUI local tem 25 workflows salvos, mas no formato do editor (com subgraphs), que o Milaclone não lê. Para cada um: *Workflow → Export (API)* e importar o JSON em *Configurar ComfyUI*. Converter o formato do editor automaticamente é possível, mas frágil com subgraphs; fica como melhoria opcional.
