# Generate store banner: JPEG, aspect 64:27 (docs: images.banner)
Add-Type -AssemblyName System.Drawing
$w = 1920
$h = 810
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$p1 = New-Object System.Drawing.Point 0, 0
$p2 = New-Object System.Drawing.Point $w, $h
# Light gradient so store detail title (dark text on overlay) stays readable
$c1 = [System.Drawing.Color]::FromArgb(255, 245, 248, 252)
$c2 = [System.Drawing.Color]::FromArgb(255, 228, 236, 244)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $p1, $p2, $c1, $c2
$g.FillRectangle($brush, 0, 0, $w, $h)
$brush.Dispose()

$font = [System.Drawing.Font]::new('Arial', [single]54.0, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$font2 = [System.Drawing.Font]::new('Arial', [single]28.0, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$rect1 = New-Object System.Drawing.RectangleF 0, 280, $w, 120
$rect2 = New-Object System.Drawing.RectangleF 0, 420, $w, 80
$titleBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 26, 40, 58))
$subBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 80, 95, 112))
$g.DrawString('pad-expand-helper', $font, $titleBrush, $rect1, $sf)
$g.DrawString('pad-expand-helper · PCB extension', $font2, $subBrush, $rect2, $sf)
$titleBrush.Dispose()
$subBrush.Dispose()
$font.Dispose()
$font2.Dispose()
$sf.Dispose()
$g.Dispose()

$dir = Join-Path $PSScriptRoot '..\images'
$path = Join-Path $dir 'banner.jpg'
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$encParams = New-Object System.Drawing.Imaging.EncoderParameters 1
$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]92)
$bmp.Save($path, $codec, $encParams)
$bmp.Dispose()
Write-Host "Saved $path"
