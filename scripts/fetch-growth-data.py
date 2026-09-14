#!/usr/bin/env python3
"""Build offline WHO daily LMS references and chart curves (Python 3.8+, stdlib only)."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from hashlib import sha256
from io import BytesIO
import json
import math
from pathlib import Path
import statistics
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET
from zipfile import ZipFile


BASE = "https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/"
SOURCES = {
    "length": ("length-height-for-age/expandable-tables", "lhfa"),
    "weight": ("weight-for-age/expanded-tables", "wfa"),
    "head": ("head-circumference-for-age/expanded-tables", "hcfa"),
    "bmi": ("body-mass-index-for-age/expanded-tables", "bfa"),
}
PERCENTILES = (3, 15, 50, 85, 97)
DAYS_PER_MONTH = 30.4375
LAST_DAY = 1856
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def read_lms(workbook):
    with ZipFile(BytesIO(workbook)) as archive:
        strings = ET.fromstring(archive.read("xl/sharedStrings.xml"))
        shared = ["".join(si.itertext()) for si in strings]
        sheet = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))

    headers = {}
    result = []
    for row in sheet.findall("m:sheetData/m:row", NS):
        cells = {}
        for cell in row:
            value = cell.find("m:v", NS)
            if value is None:
                continue
            column = "".join(c for c in cell.get("r") if c.isalpha())
            cells[column] = shared[int(value.text)] if cell.get("t") == "s" else value.text
        if not headers:
            headers = cells
            if not {"Day", "L", "M", "S"}.issubset(headers.values()):
                raise ValueError("WHO workbook is missing Day/L/M/S headers")
            continue
        values = {headers[c]: value for c, value in cells.items() if c in headers}
        if "Day" not in values:
            continue
        if float(values["Day"]) != len(result):
            raise ValueError("WHO daily rows must be consecutive, starting at birth")
        # Remove Excel's binary-float serialization noise, preserving all WHO precision.
        lms = [round(float(values[key]), 8) for key in ("L", "M", "S")]
        if not all(math.isfinite(v) for v in lms) or min(lms[1:]) <= 0:
            raise ValueError("Invalid WHO LMS parameters")
        result.append(lms)
    if len(result) != LAST_DAY + 1:
        raise ValueError(f"Expected {LAST_DAY + 1} daily rows, got {len(result)}")
    return result


def chart_rows(lms, metric):
    # Only the chart is sampled by month; individual percentiles use exact days.
    ages = [float(month) for month in range(61)]
    if metric in ("length", "bmi"):
        ages.remove(24.0)
        ages.extend((730 / DAYS_PER_MONTH, 731 / DAYS_PER_MONTH))
    result = []
    for month in sorted(ages):
        day = month * DAYS_PER_MONTH
        lower = math.floor(day)
        upper = math.ceil(day)
        ratio = day - lower
        l, m, s = [a + (b - a) * ratio for a, b in zip(lms[lower], lms[upper])]
        row = {"month": month}
        for percentile in PERCENTILES:
            z = statistics.NormalDist().inv_cdf(percentile / 100)
            value = m * math.exp(s * z) if l == 0 else m * (1 + l * s * z) ** (1 / l)
            row[f"p{percentile}"] = round(value, 4)
        result.append(row)
    return result


def fetch_source(source):
    sex, metric, url = source
    print(f"Fetching {sex} {metric}...", flush=True)
    with urlopen(Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=60) as response:
        workbook = response.read()
    return sex, metric, read_lms(workbook), {"url": url, "sha256": sha256(workbook).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent.parent / "public/growth-data.json")
    args = parser.parse_args()
    sources = [
        (sex, metric, f"{BASE}{directory}/{prefix}-{label}-zscore-expanded-tables.xlsx")
        for sex, label in (("male", "boys"), ("female", "girls"))
        for metric, (directory, prefix) in SOURCES.items()
    ]
    daily = {sex: {} for sex in ("male", "female")}
    curves = {sex: {} for sex in daily}
    files = []
    with ThreadPoolExecutor(max_workers=4) as executor:
        for sex, metric, lms, provenance in executor.map(fetch_source, sources):
            daily[sex][metric] = lms
            curves[sex][metric] = chart_rows(lms, metric)
            files.append(provenance)
    result = {
        "source": {
            "name": "WHO Child Growth Standards",
            "reference": "WHO 2006/2007 child growth standards, birth to 5 years",
            "percentiles": PERCENTILES,
            "retrievedOn": date.today().isoformat(),
            "home": "https://www.who.int/tools/child-growth-standards/standards",
            "note": "Daily LMS arrays are indexed by age in days; each row is [L, M, S]. Length through day 730, standing height from day 731. Charts and percentile labels stop at 60 months.",
            "files": files,
        },
        "data": curves,
        "lms": daily,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Fetch and validate every workbook before replacing the checked-in artifact.
    args.output.write_text(json.dumps(result, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")
    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
