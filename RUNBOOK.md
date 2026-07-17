# Runbook de produção

Procedimentos para o serviço Railway `tv-carlos-web`. Preserve evidências e valores secretos; registre somente nomes de variáveis, IDs de deployment e horários.

## Triagem inicial

1. Confirme o deployment ativo e o commit.
2. Consulte `/health/live` e `/health/ready`.
3. Verifique logs do serviço web e métricas do Postgres.
4. Determine se o impacto é HTTP, autenticação, banco, fila, mídia ou broadcast.
5. Se o erro começou após um deploy, prefira rollback do deployment antes de mudanças improvisadas.

```bash
railway status
railway deployment list --service tv-carlos-web
railway logs --service tv-carlos-web
```

## Aplicação indisponível

- `live` falha: processo/Nginx não iniciou; verifique entrypoint, supervisor e porta.
- `live` passa e `ready` falha: verifique `DATABASE_URL`, disponibilidade do Postgres e migrations.
- ambos passam e a página falha: verifique domínio, proxy, assets e erros do navegador.

Não aumente `healthcheckTimeout` para esconder falha persistente de migration.

## Migration falhou

1. Pare novas tentativas se o erro for de SQL, não de conexão.
2. Faça backup antes de corrigir dados.
3. Compare `_prisma_migrations` com os arquivos do commit.
4. Publique uma migration append-only corretiva.
5. Use `prisma migrate resolve` somente após entender e documentar o estado real.

Nunca execute `db push` em produção e nunca apague uma migration já aplicada.

## Erros de login ou sessão

Verifique, sem imprimir valores:

- presença e força de `JWT_SECRET`;
- `COOKIE_SECURE=true` e acesso por HTTPS;
- `TRUST_PROXY=1`;
- correspondência de `FRONTEND_URL` com a origem pública;
- horário do cliente/servidor;
- rate limit e `tokenVersion` do usuário.

A sessão web é por cookie HttpOnly e CSRF. O navegador não depende de Bearer salvo em JavaScript.

## Banco lento ou sem conexões

- confira CPU, memória, storage e conexões do Postgres;
- procure consultas repetidas e transações longas;
- reduza concorrência de jobs se o worker competir com a API;
- não aumente o pool sem observar o limite total do banco.

Antes de escalar réplicas, valide pool, rate limit distribuído e storage compartilhado.

## Vídeo ou fila parados

1. Confirme que há exatamente um worker esperado.
2. Mantenha `PGBOSS_WORKER=false` na API quando o supervisor iniciar o worker dedicado.
3. Verifique espaço em `/data`, permissões e presença de `ffmpeg`/`ffprobe`.
4. Inspecione o estado do vídeo e retries do job.
5. Reprocesse apenas jobs idempotentes; não duplique registros manualmente.

Se FFmpeg pressionar CPU/latência da API, mova o worker para um serviço Railway separado antes de criar outros microserviços.

## Uploads ausentes

- com volume local, confirme montagem em `/data` e espaço disponível;
- com R2, confirme que todas as variáveis do grupo estão presentes;
- não misture storage local entre múltiplas réplicas;
- valide autorização e assinatura do arquivo, não apenas extensão/MIME.

## Broadcast indisponível

- HTTP/HLS pode estar saudável mesmo sem ingestão RTMP;
- confirme a chave, o nome permitido da stream e o TCP Proxy da porta 1935;
- restrinja a porta ao operador sempre que possível;
- rotacione a chave se ela aparecer em logs, prints ou chat.

## Backup e restauração

Backup só conta quando a restauração é testada. O workflow de staging executa o drill isolado com `scripts/backup-restore-drill.sh` e uma URL de origem protegida.

Antes de qualquer operação manual:

1. crie snapshot/backup do Postgres;
2. registre horário, ambiente e commit;
3. restaure em instância isolada;
4. valide migrations, tabelas críticas e contagens esperadas;
5. nunca use o banco de produção como destino do teste.

Arquivos em `/data` ou R2 precisam de política de backup independente do Postgres.

## Rollback

1. Selecione o último deployment saudável no Railway.
2. Reimplante sem alterar variáveis durante a triagem.
3. Confirme `live`, `ready`, login e fluxo crítico.
4. Se o schema mudou, mantenha compatibilidade e publique migration corretiva; não reverta banco destrutivamente.
5. Abra análise de causa com linha do tempo e ações preventivas.

## Encerramento do incidente

Registre impacto, duração, causa, commit/deployment, correção, evidência de recuperação e ação que evita recorrência. Nunca inclua tokens, senhas, cookies, URLs de banco ou dados pessoais.
