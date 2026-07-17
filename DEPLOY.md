# Deploy no Railway

Produção suporta um único caminho: a imagem do `Dockerfile` raiz no serviço `tv-carlos-web`, ligada ao PostgreSQL do mesmo projeto Railway.

## Serviços

- `tv-carlos-web`: Nginx, frontend, API e worker de vídeo.
- `Postgres`: banco, migrations e fila `pg-boss`.
- volume da aplicação montado em `/data` enquanto arquivos locais estiverem em uso.

O repositório canônico é `webrjpro/plataforma_escola`, branch `main`.

## Variáveis da aplicação

Obrigatórias:

| Variável | Uso |
|---|---|
| `DATABASE_URL` | referência privada ao Postgres Railway |
| `JWT_SECRET` | segredo aleatório forte e exclusivo do ambiente |
| `RTMP_STREAM_KEY` | autorização da transmissão principal |
| `NODE_ENV=production` | modo de execução |
| `MIGRATION_MODE=deploy` | migrations versionadas |
| `COOKIE_SECURE=true` | cookie somente por HTTPS |
| `TRUST_PROXY=1` | IP/protocolo atrás do proxy Railway |
| `FRONTEND_URL` | origem HTTPS pública da aplicação |
| `PGBOSS_WORKER=false` | evita worker duplicado; o supervisor já inicia um processo dedicado |

Recomendadas:

- `LOG_LEVEL=info`;
- `AUTH_TTL_HOURS` conforme política da instituição;
- `LOOP_STREAM_KEY`, se a playlist automática for usada;
- `SEED_ON_START=false` depois da criação inicial;
- `SEED_DEMO_DATA=false` em produção.

Grupos opcionais devem estar completos ou ausentes:

- R2: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` e, se necessário, `R2_PUBLIC_URL`;
- SMTP: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` e `SMTP_SECURE`;
- IA: `GROQ_API_KEY` e os nomes de modelo suportados pelo backend.

O Railway fornece `PORT` e `RAILWAY_PUBLIC_DOMAIN`. O entrypoint consegue derivar `FRONTEND_URL` do domínio, mas mantê-la explícita reduz ambiguidade. Variáveis antigas sem leitura no código devem ser removidas durante uma janela controlada, pois a exclusão pode disparar deploy.

Nunca copie valores secretos para Markdown, commits, logs ou chat.

## Primeiro deploy

1. Crie/conecte o Postgres no projeto.
2. Monte o volume da aplicação em `/data` ou configure R2.
3. Configure as variáveis acima.
4. Conecte `webrjpro/plataforma_escola`, branch `main`, ao serviço web.
5. Aguarde o healthcheck `GET /health/ready`.
6. Verifique os logs de `prisma migrate deploy`, API, worker e Nginx.

Pelo terminal autenticado:

```bash
railway link
railway service source connect --repo webrjpro/plataforma_escola --branch main --service tv-carlos-web
railway deployment list --service tv-carlos-web
railway logs --service tv-carlos-web
```

O GitHub App do Railway precisa ter acesso ao novo repositório. A chave SSH usada para `git push` não concede esse acesso ao Railway.

## Administrador inicial

Use `ADMIN_INITIAL_EMAIL`, `ADMIN_INITIAL_USERNAME` e `ADMIN_INITIAL_PASSWORD` apenas durante a criação inicial com `SEED_ON_START=true`. Depois de confirmar o login:

1. defina `SEED_ON_START=false`;
2. remova a senha inicial;
3. mantenha `SEED_DEMO_DATA=false`.

O seed não deve substituir um administrador existente.

## Verificação antes do corte

O commit a implantar precisa ter CI e CodeQL verdes. No ambiente:

```bash
curl -fsS https://SEU_DOMINIO/health/live
curl -fsS https://SEU_DOMINIO/health/ready
```

Depois execute o workflow de staging: smoke público, cabeçalhos de segurança, carga curta, E2E e restore drill. Faça também login, logout, upload, vídeo e uma operação escolar representativa.

RTMP exige um TCP Proxy/porta pública configurada no Railway. Sem isso, a aplicação HTTP funciona, mas o OBS não alcança a porta 1935.

## Rollback

Reimplante pelo Railway o último deployment saudável. Não reverta migrations destrutivamente. Se uma alteração de banco precisar de rollback, publique uma migration corretiva compatível com as duas versões do código. Consulte `RUNBOOK.md`.
