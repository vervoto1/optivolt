<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-16 -->

# .github

## Purpose

GitHub configuration for CI/CD and automated dependency management.

## Key Files

| File | Description |
|------|-------------|
| `workflows/test.yml` | GitHub Actions: lint, typecheck, and test on push/PR to main (Ubuntu, Node 24) |
| `dependabot.yml` | Automated monthly npm dependency updates |

## For AI Agents

### Working In This Directory

- CI pipeline runs: `npm ci` → `npm run lint` → `npm run typecheck` → `npm test`
- Node.js 24 with npm cache enabled
- Triggers on push to `main` and PRs targeting `main`
- Ensure all three checks pass locally before pushing: `npm run lint && npm run typecheck && npx vitest run`

## Dependencies

### Internal

- `package.json` — defines lint, typecheck, and test scripts

### External

- GitHub Actions (ubuntu-latest, actions/checkout, actions/setup-node)

<!-- MANUAL: -->
