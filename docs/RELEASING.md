# Versionamento e releases

Este documento descreve o processo de release do Duraxis. Nenhum comando de validação publica
pacotes; `pnpm release` é a única interface local que inicia publicação e deve ser usada apenas
por um mantenedor autenticado ou pelo job OIDC.

## Modelo de versões

Os seis pacotes públicos têm versões independentes. Os arrays `fixed` e `linked` do Changesets
estão vazios. Dependências internas usam `workspace:*` no repositório; `pnpm pack` as converte para
a versão exata do pacote no tarball. `updateInternalDependencies: patch` atualiza dependências
internas quando os pacotes envolvidos recebem release. A raiz e `@duraxis/storage-testkit` são
privados, ignorados no versionamento e nunca publicados.

Use SemVer:

- `patch` para correção compatível;
- `minor` para funcionalidade compatível;
- `major` para quebra de API. Enquanto a versão é `0.x`, avalie cuidadosamente o impacto e
  descreva qualquer incompatibilidade no changeset.

## Fluxo normal

1. Implemente e teste a alteração.
2. Execute `pnpm changeset`, selecione somente os pacotes públicos afetados, escolha o bump e
   escreva um resumo voltado ao consumidor.
3. Confirme com `pnpm changeset:status` e envie código + changeset no mesmo pull request.
4. A CI executa formato, tipos, build, 263+ testes, inspeção dos tarballs e consumo externo.
5. Ao entrar em `main`, `publish.yml` cria ou atualiza o Release PR usando
   `pnpm version-packages`. Esse PR contém versões, ranges internos e changelogs.
6. Revise o grafo de versões, os changelogs e os artefatos; aprove e mescle o Release PR.
7. O próximo push em `main`, após validação e aprovação do environment `npm`, executa
   `pnpm release`. Changesets publica somente pacotes públicos cuja versão ainda não existe.
8. A action envia tags no formato `@duraxis/nome@x.y.z` e cria/atualiza GitHub Releases.

Para uma release de um único pacote, selecione apenas ele em `pnpm changeset`. Changesets inclui
dependentes somente quando necessário para manter ranges internos válidos. Para uma release
coordenada, selecione todos os pacotes afetados no mesmo changeset (ou em changesets separados no
mesmo PR); as versões continuam independentes.

## Validação local

```bash
pnpm install --frozen-lockfile
pnpm validate:release
pnpm changeset:status
```

`pnpm pack:check` usa o registry público apenas para instalar os peers externos do NestJS no
projeto de smoke test. Não requer credenciais nem permissão de publicação.

## Prereleases

Cada canal é um prerelease mode nativo do Changesets. O nome passado a `pre enter` vira o sufixo
SemVer e o npm dist-tag usado por `changeset publish`:

```bash
pnpm changeset pre enter alpha # experimental
pnpm changeset pre enter beta  # validação externa
pnpm changeset pre enter rc    # candidato a release
```

Escolha apenas um comando para iniciar um ciclo, confirme `.changeset/pre.json` no Git e siga o
fluxo normal de Release PR. `pnpm version-packages` gera, por exemplo, `0.2.0-beta.0`; releases
subsequentes no mesmo canal avançam o contador. `pnpm release` detecta o estado de prerelease e
publica sob `alpha`, `beta` ou `rc`, sem mover `latest`.

Para sair do canal:

```bash
pnpm changeset pre exit
pnpm version-packages
pnpm validate:release
# revisar/commitar; depois pnpm release no workflow
```

A versão sem sufixo é então publicada em `latest`. Não troque de canal no meio de um ciclo:
finalize/saia do ciclo ou use uma branch de prerelease dedicada. Não inicie prerelease de um
pacote que ainda não tenha uma versão estável no npm; o bootstrap estável evita que uma primeira
publicação prerelease estabeleça `latest` acidentalmente. O workflow não executa `npm dist-tag`;
portanto, não depende da permissão OIDC separada de gerenciamento de dist-tags.

## Trusted Publishing (OIDC)

O job de publicação usa runner GitHub-hosted, Node 24.15.0, npm 12.2.2 e `id-token: write`.
Permissões de PR existem somente no job que cria o Release PR; o token OIDC existe somente no job
de publicação, depois das validações. O npm gera provenance automaticamente para pacotes
públicos publicados por OIDC a partir de um repositório público.

Depois da primeira publicação estável, o proprietário do scope deve repetir estes passos para
cada um dos seis pacotes em npmjs.com:

1. Abra **Package settings → Trusted publishing → GitHub Actions**.
2. Informe owner `Joaopdiasventura`, repository `Duraxis`, workflow `publish.yml` (somente o nome)
   e environment `npm`.
3. Permita `npm publish`. Não é necessário permitir `npm dist-tag` neste fluxo.
4. No GitHub, crie/proteja o environment `npm` com reviewers mantenedores e restrição à branch
   `main`.
5. Faça a primeira publicação OIDC em até dois dias da criação da relação; configurações novas
   expiram se não forem validadas nesse prazo.
6. Após validar OIDC, considere exigir 2FA e bloquear publicação por tokens nas configurações
   de cada pacote.

Também habilite **Settings → Actions → General → Allow GitHub Actions to create and approve
pull requests**, necessário para o Release PR. Trusted Publishing não está operacional até que
essas configurações externas sejam concluídas pelo proprietário do namespace.

## Primeira publicação (bootstrap)

Pacotes inexistentes ainda não têm uma página onde associar o Trusted Publisher. O bootstrap
deve ser estável e manual, numa estação segura, usando login web/2FA ou um token granular de curta
duração configurado somente no ambiente local. Nunca grave token em `.npmrc` do projeto, Git,
documentação ou GitHub Actions.

1. Confirme a propriedade do scope `@duraxis` no npm e execute `pnpm validate:release`.
2. Autentique-se fora do repositório (`npm login --registry=https://registry.npmjs.org/`).
3. Gere cada tarball com `pnpm --dir packages/<pacote> pack --pack-destination <diretorio-temporario>`.
4. Publique os tarballs com `npm publish <arquivo.tgz> --access public` nesta ordem:
   `storage`; `storage-memory`, `storage-disk` e `core`; `orm`; `nestjs`.
5. Verifique os seis pacotes e revogue qualquer token temporário.
6. Configure OIDC como descrito acima. Tags iniciais podem ser criadas com
   `pnpm changeset git-tag` e enviadas após revisão com `git push --follow-tags`.

Esse procedimento é excepcional. Releases seguintes devem ocorrer pelo workflow OIDC.
