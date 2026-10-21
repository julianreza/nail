# nail

Nail is an owner-authenticated AI project orchestration workspace built with Next.js 16.4.2 App Router, React 19.3.0, strict TypeScript, and Tailwind CSS 4. It includes persistent SQLite-backed project, run, approval, provider, and orchestration foundations. The autonomous PM/engineer/QA loop and production-grade worker/sandbox execution path are incomplete; read the implementation status in `README.md` before treating any workflow as production-ready.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Dev environment

- `package.json` specifies `bun@1.4.3`; `bun.lock` is the tracked dependency lockfile. The README lists other package managers, but Bun is the project's declared toolchain.
- Next.js's bundled installation guide requires Node.js 20.9 or newer.
- Run commands from the repository root. The README's development URL is `http://localhost:3000`.

## Build & checks

These invocations use the scripts in `package.json`:

- `bun run dev` — `next dev`, the development server (`bun dev` is also documented in README.md).
- `bun run build` — `next build`, the production build.
- `bun run start` — `next start`, serves the production build after building.
- `bun run lint` — `eslint`, configured with Next.js Core Web Vitals and TypeScript rules in `eslint.config.mjs`.
- `bun run test` — `vitest run`; tests live under `tests/` and use Vitest.
- There is no dedicated typecheck script or CI workflow currently tracked. Lint, tests, and build are the available scripted checks.

## Layout & conventions

- `app/page.tsx` is the `/` homepage; `app/layout.tsx` defines root HTML, metadata, Geist fonts, and imports `app/globals.css`.
- `public/` contains static SVG assets referenced by root-relative URLs such as `/next.svg`; the homepage renders images with `next/image`.
- Components use default-exported PascalCase functions; TypeScript/TSX uses two-space indentation, double quotes, and semicolons. Type-only imports use `import type`.
- `tsconfig.json` enables strict checking and maps `@/*` to the repository root, not a `src/` directory.
- Styling uses Tailwind utility classes in JSX. `app/globals.css` imports `tailwindcss`, defines CSS color variables and `@theme inline` mappings, and switches colors with `prefers-color-scheme`.

## Pitfalls

- `next.config.ts` enables `cacheComponents` and `partialPrefetching`; consult this installed Next.js version's docs before changing rendering or caching behavior.
- Tailwind runs through the `@tailwindcss/turbopack` CSS rule in `next.config.ts`, not a PostCSS config. Keep this wiring in mind when changing CSS tooling.
- `next-env.d.ts` and `.next/` are generated and ignored; do not hand-edit them. The root layout uses Next.js's generated global `LayoutProps<"/">` type, and TypeScript includes generated route types under `.next/`.
