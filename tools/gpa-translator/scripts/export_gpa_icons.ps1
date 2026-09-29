<#
.SYNOPSIS
Render the installed GPA icon library to a local PNG cache for gui.py.
.DESCRIPTION
Uses the original numeric ID mapping and vector drawings from the installed
GPA assemblies. It only reads the GPA installation. No project is opened or
modified, and no icons are downloaded. Run with Windows PowerShell 5.1 -STA.
#>
[CmdletBinding()]
param(
    [string]$GpaDirectory = "${env:ProgramFiles(x86)}\Gira\Gira Project Assistant\6.0",
    [string]$OutputDirectory = '',
    [ValidateRange(16, 512)]
    [int]$Size = 80
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) '.cache\icons'
}

if ($PSVersionTable.PSEdition -ne 'Desktop') {
    throw 'Use Windows PowerShell (powershell.exe -NoProfile -STA -File export_gpa_icons.ps1), not pwsh.exe.'
}
if ([Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') {
    throw 'The WPF icon renderer requires powershell.exe -STA.'
}

$gpaFullDirectory = (Resolve-Path -LiteralPath $GpaDirectory).Path
$gpaUiPath = Join-Path $gpaFullDirectory 'Kingfisher.Core.Ui.dll'
$gpaStylePath = Join-Path $gpaFullDirectory 'Kingfisher.Style.dll'
foreach ($gpaAssemblyPath in @($gpaUiPath, $gpaStylePath)) {
    if (-not (Test-Path -LiteralPath $gpaAssemblyPath -PathType Leaf)) {
        throw "GPA assembly was not found: $gpaAssemblyPath"
    }
}

Add-Type -AssemblyName PresentationFramework
# Instantiating Application registers WPF's pack URI handler; no window is shown.
if ($null -eq [Windows.Application]::Current) {
    $gpaApplication = New-Object Windows.Application
}
$gpaUiAssembly = [Reflection.Assembly]::LoadFrom($gpaUiPath)
[void][Reflection.Assembly]::LoadFrom($gpaStylePath)

$gpaResolverType = $gpaUiAssembly.GetType('Gira.Kingfisher.Core.Ui.Icons.VisualizationIconResolver', $true)
$gpaMappingField = $gpaResolverType.GetField('IconResourceKeys', [Reflection.BindingFlags]'NonPublic,Public,Static')
if ($null -eq $gpaMappingField) {
    throw 'This GPA version does not expose the expected icon mapping. No guessed icons will be exported.'
}
$gpaMapping = $gpaMappingField.GetValue($null)
if ($null -eq $gpaMapping -or $gpaMapping.Count -eq 0) {
    throw 'The installed GPA icon mapping is empty.'
}

$gpaDrawings = New-Object Windows.ResourceDictionary
# ResourceDictionary implements IDictionary: .Source = would create a key instead.
$gpaDrawings.set_Source([uri]'pack://application:,,,/Kingfisher.Style;component/ResourceDictionaries/DictionaryIcons.xaml')
$gpaCacheDirectory = [IO.Path]::GetFullPath($OutputDirectory)
[void][IO.Directory]::CreateDirectory($gpaCacheDirectory)
$gpaManifestIcons = [ordered]@{}
$gpaPadding = [Math]::Max(2, [Math]::Round($Size * 0.05))
$gpaContentSize = $Size - 2 * $gpaPadding

foreach ($gpaId in ($gpaMapping.Keys | Sort-Object)) {
    $gpaResourceKey = $gpaMapping[$gpaId]
    $gpaBrush = $gpaDrawings[$gpaResourceKey]
    if ($gpaBrush -isnot [Windows.Media.DrawingBrush]) {
        throw "Icon $gpaId ($gpaResourceKey) has no expected DrawingBrush."
    }

    $gpaVisual = New-Object Windows.Media.DrawingVisual
    $gpaContext = $gpaVisual.RenderOpen()
    try {
        $gpaRectangle = New-Object Windows.Rect($gpaPadding, $gpaPadding, $gpaContentSize, $gpaContentSize)
        $gpaContext.DrawRectangle($gpaBrush, $null, $gpaRectangle)
    }
    finally {
        $gpaContext.Close()
    }
    $gpaBitmap = New-Object Windows.Media.Imaging.RenderTargetBitmap(
        $Size, $Size, 96, 96, [Windows.Media.PixelFormats]::Pbgra32)
    $gpaBitmap.Render($gpaVisual)
    $gpaEncoder = New-Object Windows.Media.Imaging.PngBitmapEncoder
    $gpaEncoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($gpaBitmap))
    $gpaFilePath = Join-Path $gpaCacheDirectory "$gpaId.png"
    $gpaStream = [IO.File]::Create($gpaFilePath)
    try {
        $gpaEncoder.Save($gpaStream)
    }
    finally {
        $gpaStream.Dispose()
    }
    $gpaManifestIcons[[string]$gpaId] = $gpaResourceKey
}

$gpaManifest = [ordered]@{
    source = $gpaFullDirectory
    assembly_version = $gpaUiAssembly.GetName().Version.ToString()
    size = $Size
    icons = $gpaManifestIcons
}
$gpaManifestJson = $gpaManifest | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText((Join-Path $gpaCacheDirectory 'catalog.json'), $gpaManifestJson, (New-Object Text.UTF8Encoding($false)))
Write-Output "Exported $($gpaManifestIcons.Count) original GPA icons to $gpaCacheDirectory"
