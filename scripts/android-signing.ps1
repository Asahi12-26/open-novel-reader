param(
    [ValidateSet('init', 'status', 'backup', 'restore', 'copy-secret', 'clear-clipboard', 'github')]
    [string]$Action = 'status',
    [ValidateSet('ANDROID_KEY_BASE64', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD')]
    [string]$Secret,
    [string]$Repository = 'Asahi12-26/open-novel-reader',
    [string]$SigningDirectory = (Join-Path $env:LOCALAPPDATA 'OpenNovelReader\signing'),
    [string]$BackupDirectory = (Join-Path $env:LOCALAPPDATA 'OpenNovelReaderBackups'),
    [string]$BackupPath,
    # SecureString injection is for local verification only, never plaintext CLI arguments.
    [Security.SecureString]$BackupPassphrase,
    [Security.SecureString]$BackupPassphraseConfirmation
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This helper uses Windows user-bound DPAPI. Use keytool and your operating system credential store elsewhere.' }
$SigningDirectory = [IO.Path]::GetFullPath($SigningDirectory)
$workspace = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
if ($SigningDirectory.Equals($workspace, [StringComparison]::OrdinalIgnoreCase) -or $SigningDirectory.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Store signing material outside the project and its synchronized workspace.'
}
$keyFile = Join-Path $SigningDirectory 'android-release.jks'
$credentialFile = Join-Path $SigningDirectory 'android-release.credential.xml'
$certificateFile = Join-Path $SigningDirectory 'android-release.cer'
$alias = 'onr-release'

function Protect-SigningDirectory([string]$Directory = $SigningDirectory) {
    [IO.Directory]::CreateDirectory($Directory) | Out-Null
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $rights = [Security.AccessControl.FileSystemRights]::FullControl
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $propagate = [Security.AccessControl.PropagationFlags]::None
    foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User, [Security.Principal.SecurityIdentifier]'S-1-5-18')) {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, $rights, $inherit, $propagate, 'Allow')))
    }
    Set-Acl -LiteralPath $Directory -AclObject $acl
}

function Read-SigningCredential {
    if (!(Test-Path -LiteralPath $keyFile -PathType Leaf) -or !(Test-Path -LiteralPath $credentialFile -PathType Leaf)) { throw "Signing material is incomplete in '$SigningDirectory'. Use -SigningDirectory to select the original signing material, or restore your existing secure backup. Do not generate a replacement key." }
    return Import-Clixml -LiteralPath $credentialFile
}

. (Join-Path $PSScriptRoot 'android-signing-backup.ps1')

if ($Action -eq 'backup') {
    # Validate the existing source before asking the user for a backup passphrase.
    $backupCredential = Read-SigningCredential
    try {
        $null = Get-Command keytool -ErrorAction Stop
        $null = Get-OnrPinnedCertificate
        $null = Test-OnrKeystore $keyFile $backupCredential.UserName $backupCredential.GetNetworkCredential().Password
    } finally { $backupCredential = $null }
    $interactive = !$PSBoundParameters.ContainsKey('BackupPassphrase') -and !$PSBoundParameters.ContainsKey('BackupPassphraseConfirmation')
    if ($interactive) {
        Write-Host 'Choose a long unique backup passphrase. Save it independently in your password manager.'
        $BackupPassphrase = Read-Host 'Backup passphrase (hidden)' -AsSecureString
        $BackupPassphraseConfirmation = Read-Host 'Confirm backup passphrase (hidden)' -AsSecureString
    }
    New-OnrSigningBackup -Passphrase $BackupPassphrase -Confirmation $BackupPassphraseConfirmation -Interactive $interactive
    exit
}
if ($Action -eq 'restore') {
    if (!$BackupPath) { throw 'Choose the encrypted archive with -BackupPath.' }
    if (!$BackupPassphrase) { $BackupPassphrase = Read-Host 'Backup passphrase (hidden)' -AsSecureString }
    Restore-OnrSigningBackup -Archive $BackupPath -Passphrase $BackupPassphrase -Destination $SigningDirectory
    Write-Output 'Restore succeeded. The existing public certificate matches the release pin; credentials were protected for this Windows user/machine.'
    exit
}

if ($Action -eq 'clear-clipboard') {
    Set-Clipboard -Value ''
    Write-Output 'Clipboard cleared.'
    exit
}
if ($Action -eq 'init') {
    if ((Test-Path -LiteralPath $keyFile) -or (Test-Path -LiteralPath $credentialFile)) {
        Read-SigningCredential | Out-Null
        Write-Output 'Existing signing key retained; no key was generated.'
    } else {
        $keytool = (Get-Command keytool -ErrorAction Stop).Source
        Protect-SigningDirectory
        $random = New-Object byte[] 48
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($random) } finally { $rng.Dispose() }
        $password = [Convert]::ToBase64String($random)
        $securePassword = ConvertTo-SecureString -String $password -AsPlainText -Force
        $credential = New-Object Management.Automation.PSCredential($alias, $securePassword)
        # Save the user/machine-bound recovery credential before generating the key.
        $credential | Export-Clixml -LiteralPath $credentialFile
        $env:ONR_ANDROID_KEY_PASSWORD = $password
        $previousErrorPreference = $ErrorActionPreference
        try {
            # keytool writes ordinary progress to stderr even on success.
            $ErrorActionPreference = 'Continue'
            $output = & $keytool -genkeypair -noprompt -keystore $keyFile -storetype JKS -keyalg RSA -keysize 3072 -sigalg SHA256withRSA -validity 10000 -alias $alias -dname 'CN=Open Novel Reader, O=Open Novel Reader' -storepass:env ONR_ANDROID_KEY_PASSWORD -keypass:env ONR_ANDROID_KEY_PASSWORD 2>&1
            if ($LASTEXITCODE -ne 0) { throw 'keytool generation failed. Preserve the signing directory and inspect locally before retrying.' }
            $output = & $keytool -exportcert -keystore $keyFile -alias $alias -storepass:env ONR_ANDROID_KEY_PASSWORD -file $certificateFile 2>&1
            if ($LASTEXITCODE -ne 0) { throw 'Certificate export failed; the existing signing key must be retained.' }
        } finally {
            $ErrorActionPreference = $previousErrorPreference
            Remove-Item Env:ONR_ANDROID_KEY_PASSWORD -ErrorAction SilentlyContinue
            $password = $null
        }
        Write-Output 'Created one persistent signing key with a random password. No secret has been printed.'
    }
}

if ($Action -in @('status', 'init')) {
    Read-SigningCredential | Out-Null
    if (!(Test-Path -LiteralPath $certificateFile)) { throw 'Public certificate is missing; export it from the existing key instead of generating a replacement.' }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $fingerprint = ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($certificateFile)))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
    Write-Output "Signing directory: $SigningDirectory"
    Write-Output "Public certificate SHA256: $fingerprint"
    Write-Output 'Private key: password-encrypted JKS; password: Windows current-user/machine DPAPI. Back up both securely before publishing.'
    exit
}

$credential = Read-SigningCredential
if ($Action -eq 'copy-secret') {
    Assert-OnrVerifiedBackup
    if (!$Secret) { throw 'Choose a Secret name; secret values are copied directly and never printed.' }
    $value = switch ($Secret) {
        'ANDROID_KEY_BASE64' { [Convert]::ToBase64String([IO.File]::ReadAllBytes($keyFile)) }
        'ANDROID_KEY_ALIAS' { $credential.UserName }
        'ANDROID_KEY_PASSWORD' { $credential.GetNetworkCredential().Password }
    }
    Set-Clipboard -Value $value
    $value = $null
    Write-Output "$Secret copied for the GitHub Actions secret form. Paste once, save, then run clear-clipboard. Do not paste into chat."
    exit
}

if ($Action -eq 'github') {
    Assert-OnrVerifiedBackup
    if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Use a GitHub owner/repository name.' }
    $gh = (Get-Command gh -ErrorAction Stop).Source
    & $gh auth status *> $null
    if ($LASTEXITCODE -ne 0) { throw 'GitHub CLI is not authenticated. Use the GitHub secret settings page or gh auth login.' }
    $values = @{
        ANDROID_KEY_BASE64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($keyFile))
        ANDROID_KEY_ALIAS = $credential.UserName
        ANDROID_KEY_PASSWORD = $credential.GetNetworkCredential().Password
    }
    try {
        foreach ($name in @('ANDROID_KEY_BASE64', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD')) {
            $start = New-Object Diagnostics.ProcessStartInfo
            $start.FileName = $gh
            $start.Arguments = "secret set $name --repo $Repository"
            $start.UseShellExecute = $false
            $start.CreateNoWindow = $true
            $start.RedirectStandardInput = $true
            $start.RedirectStandardOutput = $true
            $start.RedirectStandardError = $true
            $process = [Diagnostics.Process]::Start($start)
            # PowerShell pipelines append a newline; raw stdin preserves passwords exactly.
            $process.StandardInput.Write($values[$name])
            $process.StandardInput.Close()
            $process.WaitForExit()
            if ($process.ExitCode -ne 0) { throw "Could not set $name. Existing local key retained." }
            $process.Dispose()
            Write-Output "$name saved to GitHub Actions Secrets."
        }
    } finally { $values.Clear() }
}
