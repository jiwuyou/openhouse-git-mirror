# OpenHouse Git Mirror

Small GitHub-to-Forgejo mirror service for OpenHouse Package sources.

It supports two policies:

- `tracking`: refresh a selected GitHub branch on an interval.
- `pinned`: retain one exact commit under an immutable `openhouse-pin` tag.

The default admission limit is 30 MiB for the complete bare Git repository,
including fetched Git LFS objects. Oversized updates never overwrite the last
verified mirror.

## Run locally

```bash
npm install
npm test
npm run dev
```

Required service configuration:

```text
MIRROR_API_TOKEN
FORGEJO_BASE_URL
FORGEJO_PUBLIC_URL
FORGEJO_TOKEN
FORGEJO_OWNER
```

The seed file registers the initial repositories:

```text
jiwuyou/wuxianpi
jiwuyou/deepseek-harness-openhouse
```

## API

All `/api/v1/*` routes require `Authorization: Bearer <MIRROR_API_TOKEN>`.

```text
POST /api/v1/targets
GET  /api/v1/targets
POST /api/v1/targets/:id/sync
POST /api/v1/targets/:id/pause
POST /api/v1/targets/:id/resume
POST /api/v1/releases
GET  /api/v1/sources?repositoryUrl=...&approvedCommit=...
```

Register an approved Package Release:

```json
{
  "packageId": "io.wuxianpi.example",
  "releaseId": "rel_example",
  "repositoryUrl": "https://github.com/example/package.git",
  "approvedCommit": "0123456789012345678901234567890123456789"
}
```

The service creates a tracking target when needed, mirrors it if it is within
the size limit, and pins the approved commit. WuxianPi Hub can query `sources`
and add the returned URL to its existing `gitSources` install-plan field.

## Forgejo deployment

```bash
cd deployment
cp runtime.env.example runtime.env
cp secrets.env.example secrets.env
docker compose --env-file runtime.env --env-file secrets.env up -d --build
```

On the first Forgejo start, create the `openhouse` organization and a
`mirror-worker` API token with repository write permission, then place the
token in `secrets.env`. Public users receive read-only Git access; ordinary
account registration is disabled.
