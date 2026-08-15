# Deploying Understory

The application is a standard Next.js App Router project with one external
dependency: a Bolt connection to CognoDB. Deployment is therefore mostly about
getting three environment variables into the right place.

---

## 1. Push to GitHub

Create an **empty** repository on github.com - no README, no `.gitignore`, no
licence, since the repo already has all three. Then:

```bash
cd understory
git remote add origin https://github.com/<you>/understory.git
git push -u origin main
```

Verify nothing sensitive went up:

```bash
git ls-files | grep -E '^\.env'
# should print exactly:  .env.example
```

`.env.local` is gitignored and must never appear in that output.

---

## 2. Deploy to Vercel

### Via the dashboard

1. <https://vercel.com/new> -> **Import Git Repository** -> pick the repo.
2. Framework preset is detected as **Next.js**. Leave build settings alone -
   `next build` and the default output directory are correct.
3. Before clicking **Deploy**, open **Environment Variables** and add:

   | Name | Value | Environments |
   |---|---|---|
   | `NEO4J_URI` | `bolt+s://<instance-id>.databases.cognodb.com` | Production, Preview, Development |
   | `NEO4J_USERNAME` | `cognodb` | Production, Preview, Development |
   | `NEO4J_PASSWORD` | your rotated password | Production, Preview, Development |
   | `NEO4J_DATABASE` | `neo4j` | Production, Preview, Development |
   | `NEO4J_MAX_POOL_SIZE` | `8` | Production, Preview, Development |

4. Under **Settings -> Functions**, set the **region** to whichever Vercel region
   is geographically closest to your CognoDB instance.

5. **Deploy.**

> **Region is the single biggest performance lever here.**
> Every query carries a network round trip, and from a laptop in a different
> region to the instance that floor is around 780 ms - more than the query time
> itself for most panels. Co-locating the serverless functions with the database
> collapses it. The package page fires seven queries in parallel, so the saving
> compounds.

> **Why `NEO4J_MAX_POOL_SIZE=8` rather than the local default of 16.**
> Each warm serverless instance holds its own connection pool, and Vercel will
> happily run many of them concurrently. The CognoDB free tier allows 200
> connections total, so the ceiling has to account for the multiplier. Eight per
> instance leaves comfortable headroom.

### Via the CLI

```bash
npm i -g vercel
vercel login
vercel link

vercel env add NEO4J_URI production
vercel env add NEO4J_USERNAME production
vercel env add NEO4J_PASSWORD production
vercel env add NEO4J_DATABASE production

vercel --prod
```

`vercel env add` prompts for the value on stdin, so secrets never end up in your
shell history.

---

## 3. Verify the deployment

```bash
curl -s https://<your-deployment>.vercel.app/api/health | jq
```

Expected:

```json
{
  "ok": true,
  "configured": true,
  "host": "xxxxx.databases.cognodb.com",
  "database": "neo4j",
  "encrypted": true,
  "latencyMs": 120,
  "boltProtocol": "5.4",
  "error": null
}
```

The endpoint returns **503** rather than 500 when the database is unreachable or
misconfigured, and the `error.code` distinguishes the cases:

| `error.code` | meaning |
|---|---|
| `CONFIGURATION` | an environment variable is missing or malformed |
| `DB_AUTH` | reachable, credentials rejected |
| `DB_UNAVAILABLE` | could not reach the instance at all |

Then open the site and check:

- the landing page shows non-zero counts in the statistics bar
- `/package/express?version=4.17.1` renders the graph and the advisory paths
- `/queries` lists the catalog

---

## 4. Runtime notes

**Node runtime, not Edge.** `neo4j-driver` opens raw TCP/TLS sockets, which the
Edge runtime cannot do. Route handlers declare `export const runtime = "nodejs"`,
and `serverExternalPackages: ["neo4j-driver"]` in `next.config.ts` keeps the
bundler from trying to trace it into a client bundle.

**Everything is dynamic.** Pages declare `export const dynamic = "force-dynamic"`
because every panel reflects live graph state. Nothing is prerendered at build
time, so a build never needs database access - which also means a deploy cannot
fail because the database happened to be briefly unavailable.

**Keep the instance running.** The hosted demo reads from CognoDB on every
request. If the instance is paused or deleted, the site still loads and shows the
database-unreachable screen with a diagnosis rather than crashing - but there
will be no data to explore.

---

## 5. Re-seeding the deployed database

Seeding runs from a developer machine against whatever `.env.local` points at -
there is no seed step in the deployment pipeline, deliberately, so a deploy can
never mutate production data as a side effect.

To refresh advisory data on the live instance:

```bash
# .env.local pointing at CognoDB
npm run db:seed
```

The load is idempotent - every write is a `MERGE` against a uniqueness
constraint - so re-running updates in place rather than duplicating.
