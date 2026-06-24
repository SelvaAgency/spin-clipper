# spin-clipper

Sistema que pega o vídeo bruto (streamer + mesa/roleta) e devolve clipes prontos:
moldura aplicada, melhores momentos selecionados, legenda queimada, vinheta da
SPIN no final.

## Status atual (o que já foi testado de ponta a ponta)

✅ **Geometria da moldura** — as coordenadas das janelas de vídeo foram extraídas
direto do canal alpha dos PNGs reais (`assets/molduras/`). Testado visualmente
com clipes sintéticos: encaixa pixel-perfect nas duas molduras (split e cheia),
respeitando os cantos arredondados. Frames de prova em `data/output/frames/`
(geradas durante o desenvolvimento, não fazem parte do código).

✅ **Detecção de melhores momentos** — `astats` do ffmpeg extrai o nível de RMS
do áudio em janelas de 1s, acha picos que se destacam da média (reações:
grito, comemoração, susto). Testado e confirmado: encontra exatamente o pico
inserido num clipe sintético.

✅ **Sincronização de áudio** — quando vier streamer e mesa em arquivos
separados, um script Python (`scripts/sync_audio.py`) usa correlação cruzada
pra achar o offset entre os dois. Funciona, mas com uma ressalva importante
(ver "Limitações" abaixo).

✅ **Legenda** — gera `.ass` estilizado a partir da transcrição e queima no
vídeo. Testado com transcrição simulada.

✅ **Vinheta final** — concatena o clipe com o vídeo padrão da SPIN, com
fallback automático pra quando a vinheta (ou o clipe) não tem trilha de áudio
(que é o caso do "spin final.mp4" que você mandou print — só logo, sem som).

⚠️ **Seleção semântica via IA (Claude)** e **transcrição (AssemblyAI)** —
implementadas mas não testadas de ponta a ponta porque dependem de chaves de
API que não configurei aqui (ver `.env.example`). O código tem fallback: sem
`ANTHROPIC_API_KEY`, usa só os picos de áudio; sem `ASSEMBLYAI_API_KEY`, pula
legenda.

🔲 **Ainda não testei com vídeo real de vocês** — tudo acima foi validado com
clipes sintéticos (testsrc + tons gerados). A lógica de corte/composição/
sincronização está pronta, mas só fica 100% confirmada com filmagem real
(câmera de streamer + mesa).

## Como rodar local

```bash
npm install
cp .env.example .env   # preenche as chaves se quiser transcrição + seleção por IA
npm run dev            # sobe o servidor em http://localhost:3000
```

Abre `http://localhost:3000` no navegador: upload dos vídeos, escolhe a
moldura, manda processar. O log de progresso aparece em tempo real.

Pra testar sem vídeo real, gera clipes sintéticos e roda o teste de composição:

```bash
npm run test:compose       # gera 3 vídeos de teste em data/output/
npm run inspect-molduras   # confere se as coordenadas das janelas ainda batem
```

## Arquitetura

```
src/
  server.ts          API Express: upload, dispara o pipeline, serve os clipes
  pipeline.ts         orquestra tudo: sync → detecção → transcrição → seleção → composição → legenda → vinheta
  lib/
    molduras.ts        coordenadas das janelas de vídeo (extraídas dos PNGs)
    inspectMolduras.ts re-extrai as coordenadas se a moldura mudar de design
    compose.ts          monta o overlay (streamer + mesa, ou fonte única) na moldura
    highlightDetect.ts  acha picos de reação no áudio (rápido, local, sem custo)
    sync.ts             alinha temporalmente streamer x mesa quando vêm em arquivos separados
    transcribe.ts       transcrição via AssemblyAI (pt-BR, com timestamp por palavra)
    selectHighlights.ts cruza picos + transcrição, manda pro Claude ranquear (com fallback)
    captions.ts          gera e queima legenda estilizada (.ass)
    outro.ts             concatena com a vinheta final
    jobStore.ts          guarda status/log dos jobs (JSON simples, sem dependência nativa)
    ffmpegUtils.ts        wrapper de execução de comandos + ffprobe
scripts/
  sync_audio.py         helper Python (numpy/scipy) pra cross-correlation de áudio
  test-compose.ts        gera clipes sintéticos e testa as duas molduras
public/
  index.html             interface de upload (server serve isso direto por enquanto)
assets/molduras/         os PNGs reais que vocês mandaram
```

## Plano de deploy (Vercel + Railway, igual ao BIT)

Processamento de vídeo (ffmpeg, transcrição, IA) não roda bem em função
serverless da Vercel: o limite de tempo de execução e a falta de disco
persistente matam qualquer vídeo mais longo. A separação que faz sentido,
seguindo o que vocês já fazem no BIT:

- **Railway** roda este repo como está (Node + ffmpeg + disco persistente,
  sem limite de tempo de execução). É aqui que o processamento pesado
  acontece.
- **Vercel** hospeda só a interface (pode ser este mesmo `public/index.html`
  por enquanto, ou um Next.js depois se quiser algo mais robusto), que chama
  a API do Railway.
- Pra upload de vídeos grandes, o ideal é trocar o upload direto pro Express
  (que passa pela função serverless) por upload direto num bucket (Cloudflare
  R2 ou S3) com URL pré-assinada, e a API do Railway só recebe a URL. Não
  implementei isso ainda porque exigiria decidir o provedor de storage com
  vocês — com poucos uploads por dia, o upload direto que já está
  implementado aqui aguenta tranquilo pra começar.

## Limitações conhecidas (importante ler antes de usar com vídeo real)

1. **Sincronização entre streamer e mesa via correlação de áudio só funciona
   se houver algum som em comum entre as duas gravações** (ex: o microfone do
   streamer capta um pouco do ambiente da mesa, ou as duas têm a mesma trilha
   de fundo). Se as duas fontes forem completamente isoladas, a confiança sai
   baixa e o pipeline avisa no log em vez de aplicar um offset errado sem
   avisar. Solução mais simples e confiável: um marcador sonoro (palma,
   clap) no início das duas gravações — aí a sincronização manual fica
   trivial. Vale conversar sobre isso antes de depender 100% da
   correlação automática.

2. **Detecção de áudio é por reação, não por conteúdo do jogo.** Ela acha
   "o streamer reagiu forte aqui", não "rolou um 21 no blackjack aqui". Se
   teve um momento visualmente incrível mas o streamer ficou calado, ela não
   vai pegar. A confirmação por IA (Claude + transcrição) ajuda a filtrar
   falsos positivos (tosse, barulho), mas não substitui sinal visual — se
   isso for um problema na prática, dá pra evoluir pra também olhar mudança
   de cena/movimento na mesa (chip sendo empilhado, roleta parando), mas
   é mais trabalho e eu não implementaria sem ver primeiro se o sinal de
   áudio já resolve a maioria dos casos.

3. **Não testei com filmagem real.** Preciso de pelo menos um vídeo de
   exemplo (streamer + mesa, ou já combinado) pra calibrar os limiares de
   detecção (`thresholdAboveMeanDb`, `minGapSec` em `highlightDetect.ts`) —
   os valores atuais são um ponto de partida razoável, não algo testado em
   produção.

4. **ffmpeg neste ambiente de desenvolvimento é lento** (sandbox com CPU
   limitada — um clipe de 11s levou ~2min pra renderizar). Numa máquina
   normal ou no Railway isso deve ser bem mais rápido, mas vale medir o
   tempo real de processamento por clipe antes de prometer um SLA pra
   equipe de conteúdo.

## Próximos passos sugeridos

1. Vocês me mandam um vídeo de exemplo real (ou os dois, streamer + mesa) +
   o arquivo de vídeo da vinheta (`spin final.mp4` de verdade, não só o
   print). Eu calibro a detecção e confirmo o pipeline completo.
2. Decidir se vale a pena investir no marcador sonoro pra sincronização, ou
   se vocês preferem sempre mandar um arquivo já combinado.
3. Configurar as chaves de API (AssemblyAI + Anthropic) pra ativar legenda e
   seleção semântica.
4. Subir isso no Railway e apontar um front simples na Vercel.
