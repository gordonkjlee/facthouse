# Contributing

Issues and pull requests are welcome. Open an issue first if the change is more than a typo.

## Build and test

```bash
git clone https://github.com/gordonkjlee/facthouse
cd facthouse
npm install
npm run build
npm test
```

`npm test` is hermetic. Live evals that need a model are separate scripts (`npm run test:first-fact`, `npm run test:coding-store`, `npm run test:semantic`) and fail rather than skip when their dependency is missing.

## Publishing to the MCP Registry

npm publish is automated (`Publish to npm`). After that workflow succeeds, `Publish to MCP Registry` publishes `server.json` to the official MCP Registry as `io.github.gordonkjlee/facthouse` via `mcp-publisher login github-oidc` (no PAT, no npm token).

`mcpName` in `package.json` must equal `name` in `server.json`. release-please bumps `server.json` versions through extra-files.

To list a version already on npm without cutting a new release: Actions → "Publish to MCP Registry" → Run workflow. GitHub OIDC publish cannot be dry-run from a pull request; the first listing is that post-merge dispatch.

## Rules that will reject a PR

- British English in documentation.
- Synthetic fixtures only (`Alex`, `Robin`, `Acme`). Never real memory content, store dumps, or machine fingerprints.
- This checkout is the engine, not a client. Do not run the Facthouse MCP server from this repo against a live store, and do not add a hook that logs Facthouse's own tools back into it.
- Public files must not name internal design-doc filenames. Say the concept.
- Pull requests use the templates under `.github/PULL_REQUEST_TEMPLATE/`. Fill every section; write `N/A` if one does not apply.

Questions belong in [Discussions](https://github.com/gordonkjlee/facthouse/discussions). Security reports belong in [SECURITY.md](SECURITY.md), not a public issue.
