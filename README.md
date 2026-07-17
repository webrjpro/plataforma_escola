# Plataforma Escola

Plataforma educacional com LMS, gestão escolar, vídeo, tutor por IA e transmissão ao vivo. O projeto usa React, Express, Prisma e PostgreSQL e é implantado como uma única imagem no Railway.

## Arquitetura em uma frase

Um monólito modular: uma aplicação implantável, três processos internos (`nginx`, API e worker de vídeo) e um PostgreSQL separado. Isso mantém o deploy simples sem misturar requisições HTTP com processamento FFmpeg.

```text
Navegador -> Nginx -> React / API Express -> PostgreSQL
                    -> HLS/RTMP
                         |
                    worker FFmpeg
```

Detalhes e limites estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Executar localmente

Requisitos: Docker Desktop ou Node.js 22 e PostgreSQL 16.

Com Docker:

```bash
cp .env.example .env
docker compose up --build
```

A aplicação fica em `http://localhost:5173`. O Compose local reproduz a mesma imagem usada no Railway.

Sem Docker para o código da aplicação:

```bash
npm run install:all
npm run dev --prefix backend
npm run dev --prefix frontend
```

## Qualidade

```bash
npm run quality
```

O comando executa lint, contraste, testes, builds e auditoria de dependências. Testes PostgreSQL, E2E, segurança, carga e restauração estão descritos em [docs/TESTING.md](docs/TESTING.md).

## Estrutura

```text
backend/                 API, regras, worker, Prisma e testes
frontend/                SPA React
deploy/                  runtime da imagem única
e2e/                     jornadas Playwright
scripts/                 gates operacionais reproduzíveis
docs/openapi-school.yaml contrato da API escolar
Dockerfile               imagem usada localmente e no Railway
docker-compose.yml       aplicação + PostgreSQL para desenvolvimento
railway.toml             build e healthcheck do Railway
```

Arquivos de infraestrutura alternativos foram removidos de propósito. Produção tem um único caminho suportado: Railway. O histórico Git preserva os artefatos antigos caso alguma informação precise ser recuperada.

## Documentação canônica

- [ARCHITECTURE.md](ARCHITECTURE.md): decisões, limites e dados.
- [DEPLOY.md](DEPLOY.md): configuração e deploy no Railway.
- [RUNBOOK.md](RUNBOOK.md): incidentes, rollback e restauração.
- [SECURITY.md](SECURITY.md): segurança, LGPD e IA.
- [docs/TESTING.md](docs/TESTING.md): estratégia e comandos de QA.
- [CONTRIBUTING.md](CONTRIBUTING.md): regras de contribuição.

## Estado de produção

Build e testes aprovados demonstram que o código está apto a staging; não provam produção sozinhos. A promoção exige Actions verdes no commit implantado, E2E no ambiente, verificação de restore, smoke após deploy e homologação funcional.

Nunca grave tokens ou senhas no Git. Use variáveis do Railway e revogue imediatamente qualquer segredo exposto em chat, terminal compartilhado ou arquivo temporário.
