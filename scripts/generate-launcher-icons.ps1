param()

# Deterministic Android density exports from the checked-in ImageGen master.
# Run from any directory with Windows PowerShell / System.Drawing.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$res = Join-Path $root 'android/app/src/main/res'
$branding = Join-Path $root 'assets/branding'
$output = Join-Path $root '.superpowers/app-icon'
New-Item -ItemType Directory -Path $output -Force | Out-Null

Add-Type -TypeDefinition @'
using System.Drawing;
public static class LauncherAlphaBounds {
    public static Rectangle Find(Bitmap image) {
        int left = image.Width, top = image.Height, right = -1, bottom = -1;
        for (int y = 0; y < image.Height; y++) {
            for (int x = 0; x < image.Width; x++) {
                if (image.GetPixel(x, y).A <= 8) continue;
                left = System.Math.Min(left, x); top = System.Math.Min(top, y);
                right = System.Math.Max(right, x); bottom = System.Math.Max(bottom, y);
            }
        }
        if (right < left) throw new System.InvalidOperationException("Empty foreground");
        return Rectangle.FromLTRB(left, top, right + 1, bottom + 1);
    }
    public static double Radius(Bitmap image, Rectangle bounds) {
        double cx = bounds.X + bounds.Width / 2.0, cy = bounds.Y + bounds.Height / 2.0;
        double maxSquared = 0;
        for (int y = bounds.Top; y < bounds.Bottom; y++) {
            for (int x = bounds.Left; x < bounds.Right; x++) {
                if (image.GetPixel(x, y).A <= 8) continue;
                double dx = x + 0.5 - cx, dy = y + 0.5 - cy;
                maxSquared = System.Math.Max(maxSquared, dx * dx + dy * dy);
            }
        }
        return System.Math.Sqrt(maxSquared);
    }
}
'@ -ReferencedAssemblies System.Drawing

function New-Canvas([int] $size) {
    return [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
}

function New-Graphics($bitmap) {
    $g = [System.Drawing.Graphics]::FromImage($bitmap)
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    return $g
}

function Save-Png($bitmap, [string] $path) {
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
}

function New-RoundedMask([int] $size, [string] $shape) {
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    if ($shape -eq 'circle') {
        $path.AddEllipse(0, 0, $size, $size)
    } else {
        $diameter = [single]($size * 0.44)
        $edge = [single]($size - $diameter)
        $path.AddArc(0, 0, $diameter, $diameter, 180, 90)
        $path.AddArc($edge, 0, $diameter, $diameter, 270, 90)
        $path.AddArc($edge, $edge, $diameter, $diameter, 0, 90)
        $path.AddArc(0, $edge, $diameter, $diameter, 90, 90)
        $path.CloseFigure()
    }
    return $path
}

$master = [System.Drawing.Bitmap]::new((Join-Path $branding 'launcher-foreground-source.png'))
$bounds = [LauncherAlphaBounds]::Find($master)
$radius = [LauncherAlphaBounds]::Radius($master, $bounds)
# Keep the actual alpha silhouette inside a 64dp diameter circle, leaving 1dp
# inside the official 66dp safe circle even at the outermost curved corners.
$logoDp = [Math]::Min(64.0, 32.0 * [Math]::Max($bounds.Width, $bounds.Height) / $radius)
$cream = [System.Drawing.ColorTranslator]::FromHtml('#FFF1DD')

function New-Foreground([int] $size, [double] $fraction) {
    $bitmap = New-Canvas $size
    $g = New-Graphics $bitmap
    try {
        # Use visible alpha bounds rather than the AI-generated canvas margins.
        $scale = $size * $fraction / [Math]::Max($bounds.Width, $bounds.Height)
        $width = [single]($bounds.Width * $scale)
        $height = [single]($bounds.Height * $scale)
        $rect = [System.Drawing.RectangleF]::new(($size - $width) / 2, ($size - $height) / 2, $width, $height)
        $g.DrawImage($master, $rect, $bounds, [System.Drawing.GraphicsUnit]::Pixel)
    } finally { $g.Dispose() }
    return $bitmap
}

function New-Composite([int] $size, [string] $shape, [double] $fraction = ($logoDp / 72.0)) {
    $bitmap = New-Canvas $size
    $g = New-Graphics $bitmap
    $mask = $null
    $foreground = New-Foreground $size $fraction
    try {
        if ($shape -ne 'square') {
            $mask = New-RoundedMask $size $shape
            $g.SetClip($mask)
        }
        $g.Clear([System.Drawing.Color]::Transparent)
        $brush = [System.Drawing.SolidBrush]::new($cream)
        try { $g.FillRectangle($brush, 0, 0, $size, $size) } finally { $brush.Dispose() }
        $g.DrawImage($foreground, 0, 0, $size, $size)
    } finally {
        $foreground.Dispose()
        if ($null -ne $mask) { $mask.Dispose() }
        $g.Dispose()
    }
    return $bitmap
}

try {
    $densities = @(
        @{ Name = 'mdpi'; Legacy = 48; Adaptive = 108 },
        @{ Name = 'hdpi'; Legacy = 72; Adaptive = 162 },
        @{ Name = 'xhdpi'; Legacy = 96; Adaptive = 216 },
        @{ Name = 'xxhdpi'; Legacy = 144; Adaptive = 324 },
        @{ Name = 'xxxhdpi'; Legacy = 192; Adaptive = 432 }
    )
    foreach ($density in $densities) {
        $folder = Join-Path $res ('mipmap-' + $density.Name)
        New-Item -ItemType Directory -Path $folder -Force | Out-Null
        $foreground = New-Foreground $density.Adaptive ($logoDp / 108.0)
        $legacy = New-Composite $density.Legacy 'rounded'
        $round = New-Composite $density.Legacy 'circle'
        try {
            Save-Png $foreground (Join-Path $folder 'ic_launcher_foreground.png')
            Save-Png $legacy (Join-Path $folder 'ic_launcher.png')
            Save-Png $round (Join-Path $folder 'ic_launcher_round.png')
        } finally { $foreground.Dispose(); $legacy.Dispose(); $round.Dispose() }
    }

    $adaptiveMaster = New-Foreground 1080 ($logoDp / 108.0)
    $background = New-Canvas 1080
    $g = New-Graphics $background
    $g.Clear($cream)
    $g.Dispose()
    $flat = New-Composite 1024 'square'
    $store = New-Composite 512 'square'
    try {
        Save-Png $adaptiveMaster (Join-Path $branding 'launcher-foreground-1080.png')
        Save-Png $background (Join-Path $branding 'launcher-background-1080.png')
        Save-Png $flat (Join-Path $branding 'launcher-square-1024.png')
        Save-Png $store (Join-Path $branding 'launcher-square-512.png')
    } finally { $adaptiveMaster.Dispose(); $background.Dispose(); $flat.Dispose(); $store.Dispose() }

    # Shape previews reproduce the central 72dp viewport of the 108dp adaptive layer.
    foreach ($shape in @('rounded', 'circle')) {
        $preview = New-Composite 512 $shape
        try { Save-Png $preview (Join-Path $output ($shape + '-512.png')) } finally { $preview.Dispose() }
    }
    $small = New-Composite 48 'rounded'
    try { Save-Png $small (Join-Path $output 'actual-48.png') } finally { $small.Dispose() }

    Write-Output ('Source alpha bounds: {0},{1} {2}x{3}' -f $bounds.X, $bounds.Y, $bounds.Width, $bounds.Height)
    Write-Output ('Exported five Android densities; foreground width {0:F2}dp inside a 64dp safe circle / 108dp layer.' -f $logoDp)
    Write-Output 'Masters: assets/branding; previews: .superpowers/app-icon'
} finally { $master.Dispose() }
