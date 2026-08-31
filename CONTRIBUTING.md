# Contributing

Issues and pull requests are welcome. Open an issue first if the change is more than a typo.

## Build and test

```bash
git clone https://github.com/gordonkjlee/factmem
cd factmem
npm install
npm run build
npm test
```

`npm test` is hermetic. Live evals that need a model are separate scripts (`npm run test:first-fact`, `npm run test:coding-store`, `npm run test:semantic`) and fail rather than skip when their dependency is missing.

## Rules that will reject a PR

- British English in documentation.
- Synthetic fixtures only (`Alex`, `Robin`, `Acme`). Never real memory content, store dumps, or machine fingerprints.
- This checkout is the engine, not a client. Do not run the FactMem MCP server from this repo against a live store, and do not add a hook that logs FactMem's own tools back into it.
- Public files must not name internal design-doc filenames. Say the concept.
- Pull requests use the templates under `.github/PULL_REQUEST_TEMPLATE/`. Fill every section; write `N/A` if one does not apply.

Questions belong in [Discussions](https://github.com/gordonkjlee/factmem/discussions). Security reports belong in [SECURITY.md](SECURITY.md), not a public issue.
