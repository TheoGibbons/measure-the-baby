# Measure the Baby

A small, private baby growth-chart app. It runs as one Docker container, stores its data in a persistent SQLite volume, and serves a framework-free single-page frontend.

## Start it

This stack is intended to sit behind Traefik on the same EC2 host. Copy the example settings and replace the hostname and Traefik names with the ones used by the existing proxy:

    cp .env.example .env

The required settings are:

- APP_HOST: public DNS name for this app, such as baby.example.com
- TRAEFIK_NETWORK: external Docker network already shared by Traefik
- TRAEFIK_ENTRYPOINT: HTTPS entrypoint name, normally websecure
- TRAEFIK_CERT_RESOLVER: certificate resolver configured in Traefik, normally letsencrypt

If the shared network does not exist yet, create it once and attach the Traefik service to it as well:

    docker network create traefik

Then start the application:

    docker compose up -d --build

Open the HTTPS hostname configured as APP_HOST. The application does not publish a host port; Traefik reaches port 3000 over the shared Docker network.

Enter an email and a password of at least 8 characters. A new email creates an account; an existing email signs in. There is intentionally no password-reset flow.

The container is left running by the build process. Stop it with:

    docker compose down

The down command preserves the named data volume. Do not add -v unless you intend to delete every account, profile, and measurement.

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

HTTPS-only session cookies are enabled in docker-compose.yml because Traefik terminates TLS for this app.

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
