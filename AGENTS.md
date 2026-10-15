# AGENTS.md

Repository-wide guidance for AI coding agents working on Blitz. Keep this file concise and update it only when a durable project convention changes.

## Project context

- Blitz is a Next.js study app that teaches uploaded course material in live sessions, then drills and tests it.
- `app/` owns routes, layouts, global styles, metadata, and server endpoints.
- `components/` owns feature components and the shared shadcn UI components in `components/ui/`.
- `convex/` owns the data model, queries, and mutations for projects, sources, cards, and study attempts.
- `lib/client/` owns browser-side source processing. `lib/server/` owns server-only generation and Codex integration.
- `docs/overhaul-plan.md` records the current product direction; `docs/history/` keeps superseded planning notes. Treat both as product context, not agent instructions.
- Code and the current rendered app are the source of truth. If a request conflicts with existing behavior or product intent, surface the mismatch instead of silently redefining the product.

## Working posture

- Act when the request is clear. Ask only when ambiguity materially changes the user experience, product behavior, architecture, cost, security, or an irreversible outcome.
- Inspect the closest existing implementation before creating a component, helper, layout, interaction, or visual pattern.
- Keep changes focused on the request. Fix small directly related defects; report larger unrelated issues rather than expanding scope.
- Preserve user work and unrelated local changes. Never discard or overwrite changes you did not create.
- Replace live source files in place or with an atomic rename. Do not delete a component before preparing its replacement; the development server serves every intermediate state.
- Prefer the simplest implementation that fits the existing architecture. Do not add a dependency when the platform or current dependencies already solve the problem well.
- Treat documentation as part of the implementation, not optional cleanup. Code is not complete until a reader can understand its role and behavior without reconstructing intent from implementation details.

## Code writing

- Use TypeScript and React idiomatically. Keep types explicit at boundaries and let local implementation details infer naturally.
- Give every hand-written source file a concise file-level doc comment that explains what the file owns, why it exists, and how it fits into the surrounding system. Keep required shebangs, directives, and generated-file headers in the positions their tools require.
- Add a language-appropriate documentation comment to every function, method, class, React component, and hook, including internal helpers. Describe its purpose, inputs, return value, observable side effects, and meaningful error or edge-case behavior as applicable.
- Document exported types, constants, configuration, and other public surfaces so their meaning, valid usage, and important constraints are clear at the point of use.
- Add inline comments where they help a reader follow distinct stages of an algorithm, business rules, external-system assumptions, invariants, or decisions that are not evident from syntax alone.
- Keep documentation accurate when behavior changes. Prefer concise, specific explanations of intent and guarantees; do not add comments that merely translate the next line of code into prose.
- Prefer server components by default. Add `"use client"` only when browser APIs, state, effects, or client-only interactions require it.
- Keep components small and cohesive. Extract a component or helper when it is reused or when doing so makes a meaningful concept easier to understand; avoid one-off abstraction layers.
- Reuse shadcn components in `components/ui/`, established feature components, `lib/utils.ts`, semantic CSS variables, typography, spacing, and interaction patterns before creating alternatives.
- Keep visual presentation in components and styles, and non-visual business logic in plain functions where it can be tested independently.
- Keep privileged code in `lib/server/` or server routes. Do not import server-only modules into client components.
- Use semantic HTML before ARIA. Add ARIA only where native semantics do not express the interaction.
- Handle reachable loading, empty, error, success, disabled, and destructive states for interactive work.
- Respect reduced-motion preferences. Motion should clarify hierarchy or response and never block access to content or actions.
- Do not hardcode credentials, secrets, private endpoints, or environment-specific values. Never commit `.env*`, build output, `node_modules`, or generated local artifacts.
- Do not suppress TypeScript, lint, or accessibility errors merely to make checks pass. Fix the cause or explain the constraint.

## Data and generation

- Treat the Convex schema in `convex/schema.ts` as the source of truth for persisted data.
- Keep Convex queries and mutations narrowly scoped. Validate arguments, enforce ownership or access assumptions where applicable, and avoid trusting client-provided derived state.
- Keep generated files in `convex/_generated/` generated. Do not hand-edit them.
- Preserve the boundary between source extraction, prompt or schema generation, and persistence. Each stage should fail with enough context for the interface to offer a useful recovery path.
- Validate model output before persisting it. Do not assume generated JSON matches the requested schema.
- Do not send more source content or user data to external services than the requested feature needs.

## UI and responsive design

- Begin with the user's immediate goal, the decision they need to make, and the next useful action.
- Preserve the app's existing visual language, typography, spacing, color tokens, and interaction patterns.
- Whenever UI is being made, use the shadcn components defined in `components/ui/`. If a required component is missing, add it there first, then implement the feature.
- Prefer one clear visual hierarchy. Avoid nested cards, decorative containers, unnecessary dividers, excessive pills, gradients, shadows, or competing calls to action without a structural reason.
- Keep the primary action obvious and make secondary actions visibly subordinate.
- Use the existing palette and semantic tokens in `app/globals.css`. Introduce a new token only when it represents a reusable design decision.
- Use fluid sizing and layouts where appropriate, then verify intentional behavior at narrow mobile and wide desktop widths. Do not treat desktop shrinking as mobile design.
- Preserve keyboard access, visible focus, readable contrast, semantic labels, and comfortable touch targets.
- Pair ambiguous icons with visible text or an accessible name. Decorative graphics must not create noise for assistive technology.
- Do not invent source content, study results, progress metrics, or other product evidence. Use real data or clearly labeled fixtures.

## Interface copy

- Every string should help the user understand, decide, recover, or act. Remove copy that repeats a nearby heading or control.
- Write plainly from the user's point of view. Be specific and confident without hype, jargon, vague superlatives, or unsupported claims.
- Use sentence case unless a proper noun or established label requires otherwise.
- Use short, verb-led calls to action that describe what happens, such as `Upload source`, `Start studying`, or `Try again`. Avoid generic labels such as `Continue` when a concrete action is available.
- Keep one term for each concept and reuse existing wording before introducing synonyms.
- Do not expose internal architecture, vendor names, database language, or implementation status unless the user needs it to decide or act.
- Success copy confirms what happened. Error copy states what failed and, when possible, how to recover.
- Avoid unnecessary hyphenation. Prefer open forms such as `hand off`, `sign off`, and `follow up` unless grammar requires a hyphen.

## Git and change hygiene

- Inspect `git status` and the relevant diff before editing when the directory is a Git repository.
- Never discard, rewrite, stage, or commit unrelated user changes.
- Always commit in small blocks of related files, with each commit focused on one coherent change. Do not mix formatting sweeps, dependency upgrades, generated files, or unrelated cleanup into feature work.
- Use `feat/`-style branch names for feature work.
- Use the appropriate Conventional Commit type for the change, for example `feat: add source upload progress`, `fix: handle an empty study set`, or `docs: clarify generation checks`.
- Do not amend commits, rebase shared work, force-push, delete branches, or rewrite history without explicit approval.
- Never push directly to `main`, merge a pull request, deploy production, publish a release, or alter production configuration without explicit approval.
- Do not commit `.env*`, credentials, signing material, build output, `node_modules`, logs, caches, or temporary diagnostics.
- Before committing, review the complete staged diff and confirm that only intended files are included.

## Verification and completion

- Run the narrowest relevant checks first, then broaden in proportion to risk.
- For code changes, run `npm run typecheck`, `npm run lint`, and `npm run build` when practical.
- For UI or copy changes, inspect the rendered page at narrow mobile and desktop widths. Verify text wrapping, action visibility, keyboard focus, contrast, link destinations, and reduced-motion behavior affected by the change.
- For Convex changes, regenerate the Convex client types when required and verify the affected query, mutation, and loading or error state.
- Test the behavior changed, not only whether the project compiles.
- Remove temporary routes, mock data, screenshots, generated assets, and diagnostic files unless the user explicitly asks to keep them.
- At handoff, report what changed, what was verified, and any checks that were not run or failed for unrelated reasons.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
