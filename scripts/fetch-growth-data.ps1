param(
  [string]$OutputPath = (Join-Path $PSScriptRoot '..\public\growth-data.json')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$sources = @(
  @{ Key='length-female-0-2'; Metric='length'; Sex='female'; Start=0; End=24; Url='https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/length-height-for-age/tab_lhfa_girls_p_0_2.xlsx?sfvrsn=770a5ab8_9' },
  @{ Key='length-female-2-5'; Metric='length'; Sex='female'; Start=25; End=60; Url='https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/length-height-for-age/tab_lhfa_girls_p_2_5.xlsx?sfvrsn=5716360d_9' },
  @{ Key='length-male-0-2'; Metric='length'; Sex='male'; Start=0; End=24; Url='https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/length-height-for-age/tab_lhfa_boys_p_0_2.xlsx?sfvrsn=308931b2_12' },
  @{ Key='length-male-2-5'; Metric='length'; Sex='male'; Start=25; End=60; Url='https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/length-height-for-age/tab_lhfa_boys_p_2_5.xlsx?sfvrsn=d6758a88_9' },
  @{ Key='weight-female'; Metric='weight'; Sex='female'; Start=0; End=60; Url='https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/weight-for-age/tab_wfa_girls_p_0_5.xlsx?sfvrsn=666fe445_7' },
  @{ Key='weight-male'; Metric='weight'; Sex='male'; Start=0; End=60; Url='https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/weight-for-age/tab_wfa_boys_p_0_5.xlsx?sfvrsn=a0b3ed5_7' },
  @{ Key='head-female'; Metric='head'; Sex='female'; Start=0; End=60; Url='https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/head-circumference-for-age/tab_hcfa_girls_p_0_5.xlsx?sfvrsn=ad755200_5' },
  @{ Key='head-male'; Metric='head'; Sex='male'; Start=0; End=60; Url='https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/head-circumference-for-age/tab_hcfa_boys_p_0_5.xlsx?sfvrsn=d6284c4c_5' },
  @{ Key='bmi-female-0-2'; Metric='bmi'; Sex='female'; Start=0; End=24; Url='https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/body-mass-index-for-age/tab_bmi_girls_p_0_2.xlsx?sfvrsn=47b71c57_5' },
  @{ Key='bmi-female-2-5'; Metric='bmi'; Sex='female'; Start=25; End=60; Url='https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/body-mass-index-for-age/tab_bmi_girls_p_2_5.xlsx?sfvrsn=82b179c7_5' },
  @{ Key='bmi-male-0-2'; Metric='bmi'; Sex='male'; Start=0; End=24; Url='https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/body-mass-index-for-age/tab_bmi_boys_p_0_2.xlsx?sfvrsn=b5e6cb08_5' },
  @{ Key='bmi-male-2-5'; Metric='bmi'; Sex='male'; Start=25; End=60; Url='https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/body-mass-index-for-age/tab_bmi_boys_p_2_5.xlsx?sfvrsn=f25b7478_7' }
)

function Read-ZipEntryText {
  param(
    [System.IO.Compression.ZipArchive]$Archive,
    [string]$EntryName
  )
  $entry = $Archive.GetEntry($EntryName)
  if (-not $entry) { throw "Missing $EntryName in workbook." }
  $reader = [System.IO.StreamReader]::new($entry.Open())
  try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}

function Read-PercentileWorkbook {
  param([string]$Path)

  $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
  try {
    [xml]$sharedXml = Read-ZipEntryText -Archive $archive -EntryName 'xl/sharedStrings.xml'
    [xml]$sheetXml = Read-ZipEntryText -Archive $archive -EntryName 'xl/worksheets/sheet1.xml'
  } finally {
    $archive.Dispose()
  }

  $shared = @(
    $sharedXml.sst.si | ForEach-Object {
      if ($null -ne $_.t) { [string]$_.t }
      else { [string](($_.r | ForEach-Object { $_.t }) -join '') }
    }
  )

  $namespace = [System.Xml.XmlNamespaceManager]::new($sheetXml.NameTable)
  $namespace.AddNamespace('m', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')
  $xmlRows = @($sheetXml.SelectNodes('//m:sheetData/m:row', $namespace))
  if ($xmlRows.Count -lt 2) { throw "Workbook has no percentile rows." }

  function Resolve-Cell {
    param($Cell)
    $raw = [string]$Cell.v
    if ($Cell.t -eq 's') { return $shared[[int]$raw] }
    return $raw
  }

  $headers = @{}
  foreach ($cell in $xmlRows[0].c) {
    $column = ([regex]::Match([string]$cell.r, '^[A-Z]+')).Value
    $headers[$column] = Resolve-Cell $cell
  }

  $parsed = @()
  for ($rowIndex = 1; $rowIndex -lt $xmlRows.Count; $rowIndex++) {
    $values = @{}
    foreach ($cell in $xmlRows[$rowIndex].c) {
      $column = ([regex]::Match([string]$cell.r, '^[A-Z]+')).Value
      if ($headers.ContainsKey($column)) {
        $values[$headers[$column]] = Resolve-Cell $cell
      }
    }
    if (-not $values.ContainsKey('Month') -or [string]::IsNullOrWhiteSpace([string]$values['Month'])) { continue }
    $parsed += [pscustomobject]@{
      month = [int][double]$values['Month']
      p3 = [math]::Round([double]$values['P3'], 4)
      p15 = [math]::Round([double]$values['P15'], 4)
      p50 = [math]::Round([double]$values['P50'], 4)
      p85 = [math]::Round([double]$values['P85'], 4)
      p97 = [math]::Round([double]$values['P97'], 4)
    }
  }
  return $parsed
}

$growthTemp = Join-Path ([System.IO.Path]::GetTempPath()) ('measure-the-baby-who-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $growthTemp | Out-Null

try {
  $data = [ordered]@{
    male = [ordered]@{ length=@(); weight=@(); head=@(); bmi=@() }
    female = [ordered]@{ length=@(); weight=@(); head=@(); bmi=@() }
  }

  foreach ($source in $sources) {
    Write-Host "Fetching $($source.Key)..."
    $workbookPath = Join-Path $growthTemp ($source.Key + '.xlsx')
    Invoke-WebRequest -UseBasicParsing -Uri $source.Url -OutFile $workbookPath
    $rows = Read-PercentileWorkbook -Path $workbookPath |
      Where-Object { $_.month -ge $source.Start -and $_.month -le $source.End }
    $data[$source.Sex][$source.Metric] += $rows
  }

  foreach ($sex in @('male', 'female')) {
    foreach ($metric in @('length', 'weight', 'head', 'bmi')) {
      $data[$sex][$metric] = @($data[$sex][$metric] | Sort-Object month)
      if ($data[$sex][$metric].Count -ne 61) {
        throw "$sex $metric produced $($data[$sex][$metric].Count) rows; expected 61 months."
      }
    }
  }

  $result = [ordered]@{
    source = [ordered]@{
      name = 'WHO Child Growth Standards'
      reference = 'WHO 2006 child growth standards, birth to 5 years'
      percentiles = @(3, 15, 50, 85, 97)
      retrievedOn = (Get-Date).ToString('yyyy-MM-dd')
      home = 'https://www.who.int/tools/child-growth-standards/standards'
      note = 'Length reference is used through month 24 and standing height reference from month 25. Reference lines end at 60 months; recorded values can continue.'
      files = @($sources | ForEach-Object { $_.Url })
    }
    data = $data
  }

  $resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
  New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($resolvedOutput)) | Out-Null
  $json = $result | ConvertTo-Json -Depth 12 -Compress
  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($resolvedOutput, $json, $utf8NoBom)
  Write-Host "Wrote $resolvedOutput"
} finally {
  $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  $resolvedTemp = [System.IO.Path]::GetFullPath($growthTemp)
  if ($resolvedTemp.StartsWith($tempRoot) -and (Test-Path -LiteralPath $resolvedTemp)) {
    Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
  }
}
