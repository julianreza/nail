This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Owner authentication setup

There is no public signup. Create the owner credentials locally:

1. Run `node scripts/hash-owner-password.mjs` in an interactive terminal and copy its `OWNER_PASSWORD_HASH=...` output.
2. Run `node scripts/generate-session-secret.mjs` and copy its `SESSION_SECRET=...` output.
3. Put both values in the ignored `.env.local` file and set `APP_ORIGIN=http://localhost:3000` for local development (use the exact HTTPS origin in production).
4. Run `bun run dev` and open `http://localhost:3000`; the root page requires a valid owner session.

Keep `.env.local` private. The password hash and session secret are never returned to the browser. Login sessions expire after 8 hours and are revoked on logout; restarting the web process invalidates active sessions. Login attempts are rate-limited in the web process.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
