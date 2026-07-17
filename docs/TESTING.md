# Testes e gates de release

Este documento define o conjunto mínimo de QA. Testes permanecem no repositório porque reduzem risco; relatórios históricos pertencem ao histórico do Git ou aos artefatos do CI.

## Gate local rápido

```bash
npm run install:all
npm run quality
```

Inclui lint do frontend, contraste, testes unitários, typecheck/build e auditoria de dependências.

## PostgreSQL real

Os testes de integração validam migrations e constraints contra PostgreSQL, não mocks:

```bash
npm run test:integration:db --prefix backend
```

Configure `DATABASE_URL` para um banco descartável. Nunca use produção.

## CI de cada commit

O workflow `ci.yml` executa:

1. instalação reprodutível por lockfile;
2. typecheck, lint e testes;
3. validação do Prisma e migrations em PostgreSQL vazio;
4. build do backend e frontend;
5. auditoria de dependências;
6. validação do Compose;
7. build e scan da única imagem Railway.

CodeQL roda em workflow separado para análise estática. Um commit só pode ser promovido quando ambos terminarem verdes.

## Staging

O workflow manual/agendado `staging.yml` reúne:

- smoke público e readiness;
- verificação dinâmica de cabeçalhos e respostas de segurança;
- carga curta com limite de erro e p95;
- jornadas E2E Playwright;
- backup/restore drill em destino isolado.

Configure os secrets do environment `staging`:

- `STAGING_BASE_URL` e `STAGING_API_URL`;
- `E2E_ADMIN_LOGIN` e `E2E_ADMIN_PASSWORD`;
- credenciais opcionais de estudante;
- `RESTORE_SOURCE_DATABASE_URL` para o drill isolado.

Artefatos de falha não devem conter cookie, senha, token nem conteúdo pessoal. Trace e vídeo ficam desativados para jornadas autenticadas; screenshots de erro devem mascarar campos sensíveis.

## Comandos manuais

```bash
npm run test:e2e:install
npm run test:e2e
npm run gate:staging
npm run gate:security
npm run gate:load
bash scripts/backup-restore-drill.sh
```

Cada gate usa URL/limite por variável de ambiente, documentado no próprio script. Use staging ou um stack isolado.

## Critérios mínimos

- zero falhas em lint, typecheck, testes, build e migrations;
- zero vulnerabilidades corrigíveis HIGH/CRITICAL na imagem implantada;
- zero erros no smoke/E2E crítico;
- carga curta sem erro e dentro do p95 configurado;
- restauração concluída e tabelas esperadas presentes;
- healthchecks e login confirmados novamente após o deploy.

## Limites da evidência

Um teste de carga em `/health/ready` mede infraestrutura básica, não capacidade escolar completa. Afirmar uma quantidade de usuários exige perfil de simultaneidade, dados realistas, jornadas mistas, duração, hardware e relatório reproduzível.

Produção não está “100% comprovada” sem homologação, pentest proporcional ao risco, carga representativa, restore drill recorrente, monitoramento e plano de resposta exercitado.
