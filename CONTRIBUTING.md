# Contributing

1. Fork the repository.
2. Create a feature branch.
3. Add tests.
4. Run:
   pnpm lint
   pnpm typecheck
   pnpm test
5. Open a pull request.

Every new analyzer should document:

- input facts
- deterministic algorithm
- output classification
- confidence calculation
- known false positives
- test fixtures
