# Measure the Baby

A small, private baby growth-chart app. One Docker container, a persistent SQLite
volume, and a framework-free single-page frontend. WHO percentile curves are checked
in, so it draws charts with no internet access.

## Deploying to LIVE

Needs only Docker and the Compose plugin. This path does not involve Traefik and
publishes plain HTTP on port 80 — **put your own TLS terminator in front**
(Cloudflare, nginx or Caddy). Session cookies stay non-secure on this path, so do not
serve it over plain HTTP on an untrusted network.

```bash
git clone https://github.com/TheoGibbons/measure-the-baby.git ~/projects/measure-the-baby
cd ~/projects/measure-the-baby
cp .env.production.example .env

# Set before continuing:
#   APP_BIND=0.0.0.0   APP_PORT=80   publishes publicly instead of on loopback
# APP_HOST is ignored on this path; it belongs to the Traefik overlay.
nano .env

docker compose up -d --build
```

Security group:

| TCP port | Allowed source | Purpose |
|---|---|---|
| 22 | Administrator IP | SSH |
| 80 | Public internet, or your TLS terminator only | Application |

## Deploying to LIVE with hobby-traefik

This is how it actually runs. Traefik owns 80 and 443, terminates HTTPS with Let's
Encrypt, and the app publishes no host port of its own.

Point `APP_HOST`'s DNS record at the instance **before** deploying, or Let's Encrypt
cannot validate it. If the shared proxy is not on this instance yet:

```bash
git clone https://github.com/TheoGibbons/hobby-traefik.git ~/projects/hobby-traefik
cd ~/projects/hobby-traefik
bash scripts/deploy.sh
```

Then:

```bash
git clone https://github.com/TheoGibbons/measure-the-baby.git ~/projects/measure-the-baby
cd ~/projects/measure-the-baby
cp .env.production.example .env

# Set before continuing:
#   APP_HOST  public DNS name, already pointing at this instance
nano .env

bash scripts/deploy.sh
```

Open the HTTPS hostname you set as `APP_HOST`. Production forces secure cookies and
adds TLS through the shared `letsencrypt` resolver.

Security group: 22 for administration, 80 and 443 for Traefik. Nothing else.

Deploys on this path do not take the site down. The script starts the new release beside
the old one with the [docker-rollout](https://github.com/wowu/docker-rollout) CLI plugin,
waits for it to pass its health check, lets Traefik drain the old one, then removes it. A
release that never turns healthy is discarded and the old one keeps serving. Deploying
hobby-traefik installs the plugin; the script stops before pulling, with the install
command, on a server that lacks it.

## Deploying Locally

Needs only Docker. Nothing is published beyond loopback.

```bash
git clone https://github.com/TheoGibbons/measure-the-baby.git ~/projects/measure-the-baby
cd ~/projects/measure-the-baby
cp .env.example .env

bash scripts/up-local.sh
```

Open <http://localhost:3081>. Change `APP_BIND` or `APP_PORT` in `.env` to move it.

## Deploying Locally with hobby-traefik

Start the shared proxy first if it is not already running:

```bash
git clone https://github.com/TheoGibbons/hobby-traefik.git ~/projects/hobby-traefik
cd ~/projects/hobby-traefik
cp .env.example .env
bash scripts/up-local.sh
```

Then:

```bash
git clone https://github.com/TheoGibbons/measure-the-baby.git ~/projects/measure-the-baby
cd ~/projects/measure-the-baby
cp .env.traefik.example .env

bash scripts/up-local-traefik.sh
```

Open <http://baby.localhost:8085>. The script passes its `-f` files explicitly, so
Compose does not also load the standalone port override — traffic follows the same
Traefik-to-container path used on the server.

## Setup push-to-deploy

A push to `main` runs `.github/workflows/deploy.yml`, which first runs `npm test`
with Node 24. Only after the tests pass does it SSH to the instance and run
`bash scripts/deploy.sh` in `~/projects/measure-the-baby`. Pull requests targeting
`main` run the same tests without deploying. Run `npm test` locally before committing.

**Part 1 — once per server, not once per project.** The instance needs to read GitHub
so `git pull --ff-only` works. Skip this if another project on the same box has
already done it; skip it entirely if this repository is public.

```bash
# On the EC2 instance. Create a fine-grained PAT with Contents: Read-only,
# scoped to the repositories this box deploys:
#   https://github.com/settings/personal-access-tokens
read -rsp 'PAT: ' PAT && echo

git config --global credential.helper store
printf 'https://x-access-token:%s@github.com\n' "$PAT" > ~/.git-credentials
chmod 600 ~/.git-credentials
```

A deploy key cannot be shared between projects: GitHub binds one to a single
repository and rejects the same key on a second with "Key is already in use". One
PAT covers every repository on the box.

**Part 2 — once per repository.** The same EC2 keypair is reused for every project,
so only these four secrets are new. Create a GitHub environment named `production`,
then:

```bash
# Locally, with the gh CLI authenticated:
gh secret set EC2_HOST            --env production --body '<ec2-public-dns>'
gh secret set EC2_USER            --env production --body 'ubuntu'
gh secret set EC2_SSH_PRIVATE_KEY --env production < ~/.ssh/<ec2-deploy-key>
gh secret set EC2_KNOWN_HOSTS     --env production \
  --body "$(ssh-keyscan -H <ec2-public-dns> 2>/dev/null)"
```

The deploy stops rather than overwrite tracked files edited directly on the server.
Commit through Git instead of letting the live and local copies drift.

A push deploys with the `scripts/deploy.sh` already on the server, which then pulls. A
change to the script itself therefore takes effect from the deploy after the one that
ships it.

## What it is

- Immediate blank-profile creation, followed by in-place name, sex, and date-of-birth editing
- Separate length/height, weight, head circumference, and BMI-for-age charts
- Five WHO reference curves: 3rd, 15th, 50th, 85th, and 97th percentiles
- Smoothed recorded lines that pass through each measurement dot
- Shared age range through today, while each recorded line stops at its own latest entry
- Batch measurement entry with remembered value/unit, CSV preview import, edit, and delete
- Automatic BMI rows when length and weight share a date
- Full CSV export, with exported files accepted by each metric's import flow
- Two-page print layout with two charts per page and app controls hidden
- Installable PWA manifest and app-shell service worker
- Account isolation, scrypt password hashing, opaque HTTP-only sessions, input validation, and basic sign-in rate limiting

Enter an email and a password of at least 8 characters. A new email creates an
account; an existing email signs in. There is intentionally no password-reset flow.

## How it works

One container built from this repository, storing everything in a SQLite file on the
`measure-the-baby_growth_data` volume. `docker-compose.yml` is proxy-agnostic;
`docker-compose.override.yml` adds the standalone host port and is loaded
automatically by plain `docker compose` commands, while `docker-compose.traefik.yml`
and `docker-compose.prod.yml` are passed explicitly by the scripts and therefore
suppress it.

### CSV format

Metric modals accept:

    date,value,unit,comments
    2026-01-15,68.2,cm,Clinic visit
    2026-02-15,69.1,cm,

A full export adds a type column. If that file is imported from a metric modal, only
rows matching the open metric are added to the review grid.

Supported units:

- Length/height and head circumference: cm, in
- Weight: kg, lb
- BMI: kg/m2

### Growth references

Reference values are generated from the official WHO Child Growth Standards
expanded daily LMS workbooks for birth through 5 years:

https://www.who.int/tools/child-growth-standards/standards

The checked-in `public/growth-data.json` lets the app calculate percentiles and draw
curves without internet access. To refresh it (Python 3.8+, no extra packages):

    python3 scripts/fetch-growth-data.py

Percentiles use sex-specific LMS parameters for the exact age in calendar days,
the WHO LMS z-score formula, and the standard normal cumulative distribution.
The displayed rank is rounded to the nearest integer, with `<3rd` / `>97th` labels
outside the outer chart curves. Weight and BMI apply WHO's SD-interval adjustment
beyond z-scores of ±3. Chart curves are sampled separately; percentile calculations
do not interpolate between the drawn curves or round age to months.

Calculated BMI is weight in kilograms divided by squared length/height in metres.
It retains full precision for the percentile calculation and rounds only for display.
It uses measurements on the same date; a manually entered BMI takes precedence.
Head circumference uses the recorded centimetre value (inches are converted with
1 in = 2.54 cm) and the sex-specific WHO head-circumference-for-age reference.

Regression checks include BMI and head circumference values from WHO's separate
published percentile workbooks, for both sexes from birth through 60 months.
Source URLs and workbook hashes are recorded in
`tests/fixtures/who-bmi-head-percentiles.json`.

The WHO curves stop at 60 months; personal measurements and the chart age axis may
continue beyond that point. WHO's daily tables use lying-down length through day
730 and standing height from day 731. The height and BMI curves preserve that
transition. Entries must use the corresponding measurement method; the app does
not store posture or automatically convert it. For a lying-down measurement at age
2 or older, subtract 0.7 cm before entering it (add 0.7 cm for a standing measurement
before age 2). Age is chronological; prematurity is not automatically corrected.

Growth charts are screening aids, not diagnostic tools. Measurement technique,
prematurity, and clinical context matter; discuss growth concerns with a qualified
clinician.

## Configuration

| Variable | Where | Purpose |
|---|---|---|
| `APP_BIND` | `.env` | Host interface for the standalone port. `127.0.0.1` locally, `0.0.0.0` for standalone LIVE |
| `APP_PORT` | `.env` | Host port for the standalone path. `3081` locally, `80` for standalone LIVE |
| `APP_HOST` | `.env` | Public hostname, read only by the Traefik overlay |
| `SESSION_DAYS` | `docker-compose.yml` | Session lifetime, default 1826 days |
| `COOKIE_SECURE` | Compose overlays | `true` in production, `false` locally because `baby.localhost` is plain HTTP |

Signing in lasts five years, so reopening the app goes straight to the charts.
Browsers will not hold a cookie that long in one go (Chromium clamps expiry to 400
days), so the session cookie is re-issued each time the app checks its session;
opening the app at least once a year carries the full term. Use Sign out to end a
session on the server immediately.

## Operating it

Stop the stack without losing data:

```bash
docker compose down
```

That preserves the named data volume. **Do not add `-v`** unless you intend to delete
every account, profile, and measurement.

SQLite data lives in the Docker volume `measure-the-baby_growth_data`. The in-app CSV
export is the simplest portable backup. For a full backup, stop the stack and copy the
contents of that named volume.

During a LIVE deploy two containers share that volume for up to half a minute, which
SQLite's WAL mode handles. The Traefik overlay sets a `measure-the-baby-lb` sticky cookie,
holding only an identifier for the container, so a browser loads the page and the service
worker installs its app shell from one release rather than a mix of both. Container
names change on every deploy, so address the service rather than the container:
`docker compose -f docker-compose.yml -f docker-compose.traefik.yml -f docker-compose.prod.yml logs app`.

## Security notes

- The standalone LIVE path serves plain HTTP with non-secure session cookies. It is
  intended to sit behind a TLS terminator, not to face the internet directly.
- The Traefik path forces HTTPS and secure cookies.
- There is no password-reset flow by design, so an unrecoverable password means an
  unrecoverable account.

## Development

Node.js 24 or newer is required, because the backend uses Node's built-in SQLite
support.

    npm.cmd start
    npm.cmd test
