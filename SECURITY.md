# Segurança, privacidade e IA

## Reportar vulnerabilidade

Não abra issue pública com exploit, credencial ou dado pessoal. Envie o relato de forma privada aos mantenedores com impacto, versão/commit, passos mínimos e mitigação sugerida. Segredos expostos devem ser revogados antes da investigação.

## Controles implementados

- sessão por cookie HttpOnly, Secure em produção, SameSite e proteção CSRF;
- JWT com validade limitada, algoritmo explícito, versionamento e revogação;
- autorização por papel e vínculo escolar, incluindo tenant/campus;
- Helmet, CORS explícito, limites de corpo e rate limits por risco;
- uploads com tamanho, extensão, MIME, assinatura e validação de vídeo;
- queries pelo Prisma e constraints relacionais no PostgreSQL;
- logs estruturados com request ID e mensagens públicas seguras;
- segredos somente no backend/Railway;
- dependências, imagem, CodeQL e endpoints verificados no pipeline.

O frontend nunca é autoridade de acesso. Ocultar uma tela não substitui autorização no backend.

## Segredos

- use um valor diferente por ambiente;
- não grave `.env`, PAT, JWT, chave RTMP, URL de banco ou chave de IA no Git;
- rotacione imediatamente qualquer valor exibido em chat, captura, log ou terminal compartilhado;
- remova credenciais iniciais após o bootstrap;
- conceda ao GitHub/Railway apenas o escopo necessário.

Tokens pessoais temporários usados para migração de repositório devem ser revogados mesmo que tenham expirado. A chave SSH de deploy pode permanecer apenas se ainda for necessária para automação de push.

## Dados e LGPD

A instituição deve definir controlador, operadores, finalidade, base legal, retenção e canal para titulares antes da entrada de usuários reais.

Princípios obrigatórios:

- coletar somente dados necessários ao serviço educacional;
- limitar acesso por função, organização e campus;
- não usar dados reais em desenvolvimento ou carga;
- manter trilha de auditoria para ações administrativas e acadêmicas;
- definir retenção e exclusão para contas, mensagens, arquivos e logs;
- testar restauração e também o processo de exclusão;
- documentar fornecedores externos e transferências de dados;
- ter procedimento de incidente e comunicação.

Backups e logs também contêm dados pessoais e seguem a mesma política de acesso e retenção.

## IA

A IA é opcional e deve degradar sem impedir as funções escolares principais.

- a chave e a chamada ao provedor ficam no backend;
- envie apenas contexto pedagógico autorizado e mínimo;
- não inclua senha, token, dado de outra turma ou informação sensível desnecessária;
- informe ao usuário quando o conteúdo for gerado por IA;
- decisões de nota, punição, acesso ou risco não podem ser tomadas automaticamente sem revisão humana;
- registre modelo/configuração suficientes para auditoria, sem registrar o prompt com dados pessoais em log comum;
- defina retenção e mecanismo de exclusão das conversas.

## Arquivos e mídia

Conteúdo privado deve exigir autorização e, quando aplicável, URL assinada curta. MIME e nome do arquivo não são prova de conteúdo. RTMP sem túnel cifra pouco ou nada; restrinja a porta ao operador, use rede privada quando possível e rotacione chaves expostas.

## Antes de produção

Actions verdes e scanner limpo não substituem pentest, revisão de permissões, restore drill e homologação em staging. Os gates reproduzíveis estão em `docs/TESTING.md`.
