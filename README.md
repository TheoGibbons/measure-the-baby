# Measure the Baby

A small, private baby growth-chart app. It runs as one Docker container, stores its data in a persistent SQLite volume, and serves a framework-free single-page frontend.

## Start with Docker

Traefik is optional. A normal clone runs as a standalone application:

```bash
docker compose up -d --build
```

Open <http://localhost:3081>. Plain Docker Compose automatically merges
`docker-compose.override.yml`, which publishes the app on loopback. To change
the bind address or port, copy `.env.example` to `.env` and edit `APP_BIND` or
`APP_PORT`.

## Develop through the shared Traefik proxy

The shared Traefik stack must be running first. From its repository:

```bash
cd ~/projects/hobby-traefik
./scripts/up-local.sh
```

Then start this application:

```bash
cd ~/measure-the-baby
cp .env.traefik.example .env
./scripts/up-local.sh
```

Open <http://baby.localhost:8085>. The local script explicitly combines the
proxy-agnostic core with `docker-compose.traefik.yml`, so it does not load the
standalone port override. Traffic follows the same Traefik-to-container path
used on EC2.

### Deploy on EC2

Deploy the central `hobby-traefik` repository first. Then clone this repository
at the path expected by its deployment workflow and set the public hostname:

```bash
git clone git@github.com:TheoGibbons/measure-the-baby.git ~/measure-the-baby
cd ~/measure-the-baby
cp .env.production.example .env
nano .env
chmod +x scripts/deploy.sh
./scripts/deploy.sh
```

The script pulls with `--ff-only`, combines the core, Traefik, and production
overlays, rebuilds, and waits for the health check. Production forces secure
cookies and adds TLS through the shared `letsencrypt` resolver.

Open the HTTPS hostname configured as `APP_HOST`.

### Push-to-deploy

`.github/workflows/deploy.yml` invokes the same script after a push to `main`.
Create a GitHub environment named `production` and configure `EC2_HOST`,
`EC2_USER`, `EC2_SSH_PRIVATE_KEY`, and `EC2_KNOWN_HOSTS` secrets. The EC2 clone
also needs a GitHub deploy key so its own `git pull` can read this repository.

Enter an email and a password of at least 8 characters. A new email creates an account; an existing email signs in. There is intentionally no password-reset flow.

For a standalone installation, stop the container with:

    docker compose down

The down command preserves the named data volume. Do not add `-v` unless you
intend to delete every account, profile, and measurement.

## What is included

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

## CSV format

Metric modals accept:

    date,value,unit,comments
    2026-01-15,68.2,cm,Clinic visit
    2026-02-15,69.1,cm,

A full export adds a type column. If that file is imported from a metric modal, only rows matching the open metric are added to the review grid.

Supported units:

- Length/height and head circumference: cm, in
- Weight: kg, lb
- BMI: kg/m2

## Data and backups

SQLite data is stored in the Docker volume measure-the-baby_growth_data. The in-app CSV export is the simplest portable backup. For a full backup, stop the stack and copy the contents of that named volume with Docker Desktop or your usual volume-backup tool.

The production Compose overlay makes session cookies HTTPS-only. Local Compose
uses non-secure cookies because `baby.localhost` is plain HTTP.

## Growth references

Reference values are generated from the official WHO Child Growth Standards percentile workbooks for birth through 5 years:

https://www.who.int/tools/child-growth-standards/standards

The checked-in public/growth-data.json lets the app draw curves without internet access. To refresh it:

    powershell -File scripts\fetch-growth-data.ps1

The WHO curves stop at 60 months; personal measurements and the chart age axis may continue beyond that point. Length references are used through 24 months and standing-height references from 25 months.

Growth charts are screening aids, not diagnostic tools. Measurement technique, prematurity, and clinical context matter; discuss growth concerns with a qualified clinician.

## Local development

Node.js 24 or newer is required because the backend uses Node's built-in SQLite support.

    npm.cmd start
    npm.cmd test
