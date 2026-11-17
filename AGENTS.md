# Repository Guidelines

## Project Structure & Module Organization

`server.js` owns the Node.js HTTP server, authentication, validation, and SQLite access. `public/` contains the browser application: `index.html`, `app.js`, `styles.css`, the shared `model.js` calculations, and `favicon.svg`. Keep financial calculations in `model.js` so the browser and tests use the same rules. `tests/` holds automated checks; `data/` holds runtime databases and must remain untracked. `.taste-skill/` records design decisions and checks.

## Build, Test, and Development Commands

Use Node.js 24 or newer. There are no package dependencies or compilation steps.

- `cp .env.example .env`: create local configuration.
- `npm start`: serve the app at `http://127.0.0.1:3000` by default.
- `npm run dev`: restart the server when watched files change; refresh for browser edits.
- `npm run check`: validate JavaScript syntax.
- `npm test`: run Node's built-in test runner against isolated databases.

## Coding Style & Naming Conventions

Use ES modules, two-space indentation, semicolons, single-quoted JavaScript strings, and camelCase functions and variables. CSS classes use kebab-case; constants describing pages use lowercase route names. Use parameterized SQLite statements and escape user content before inserting HTML. Store money as integer paisa and format it as taka only for display.

Preserve the dark translucent interface with restrained purple accents. Keep copy to page titles, field labels, table headers, buttons, data, and short states. Add forms in drawers; retain keyboard focus, visible focus rings, and mobile navigation.

## Testing Guidelines

Name automated test files `*.test.js` under `tests/`. Cover balance arithmetic, guest attribution, rounding, validation, authentication, and persistence when changing those behaviors. Use in-memory or temporary databases. No coverage threshold is configured. Check responsive screens and drawer interactions after UI changes.

## Commit & Pull Request Guidelines

No Git history is available to establish existing conventions. Use short, imperative subjects such as `Add member deposit filtering`. Keep changes focused. Pull requests should describe behavior, link relevant issues, record validation, and include desktop/mobile screenshots for visual changes.

## Security & Configuration

Keep credentials in `.env`; never commit credentials or database files. Document configuration changes in `.env.example` and `README.md`.
