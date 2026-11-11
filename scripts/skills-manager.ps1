param (
    [Parameter(Position=0)]
    [string]$Command = "list",

    [Parameter(Position=1)]
    [string]$Argument = ""
)

$WorkspaceRoot = Split-Path -Parent $PSScriptRoot
$SkillsDir = Join-Path $WorkspaceRoot "_agent\skills"
$DataDir = Join-Path $WorkspaceRoot "data"

function Get-SkillList {
    $skills = @()
    if (Test-Path $SkillsDir) {
        $skillDirs = Get-ChildItem -Path $SkillsDir -Directory
        foreach ($dir in $skillDirs) {
            $skillFile = Join-Path $dir.FullName "SKILL.md"
            if (Test-Path $skillFile) {
                $raw = [System.IO.File]::ReadAllText($skillFile, [System.Text.Encoding]::UTF8)
                $name = $dir.Name
                $desc = ""
                
                if ($raw -match '(?ms)^---\s*\r?\n(.*?)\r?\n---') {
                    $frontmatter = $matches[1]
                    if ($frontmatter -match 'name:\s*([^\r\n]+)') {
                        $name = $matches[1].Trim()
                    }
                    if ($frontmatter -match '(?ms)description:\s*(?:>-\s*)?(.*?)(?:^[a-zA-Z0-9_\-]+:|\Z)') {
                        $desc = ($matches[1] -replace '\r?\n', ' ').Trim()
                    }
                }

                $skills += [PSCustomObject]@{
                    Id = $dir.Name
                    Name = $name
                    Description = $desc
                    Path = "_agent/skills/$($dir.Name)/SKILL.md"
                    FullPath = $skillFile
                    LastWrite = $dir.LastWriteTime
                    Content = $raw
                }
            }
        }
    }
    return $skills
}

switch ($Command) {
    "list" {
        Write-Host "==========================================================" -ForegroundColor Cyan
        Write-Host " [Antigravity] Registered Skills List" -ForegroundColor Green
        Write-Host "==========================================================" -ForegroundColor Cyan
        $skills = Get-SkillList
        if ($skills.Count -eq 0) {
            Write-Host "No skills found in _agent/skills" -ForegroundColor Yellow
        } else {
            foreach ($s in $skills) {
                Write-Host "[$($s.Name)]" -ForegroundColor Yellow -NoNewline
                Write-Host " ($($s.Path))" -ForegroundColor Gray
                Write-Host "  Trigger: $($s.Description)" -ForegroundColor White
                Write-Host ""
            }
            Write-Host "Total: $($skills.Count) skills active." -ForegroundColor Cyan
        }
    }

    "dedupe" {
        Write-Host "==========================================================" -ForegroundColor Cyan
        Write-Host " [Antigravity] Deduplication & Quality Check" -ForegroundColor Green
        Write-Host "==========================================================" -ForegroundColor Cyan
        $skills = Get-SkillList
        $issuesFound = $false

        for ($i = 0; $i -lt $skills.Count; $i++) {
            for ($j = $i + 1; $j -lt $skills.Count; $j++) {
                $s1 = $skills[$i]
                $s2 = $skills[$j]

                $words1 = ($s1.Description -split '\s+') | Where-Object { $_.Length -gt 2 }
                $words2 = ($s2.Description -split '\s+') | Where-Object { $_.Length -gt 2 }
                $overlap = $words1 | Where-Object { $words2 -contains $_ }

                if ($overlap.Count -gt 4) {
                    $issuesFound = $true
                    Write-Host "WARNING: Overlapping trigger keywords between '$($s1.Name)' and '$($s2.Name)'!" -ForegroundColor Yellow
                    Write-Host "  Overlap: $($overlap -join ', ')" -ForegroundColor DarkYellow
                }
            }
            if ([string]::IsNullOrWhiteSpace($skills[$i].Description)) {
                $issuesFound = $true
                Write-Host "ERROR: Skill '$($skills[$i].Name)' has no trigger description!" -ForegroundColor Red
            }
        }

        if (-not $issuesFound) {
            Write-Host "SUCCESS: All skills have distinct, valid triggers without duplication." -ForegroundColor Green
        }
    }

    "export-notion" {
        Write-Host "==========================================================" -ForegroundColor Cyan
        Write-Host " Exporting for Notion..." -ForegroundColor Green
        Write-Host "==========================================================" -ForegroundColor Cyan
        $skills = Get-SkillList
        
        $csvPath = Join-Path $DataDir "skills-for-notion.csv"
        $csvData = foreach ($s in $skills) {
            [PSCustomObject]@{
                "Skill" = $s.Name
                "Status" = "Active"
                "Description" = $s.Description
                "Path" = $s.Path
                "LastModified" = $s.LastWrite.ToString("yyyy-MM-dd HH:mm")
            }
        }
        $csvData | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8
        Write-Host "Notion DB CSV: $csvPath" -ForegroundColor Green

        $mdPath = Join-Path $DataDir "skills-for-notion.md"
        $sb = [System.Text.StringBuilder]::new()
        [void]$sb.AppendLine("# Antigravity Skills Database")
        [void]$sb.AppendLine("> Updated: $(Get-Date -Format 'yyyy-MM-dd HH:mm') | Total $($skills.Count) skills`n")
        [void]$sb.AppendLine("| Skill | Status | Trigger Description | Path |")
        [void]$sb.AppendLine("|---|---|---|---|")
        foreach ($s in $skills) {
            [void]$sb.AppendLine("| **$($s.Name)** | Active | $($s.Description) | ``$($s.Path)`` |")
        }
        [System.IO.File]::WriteAllText($mdPath, $sb.ToString(), [System.Text.Encoding]::UTF8)
        Write-Host "Notion Markdown: $mdPath" -ForegroundColor Green
    }

    "export-notebooklm" {
        Write-Host "==========================================================" -ForegroundColor Cyan
        Write-Host " Exporting for Google NotebookLM & Gemini Knowledge Base..." -ForegroundColor Green
        Write-Host "==========================================================" -ForegroundColor Cyan
        $skills = Get-SkillList
        $sourcePath = Join-Path $DataDir "notebooklm-skills-source.md"

        $sb = [System.Text.StringBuilder]::new()
        [void]$sb.AppendLine("# Google NotebookLM & Gemini Knowledge Base: Antigravity Skills")
        [void]$sb.AppendLine("Source generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm')`n")
        [void]$sb.AppendLine("## 1. Skill Catalog & Triggers")
        foreach ($s in $skills) {
            [void]$sb.AppendLine("- **$($s.Name)**: $($s.Description)")
        }
        [void]$sb.AppendLine("`n---`n## 2. Skill Runbooks & Implementation Guides")
        foreach ($s in $skills) {
            [void]$sb.AppendLine("`n### Skill: $($s.Name)")
            [void]$sb.AppendLine("- File Path: $($s.Path)")
            [void]$sb.AppendLine("- Trigger Rule: $($s.Description)")
            [void]$sb.AppendLine("`n#### Instruction Content:`n")
            [void]$sb.AppendLine($s.Content)
            [void]$sb.AppendLine("`n------------------------------------------------------------`n")
        }

        [System.IO.File]::WriteAllText($sourcePath, $sb.ToString(), [System.Text.Encoding]::UTF8)
        Write-Host "NotebookLM Source File: $sourcePath" -ForegroundColor Green
        Write-Host "Tip: In notebooklm.google.com, click 'Add Source' -> 'Upload File' and select this file!" -ForegroundColor Cyan
    }

    "export-all" {
        & $PSCommandPath "export-notion"
        & $PSCommandPath "export-notebooklm"
    }

    "test-select" {
        if ([string]::IsNullOrWhiteSpace($Argument)) {
            Write-Host "Usage: .\skills-manager.ps1 test-select <prompt>" -ForegroundColor Yellow
            return
        }
        Write-Host "==========================================================" -ForegroundColor Cyan
        Write-Host " Auto-Selection Simulation for Prompt: '$Argument'" -ForegroundColor Green
        Write-Host "==========================================================" -ForegroundColor Cyan

        $skills = Get-SkillList
        $inputTokens = ($Argument -split '\s+') | Where-Object { $_.Length -gt 1 }
        $scores = @()

        foreach ($s in $skills) {
            $score = 0
            $matchedTokens = @()
            $descLower = $s.Description.ToLower()
            $nameLower = $s.Name.ToLower()

            foreach ($token in $inputTokens) {
                $t = $token.ToLower()
                if ($nameLower.Contains($t)) {
                    $score += 5
                    $matchedTokens += $token
                }
                if ($descLower.Contains($t)) {
                    $score += 2
                    $matchedTokens += $token
                }
            }

            $scores += [PSCustomObject]@{
                Name = $s.Name
                Score = $score
                Matched = ($matchedTokens | Select-Object -Unique) -join ', '
                Description = $s.Description
            }
        }

        $top = $scores | Sort-Object -Property Score -Descending
        $selected = $top[0]

        if ($selected.Score -gt 0) {
            Write-Host "SELECTED SKILL: " -ForegroundColor Green -NoNewline
            Write-Host "$($selected.Name)" -ForegroundColor Yellow
            Write-Host "Score: $($selected.Score) (Matched: $($selected.Matched))" -ForegroundColor Cyan
            Write-Host "Description: $($selected.Description)" -ForegroundColor Gray
            Write-Host "`nAntigravity will automatically load this skill when this prompt is sent!" -ForegroundColor Green
        } else {
            Write-Host "No specific skill triggered. Standard agent mode will be used." -ForegroundColor Yellow
        }
    }

    default {
        Write-Host "Available commands: list, dedupe, export-notion, export-notebooklm, export-all, test-select <prompt>" -ForegroundColor Cyan
    }
}
