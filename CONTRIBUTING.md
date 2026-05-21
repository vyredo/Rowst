# Contributing to Rowst

Thank you for considering contributing to Rowst! This document outlines the process for contributing to this project.

## Development Setup

```bash
# Clone the repository
git clone https://github.com/vyredo/rowst.git
cd rowst

# Install dependencies
npm install

# Run type checking
npm run typecheck

# Run tests
npm test

# Build
npm run build
```

## Commit Conventions

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — A new feature
- `fix:` — A bug fix
- `docs:` — Documentation changes
- `test:` — Adding or modifying tests
- `refactor:` — Code changes that neither fix a bug nor add a feature
- `chore:` — Changes to build process, tooling, or dependencies

## Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/amazing-feature`)
3. Make your changes
4. Ensure tests pass (`npm test`)
5. Ensure type checking passes (`npm run typecheck`)
6. Commit using conventional commit format
7. Push to your fork and open a Pull Request

## Code Style

- TypeScript strict mode is enabled — all code must pass `tsc --noEmit`
- ESLint is configured — run `npm run lint` before committing
- Write tests for new features and bug fixes
- Follow existing patterns in the codebase

## Questions?

Open an issue or start a discussion at https://github.com/vyredo/rowst/issues
