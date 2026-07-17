# Contribuição

Use branch curta, commit focado e pull request. Nenhuma mudança vai direto à branch protegida. Pelo menos uma revisão é obrigatória; autenticação, dados, infraestrutura e permissões exigem revisor do domínio.

Antes de abrir PR:

```bash
npm run install:all
npm run quality
```

Mudanças de banco exigem migração versionada, impacto, plano de roll-forward/rollback e teste em PostgreSQL. Mudanças de API atualizam contratos e documentação. Funcionalidades incluem estados vazio/loading/erro, acessibilidade, logs úteis, auditoria quando mutáveis e testes proporcionais ao risco.

## Limites arquiteturais

- novas regras seguem `route → application service → domain policy → persistence/integration`;
- rotas traduzem HTTP e não concentram transações ou integrações externas;
- páginas React compõem features e não incorporam novos painéis completos;
- código novo pertence ao módulo de domínio correspondente em `backend/src/modules` ou `frontend/src/features`;
- alterações multi-tenant incluem o tenant derivado da sessão e preservam as constraints descritas em `ARCHITECTURE.md`;
- API e worker continuam com entrypoints separados;
- decisões de ownership, processo ou contrato público atualizam `ARCHITECTURE.md` sem criar documentação paralela.

Não use `any`, `@ts-ignore`, `@ts-nocheck`, segredo em código, log de credencial nem dependência nova sem justificativa e auditoria.
