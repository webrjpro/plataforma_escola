# Arquitetura

Este é o documento canônico da arquitetura atual. Ele descreve decisões que já existem no código; propostas e evidências históricas ficam no Git, não em documentos paralelos.

## Decisão principal

A plataforma é um **monólito modular Railway-first**. Há uma única imagem e um único ciclo de release. Dentro dela, processos diferentes isolam responsabilidades operacionais:

- Nginx serve o React, encaminha `/api` e entrega HLS/RTMP;
- a API Express autentica, autoriza e executa casos de uso;
- o worker consome a fila `pg-boss` e processa vídeo com FFmpeg;
- o PostgreSQL mantém estado transacional e a fila.

```text
Internet
   |
   v
Nginx (porta pública)
   |-- React estático
   |-- /api ----------> Express ----> Prisma/PostgreSQL
   |-- /hls                 |
   `-- RTMP/HLS             `-------> serviços externos opcionais

PostgreSQL/pg-boss ----> worker FFmpeg ----> volume local ou R2
```

Não há justificativa atual para microserviços. Eles só devem ser considerados quando métricas mostrarem necessidade de escala independente, isolamento de falhas ou equipes com ciclos de entrega diferentes.

## Código

### Backend

- `app.ts` monta o Express sem abrir socket, permitindo testes em memória;
- `main.ts` valida o ambiente e controla início e shutdown da API;
- `worker.ts` inicia apenas o consumidor de vídeo;
- `routes/` contém os boundaries HTTP existentes;
- `modules/` concentra regras que já possuem domínio claro;
- `lib/` contém integrações e utilitários compartilhados;
- `prisma/` é a fonte do modelo e do histórico de migrations.

O fluxo preferido é `rota -> serviço/regra -> Prisma ou integração`. Não crie uma camada quando uma função local clara resolve o problema. Arquivos grandes devem ser reduzidos por responsabilidade, não transformados em dezenas de wrappers vazios.

### Frontend

O React é uma SPA com rotas lazy. `pages/` compõe telas, `features/` mantém partes coesas do painel, `components/` contém elementos compartilhados e `lib/api.ts` é o cliente HTTP comum.

Autorização no frontend serve apenas à experiência do usuário. Toda decisão de acesso é repetida e aplicada pelo backend.

## Domínios existentes

O tamanho do código vem do escopo funcional: identidade, LMS, operação escolar, fórum/moderação, vídeo, broadcast, salas privadas e IA. Esses domínios têm rotas e interface em uso; removê-los exige uma decisão de produto, não uma limpeza técnica.

## Autenticação e sessão

A sessão web usa cookie HttpOnly, `SameSite` e proteção CSRF. O navegador não armazena JWT de sessão e não precisa montar headers Bearer manualmente. Tokens de integração e tokens curtos de mídia são fluxos separados.

Papéis globais controlam administração e aluno. Operações escolares também exigem vínculo ativo com a organização e, quando aplicável, escopo de campus.

## Dados e multi-tenancy

`SchoolOrganization` é o tenant escolar. O backend nunca confia apenas em um `organizationId` fornecido pelo cliente: a consulta inclui o vínculo derivado da sessão. Chaves compostas do banco impedem relações entre campus, ano, turma, matrícula e oferta de organizações diferentes.

Migrations são append-only e aplicadas por `prisma migrate deploy`. Não se usa `db push` em produção.

### Limites conhecidos

- `Course` ainda é um catálogo global; não se deve inferir ownership institucional de conteúdo.
- A associação docente tem uma única fonte canônica em `CourseEnrollment` com papel `TEACHER`; a migration de consolidação preserva vínculos das versões antigas.
- Rate limit em memória pressupõe uma instância da API. Réplicas exigem store distribuído.
- Volume local pressupõe um host. Múltiplas réplicas exigem storage de objetos para arquivos persistentes.

## Arquivos e mídia

Uploads são autorizados, limitados e validados por extensão, MIME e assinatura quando aplicável. FFprobe valida vídeos antes da fila. O worker chama os binários FFmpeg/FFprobe fornecidos pelo sistema da imagem, evitando cópias grandes dentro de `node_modules`.

R2/S3 é opcional. Quando ativado, todas as variáveis do provedor precisam ser configuradas juntas. Conteúdo privado não deve usar URL pública permanente.

## IA

A integração com IA é opcional e fica somente no backend. Prompts devem carregar apenas o contexto pedagógico necessário. Não envie segredos, dados de outras turmas ou identificadores pessoais sem finalidade e base legal definidas.

## Operação

- `/health/live`: o processo HTTP responde;
- `/health/ready`: aplicação e banco estão prontos;
- logs: JSON com request ID, sem segredos;
- migration: executada uma vez pelo entrypoint antes dos processos;
- worker: processo separado da API dentro da imagem;
- deploy e rollback: um único fluxo descrito em `DEPLOY.md` e `RUNBOOK.md`.

Separar API e worker em serviços Railway distintos só se torna necessário quando CPU de FFmpeg afetar a latência HTTP. Separar outros módulos exige métricas equivalentes, não preferência arquitetural.

## Critério para mudanças

Uma mudança está pronta quando valida entrada e autorização no boundary, preserva invariantes de tenant, inclui teste proporcional ao risco, atualiza o OpenAPI quando muda contrato e passa os gates de `docs/TESTING.md`.
